import fs from "node:fs/promises";
import path from "node:path";
import { RunEventSchema, type RunEvent } from "../contracts/event";
import type { EventId, RunId } from "../contracts/ids";
import type { RunState } from "../contracts/run";
import { createInitialState, reduceEvent } from "../core/reducer";
import { resolveEventsPath, resolveRunDir } from "./paths";

export class CorruptEventLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptEventLogError";
  }
}

export class EventSequenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventSequenceConflictError";
  }
}

export interface EventStore {
  append(event: RunEvent, expectedSequence: number): Promise<void>;
  read(runId: RunId): Promise<readonly RunEvent[]>;
}

export class FileEventStore implements EventStore {
  private readonly projectDir: string;
  private readonly fileQueues = new Map<string, Promise<void>>();

  constructor(options: { readonly projectDir: string }) {
    this.projectDir = options.projectDir;
  }

  private async lockQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.fileQueues.get(key) ?? Promise.resolve();
    let resolveLock!: () => void;
    const next = new Promise<void>((res) => {
      resolveLock = res;
    });
    this.fileQueues.set(key, next);

    try {
      await prev;
      return await fn();
    } finally {
      resolveLock();
      if (this.fileQueues.get(key) === next) {
        this.fileQueues.delete(key);
      }
    }
  }

  async append(event: RunEvent, expectedSequence: number): Promise<void> {
    const validatedEvent = RunEventSchema.parse(event);
    if (validatedEvent.sequence !== expectedSequence + 1) {
      throw new EventSequenceConflictError(
        `Expected sequence ${expectedSequence + 1} for append, but event has sequence ${validatedEvent.sequence}`
      );
    }

    const eventsPath = resolveEventsPath(this.projectDir, validatedEvent.runId);
    const runDir = resolveRunDir(this.projectDir, validatedEvent.runId);

    await this.lockQueue(eventsPath, async () => {
      await fs.mkdir(runDir, { recursive: true });

      let currentSequence = -1;
      const seenEventIds = new Set<EventId>();

      try {
        const content = await fs.readFile(eventsPath, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim().length > 0);
        for (const line of lines) {
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(line);
          } catch {
            throw new CorruptEventLogError(`Malformed JSON line in event log: ${line}`);
          }
          const parsedEvent = RunEventSchema.parse(parsedJson);
          if (seenEventIds.has(parsedEvent.eventId)) {
            throw new CorruptEventLogError(`Duplicate eventId in log: ${parsedEvent.eventId}`);
          }
          seenEventIds.add(parsedEvent.eventId);
          currentSequence = parsedEvent.sequence;
        }
      } catch (err: any) {
        if (err.code !== "ENOENT") {
          throw err;
        }
      }

      if (currentSequence !== expectedSequence) {
        throw new EventSequenceConflictError(
          `Sequence conflict on append: expected current sequence ${expectedSequence}, but log is at ${currentSequence}`
        );
      }

      if (seenEventIds.has(validatedEvent.eventId)) {
        throw new EventSequenceConflictError(
          `Duplicate eventId conflict: eventId '${validatedEvent.eventId}' already exists in log`
        );
      }

      const line = JSON.stringify(validatedEvent) + "\n";
      const fileHandle = await fs.open(eventsPath, "a");
      try {
        await fileHandle.writeFile(line, "utf-8");
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }
    });
  }

  async read(runId: RunId): Promise<readonly RunEvent[]> {
    const eventsPath = resolveEventsPath(this.projectDir, runId);
    let content: string;
    try {
      content = await fs.readFile(eventsPath, "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return [];
      }
      throw err;
    }

    const lines = content.split("\n");
    const events: RunEvent[] = [];
    const seenEventIds = new Set<EventId>();
    let expectedSeq = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Trailing empty lines at end of file are ignored
      if (line.trim().length === 0) {
        if (i === lines.length - 1) continue;
        throw new CorruptEventLogError(`Empty line found inside event log at line ${i + 1}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new CorruptEventLogError(`Malformed JSON line at line ${i + 1}: ${line}`);
      }

      let event: RunEvent;
      try {
        event = RunEventSchema.parse(parsed);
      } catch (err: any) {
        throw new CorruptEventLogError(`Invalid event schema at line ${i + 1}: ${err.message}`);
      }

      if (seenEventIds.has(event.eventId)) {
        throw new CorruptEventLogError(`Duplicate eventId found in event log: ${event.eventId}`);
      }
      seenEventIds.add(event.eventId);

      if (event.sequence !== expectedSeq) {
        throw new CorruptEventLogError(
          `Corrupt event log sequence: expected sequence ${expectedSeq}, found ${event.sequence}`
        );
      }
      expectedSeq++;
      events.push(event);
    }

    return events;
  }
}

export function replayRun(events: readonly RunEvent[]): RunState {
  if (events.length === 0) {
    throw new Error("Cannot replay empty event list");
  }

  const first = events[0]!;
  if (first.type !== "run.created") {
    throw new Error(`Initial event in log must be 'run.created', got '${first.type}'`);
  }

  let state = createInitialState({
    runId: first.runId,
    startedAt: first.payload.startedAt,
  });

  for (let i = 1; i < events.length; i++) {
    state = reduceEvent(state, events[i]!);
  }

  return state;
}
