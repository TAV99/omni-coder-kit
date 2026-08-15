import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { RunEventSchema, type RunEvent } from "../contracts/events";
import { reduce } from "../state/reducer";
import type { RunState } from "../contracts/run";

export class EventStorage {
  private readonly eventsFilePath: string;

  constructor(public readonly directory: string) {
    this.eventsFilePath = path.join(directory, "events.ndjson");
  }

  async append(event: RunEvent): Promise<void> {
    const validEvent = RunEventSchema.parse(event);
    const line = JSON.stringify(validEvent) + "\n";
    // We append to the file, creating the directory if it doesn't exist
    await fs.mkdir(this.directory, { recursive: true });
    await fs.appendFile(this.eventsFilePath, line, "utf8");
  }

  async replay(): Promise<RunState | null> {
    try {
      await fs.access(this.eventsFilePath);
    } catch {
      // File does not exist, so no state yet
      return null;
    }

    const fileStream = createReadStream(this.eventsFilePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let state: RunState | null = null;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      const event = RunEventSchema.parse(parsed);
      state = reduce(state, event);
    }

    return state;
  }
}
