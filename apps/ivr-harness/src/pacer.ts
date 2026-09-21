/**
 * Plays frames toward the core at the frame cadence — one 20 ms frame per 20 ms.
 *
 * The far-end session's sendAudio() puts a frame on the wire immediately; a
 * speaker does not. Without pacing, a 10-second menu would arrive in a few
 * milliseconds and every timing the core measures against it (§4.2, A-5) would
 * be fiction.
 *
 * Paced by the elapsed clock, not by counting ticks: a timer that fires late
 * sends the frames that are due, so a stall delays audio instead of stretching
 * it. On Windows this depends on the raised timer resolution (§4.5).
 */

import { FRAME_MS } from '@holdharmless/audio';

export class Pacer {
  private queue: Uint8Array[] = [];
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private sent = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly send: (frame: Uint8Array) => void) {}

  /** Appends frames; resolves when the last of them has been sent. */
  play(frames: readonly Uint8Array[]): Promise<void> {
    this.queue.push(...frames);
    this.ensureRunning();
    return new Promise((resolve) => {
      if (this.queue.length === 0 && this.timer === null) resolve();
      else this.waiters.push(resolve);
    });
  }

  /** Discards everything not yet sent — a representative who stops talking. */
  stop(): void {
    this.queue = [];
    this.halt();
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  private ensureRunning(): void {
    if (this.timer !== null || this.queue.length === 0) return;
    this.startedAt = performance.now();
    this.sent = 0;
    this.send(this.queue.shift()!);
    this.sent = 1;
    this.timer = setInterval(() => this.tick(), FRAME_MS / 2);
  }

  private tick(): void {
    const due = Math.floor((performance.now() - this.startedAt) / FRAME_MS) + 1;
    while (this.sent < due && this.queue.length > 0) {
      this.send(this.queue.shift()!);
      this.sent++;
    }
    if (this.queue.length === 0) this.halt();
  }

  private halt(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}
