/**
 * Append-only event log — ADR-012, §9.3, interface in §12.1.
 *
 * JSONL on local disk, one file per call. Sufficient for one active call (§1.6),
 * and the substrate several invariants check against.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CallEvent, CallEventBody } from './types.js';
import { isSynchronousEvent } from './types.js';

export interface EventLog {
  /** Assigns seq and at, writes the line, returns the assigned seq. */
  append(event: CallEventBody & { callId: string }): Promise<number>;
  read(callId: string): AsyncIterable<CallEvent>;
  readSync(callId: string): CallEvent[];
  subscribe(handler: (event: CallEvent) => void): () => void;
}

export type JsonlEventLogOptions = {
  /** Directory holding one <callId>.jsonl per call. */
  dir: string;
  /** Injectable for deterministic tests. */
  now?: () => Date;
};

export class JsonlEventLog implements EventLog {
  readonly #dir: string;
  readonly #now: () => Date;
  readonly #subscribers = new Set<(event: CallEvent) => void>();
  /**
   * seq is monotonic PER callId and assigned exclusively here (§3.3 rule 4),
   * including for harness events — the harness sends {metric, value, atMs} and
   * the core numbers it on receipt (§10.4).
   */
  readonly #seq = new Map<string, number>();

  constructor(options: JsonlEventLogOptions) {
    this.#dir = options.dir;
    this.#now = options.now ?? (() => new Date());
    fs.mkdirSync(this.#dir, { recursive: true });
  }

  fileFor(callId: string): string {
    return path.join(this.#dir, `${callId}.jsonl`);
  }

  async append(event: CallEventBody & { callId: string }): Promise<number> {
    const seq = (this.#seq.get(event.callId) ?? 0) + 1;
    this.#seq.set(event.callId, seq);

    const full = { seq, at: this.#now().toISOString(), ...event } as CallEvent;

    // Each line is written whole WITH its newline in one operation, so a crash
    // mid-write can only truncate the tail — never interleave two records.
    const line = JSON.stringify(full) + '\n';
    const file = this.fileFor(event.callId);

    if (isSynchronousEvent(full.t)) {
      // A state change that is not on disk when the process dies is a state
      // change the replay cannot see, and the log is the source of truth.
      const fd = fs.openSync(file, 'a');
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      await fs.promises.appendFile(file, line);
    }

    for (const handler of this.#subscribers) {
      try {
        handler(full);
      } catch {
        // A subscriber that throws must not break the writer. The dashboard is
        // a reader (§11); it has no standing to fail an append.
      }
    }

    return seq;
  }

  readSync(callId: string): CallEvent[] {
    const file = this.fileFor(callId);
    if (!fs.existsSync(file)) return [];
    return parseJsonl(fs.readFileSync(file, 'utf8'));
  }

  async *read(callId: string): AsyncIterable<CallEvent> {
    const file = this.fileFor(callId);
    if (!fs.existsSync(file)) return;
    const text = await fs.promises.readFile(file, 'utf8');
    for (const event of parseJsonl(text)) yield event;
  }

  subscribe(handler: (event: CallEvent) => void): () => void {
    this.#subscribers.add(handler);
    return () => this.#subscribers.delete(handler);
  }

  /** Test seam: resets in-memory seq counters without touching the files. */
  resetCounters(): void {
    this.#seq.clear();
  }
}

/**
 * Parses JSONL, discarding a trailing unparseable line.
 *
 * §9.3: "on replay a trailing unparseable line is discarded". Only the TRAILING
 * one — a broken line in the middle means something other than a crash during
 * the final write, and silently dropping it would hide corruption rather than
 * tolerate truncation. That case throws.
 */
export function parseJsonl(text: string): CallEvent[] {
  const lines = text.split('\n');
  // A well-formed file ends with a newline, so the final element is empty.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const out: CallEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as CallEvent);
    } catch (cause) {
      if (i === lines.length - 1) break; // truncated tail — expected after a crash
      throw new Error(`Corrupt event log: line ${i + 1} is unparseable and is not the final line`, {
        cause,
      });
    }
  }
  return out;
}
