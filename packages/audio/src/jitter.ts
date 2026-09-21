/**
 * Inbound jitter buffer — §4.4.
 *
 * The policies here are stated as decisions rather than left to whatever the
 * implementation happens to do, so that a carrier implementation inherits a
 * decision rather than inventing one.
 *
 *   Underflow  -> return null. The caller sends comfort silence; it never blocks.
 *   Overflow   -> drop the OLDEST frame. Never grow unbounded.
 *   Malformed  -> drop, count, never throw. One bad frame must not end a
 *                 twenty-minute call.
 *   Out of order -> not reordered. The transport delivers in order.
 */

import { BYTES_PER_FRAME, FRAME_MS } from './mulaw.js';

export type JitterFaults = { overflow: number; underflow: number; malformed: number };

export interface JitterBuffer {
  push(frame: Uint8Array, atMs: number): void;
  /** null on underflow; never blocks (§4.4). */
  pull(): Uint8Array | null;
  depthMs(): number;
  faults(): JitterFaults;
}

export type JitterBufferOptions = {
  /** JITTER_MAX_MS, default 200 (§13). */
  maxMs?: number;
  /** Frames held before pull() starts returning them; 40-60 ms in §4.3. */
  targetMs?: number;
};

export function createJitterBuffer(options: JitterBufferOptions = {}): JitterBuffer {
  const maxMs = options.maxMs ?? 200;
  const targetMs = options.targetMs ?? 40;
  const maxFrames = Math.max(1, Math.round(maxMs / FRAME_MS));
  const targetFrames = Math.max(0, Math.round(targetMs / FRAME_MS));

  const queue: Uint8Array[] = [];
  const faults: JitterFaults = { overflow: 0, underflow: 0, malformed: 0 };
  let priming = true;

  return {
    push(frame: Uint8Array): void {
      // A truncated or oversized frame is malformed. Counting it and moving on
      // is the whole policy: the alternative is an exception thrown from an
      // audio callback twelve minutes into a call.
      if (!(frame instanceof Uint8Array) || frame.length !== BYTES_PER_FRAME) {
        faults.malformed++;
        return;
      }

      if (queue.length >= maxFrames) {
        queue.shift();
        faults.overflow++;
      }
      queue.push(frame);
    },

    pull(): Uint8Array | null {
      // Hold the target depth before the first pull, so the buffer has something
      // to absorb jitter with. After that, drain on demand.
      if (priming) {
        if (queue.length < targetFrames) {
          faults.underflow++;
          return null;
        }
        priming = false;
      }

      const frame = queue.shift();
      if (frame === undefined) {
        faults.underflow++;
        // Re-prime, or every subsequent gap would be a fresh underflow with no
        // chance for the buffer to refill.
        priming = true;
        return null;
      }
      return frame;
    },

    depthMs(): number {
      return queue.length * FRAME_MS;
    },

    faults(): JitterFaults {
      return { ...faults };
    },
  };
}
