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

// Module-scoped process-wide lock queue for CAS per normalized file path
const processFileQueues = new Map<string, Promise<void>>();

async function lockPath<T>(resolvedPath: string, fn: () => Promise<T>): Promise<T> {
  const normalizedKey = path.normalize(path.resolve(resolvedPath));
  const prev = processFileQueues.get(normalizedKey) ?? Promise.resolve();
  let resolveLock!: () => void;
  const next = new Promise<void>((res) => {
    resolveLock = res;
  });
  processFileQueues.set(normalizedKey, next);

  try {
    await prev;
    return await fn();
  } finally {
    resolveLock();
    if (processFileQueues.get(normalizedKey) === next) {
      processFileQueues.delete(normalizedKey);
    }
  }
}

export function validateEventHistory(events: readonly RunEvent[]): void {
  if (events.length === 0) {
    throw new CorruptEventLogError("Cannot replay empty event list");
  }

  const first = events[0]!;
  if (first.type !== "run.created") {
    throw new CorruptEventLogError(
      `Initial event in log must be 'run.created', got '${first.type}'`
    );
  }

  const expectedRunId = first.runId;
  const eventsById = new Map<EventId, RunEvent>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;

    if (event.runId !== expectedRunId) {
      throw new CorruptEventLogError(
        `Cross-run event detected in log at sequence ${event.sequence}: expected runId '${expectedRunId}', got '${event.runId}'`
      );
    }

    if (event.sequence !== i) {
      throw new CorruptEventLogError(
        `Non-consecutive sequence at index ${i}: expected ${i}, got ${event.sequence}`
      );
    }

    if (eventsById.has(event.eventId)) {
      throw new CorruptEventLogError(
        `Duplicate eventId in event history: '${event.eventId}'`
      );
    }

    eventsById.set(event.eventId, event);

    if (event.type === "run.transitioned") {
      const cause = eventsById.get(event.payload.causedByEventId);
      if (!cause) {
        throw new CorruptEventLogError(
          `run.transitioned references nonexistent causedByEventId: '${event.payload.causedByEventId}'`
        );
      }
      if (cause.runId !== expectedRunId) {
        throw new CorruptEventLogError(
          `run.transitioned references cause from different runId: '${cause.runId}'`
        );
      }
      if (cause.type !== "step.succeeded") {
        throw new CorruptEventLogError(
          `run.transitioned causedByEventId must reference 'step.succeeded', got '${cause.type}'`
        );
      }
      if (cause.sequence >= event.sequence) {
        throw new CorruptEventLogError(
          `run.transitioned cause must appear earlier in log`
        );
      }
    }

    if (event.type === "run.blocked") {
      const cause = eventsById.get(event.payload.causedByEventId);
      if (!cause) {
        throw new CorruptEventLogError(
          `run.blocked references nonexistent causedByEventId: '${event.payload.causedByEventId}'`
        );
      }
      if (cause.runId !== expectedRunId) {
        throw new CorruptEventLogError(
          `run.blocked references cause from different runId: '${cause.runId}'`
        );
      }
      const allowedCauses = [
        "policy.decided",
        "step.failed",
        "step.blocked",
        "step.interrupted",
        "step.succeeded",
        "run.created",
        "quality.completed",
        "quality.started",
        "gate.started",
        "gate.completed",
      ];
      if (!allowedCauses.includes(cause.type)) {
        throw new CorruptEventLogError(
          `run.blocked causedByEventId must reference a valid blocking cause, got '${cause.type}'`
        );
      }
    }

    if (event.type === "run.cancelled") {
      const cause = eventsById.get(event.payload.causedByEventId);
      if (!cause) {
        throw new CorruptEventLogError(
          `run.cancelled references nonexistent causedByEventId: '${event.payload.causedByEventId}'`
        );
      }
      if (cause.runId !== expectedRunId) {
        throw new CorruptEventLogError(
          `run.cancelled references cause from different runId: '${cause.runId}'`
        );
      }
      const allowedCauses = ["step.cancelled", "policy.decided", "run.created"];
      if (!allowedCauses.includes(cause.type)) {
        throw new CorruptEventLogError(
          `run.cancelled causedByEventId must reference a valid cancellation cause, got '${cause.type}'`
        );
      }
    }

    if (event.type === "run.routed") {
      const cause = eventsById.get(event.payload.causedByEventId);
      if (!cause) {
        throw new CorruptEventLogError(
          `run.routed references nonexistent causedByEventId: '${event.payload.causedByEventId}'`
        );
      }
      if (cause.runId !== expectedRunId) {
        throw new CorruptEventLogError(
          `run.routed references cause from different runId: '${cause.runId}'`
        );
      }
      if (cause.type !== "quality.completed" && cause.type !== "repair.decided") {
        throw new CorruptEventLogError(
          `run.routed causedByEventId must reference 'quality.completed' or 'repair.decided', got '${cause.type}'`
        );
      }
      if (cause.sequence >= event.sequence) {
        throw new CorruptEventLogError(
          `run.routed cause must appear earlier in log`
        );
      }
      if (cause.type === "quality.completed") {
        const dec = cause.payload.decision;
        if (dec.kind === "advance") {
          if (dec.to !== event.payload.to) {
            throw new CorruptEventLogError(
              `run.routed destination '${event.payload.to}' does not match quality advance target '${dec.to}'`
            );
          }
        } else if (dec.kind === "repair") {
          if (dec.to !== event.payload.to) {
            throw new CorruptEventLogError(
              `run.routed destination '${event.payload.to}' does not match quality repair target '${dec.to}'`
            );
          }
        } else {
          throw new CorruptEventLogError(
            `run.routed cannot be caused by a quality.completed with 'block' decision`
          );
        }
      }
    }
  }
}

export class FileEventStore implements EventStore {
  private readonly projectDir: string;

  constructor(options: { readonly projectDir: string }) {
    this.projectDir = options.projectDir;
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

    await lockPath(eventsPath, async () => {
      await fs.mkdir(runDir, { recursive: true });

      const existingEvents: RunEvent[] = [];
      let content = "";
      try {
        content = await fs.readFile(eventsPath, "utf-8");
      } catch (err: any) {
        if (err.code !== "ENOENT") {
          throw err;
        }
      }

      if (content.length > 0) {
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (line.trim().length === 0) {
            if (i === lines.length - 1) continue; // Trailing newline allowed
            throw new CorruptEventLogError(`Interior blank line detected at line ${i + 1}`);
          }
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(line);
          } catch {
            throw new CorruptEventLogError(`Malformed JSON line at line ${i + 1}`);
          }
          const parsedEvent = RunEventSchema.parse(parsedJson);
          existingEvents.push(parsedEvent);
        }

        validateEventHistory(existingEvents);
      }

      const currentSequence =
        existingEvents.length > 0
          ? existingEvents[existingEvents.length - 1]!.sequence
          : -1;

      if (currentSequence !== expectedSequence) {
        throw new EventSequenceConflictError(
          `Sequence conflict on append: expected current sequence ${expectedSequence}, but log is at ${currentSequence}`
        );
      }

      const fullList = [...existingEvents, validatedEvent];
      validateEventHistory(fullList);

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

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
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

      events.push(event);
    }

    if (events.length > 0) {
      validateEventHistory(events);
    }

    return events;
  }
}

export function replayRun(events: readonly RunEvent[]): RunState {
  validateEventHistory(events);

  const first = events[0]!;
  if (first.type !== "run.created") {
    throw new CorruptEventLogError(
      `Initial event in log must be 'run.created', got '${first.type}'`
    );
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
