/**
 * An in-order delay line that applies a NetworkProfile to a stream of items.
 *
 * One queue and one timer, not one timer per frame. Per-frame setTimeout calls
 * are not guaranteed to fire in scheduling order once their delays differ —
 * which, with jitter, they always do — and §4.4 states the transport delivers in
 * order. Draining a single FIFO whose deadlines are non-decreasing makes that a
 * property of the structure rather than of the timer implementation.
 */

import type { NetworkProfile } from './profile.js';

export type DelayLineOptions<T> = {
  profile: NetworkProfile;
  deliver: (item: T) => void;
  /** Injectable for deterministic tests. Must return [0, 1). */
  random?: () => number;
  now?: () => number;
};

export type DelayLineStats = { sent: number; delivered: number; lost: number; reordered: number };

export class DelayLine<T> {
  readonly #profile: NetworkProfile;
  readonly #deliver: (item: T) => void;
  readonly #random: () => number;
  readonly #now: () => number;

  #queue: { at: number; item: T }[] = [];
  #timer: NodeJS.Timeout | null = null;
  #lastAt = 0;
  #closed = false;
  readonly #stats: DelayLineStats = { sent: 0, delivered: 0, lost: 0, reordered: 0 };

  constructor(options: DelayLineOptions<T>) {
    this.#profile = options.profile;
    this.#deliver = options.deliver;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? (() => performance.now());
  }

  push(item: T): void {
    if (this.#closed) return;
    this.#stats.sent++;

    if (this.#profile.lossRate > 0 && this.#random() < this.#profile.lossRate) {
      this.#stats.lost++;
      return;
    }

    const jitter = (this.#random() * 2 - 1) * this.#profile.jitterMs;
    const raw = this.#now() + this.#profile.oneWayDelayMs + jitter;

    // Clamp to preserve order. With TELEPHONY's 8 ms jitter and 20 ms frame
    // spacing this never binds — consecutive deadlines differ by at least 4 ms —
    // so it does not bias the measured mean delay. It exists for DEGRADED.
    const at = Math.max(raw, this.#lastAt);
    this.#lastAt = at;

    const entry = { at, item };
    if (
      this.#profile.reorderRate > 0 &&
      this.#queue.length > 0 &&
      this.#random() < this.#profile.reorderRate
    ) {
      // Deliberate reordering, only when a profile asks for it. No preset does:
      // it exists so the §4.4 policy can be exercised on purpose.
      const prev = this.#queue.pop()!;
      entry.at = prev.at;
      prev.at = at;
      this.#queue.push(entry, prev);
      this.#stats.reordered++;
    } else {
      this.#queue.push(entry);
    }

    this.#arm();
  }

  #arm(): void {
    if (this.#timer !== null || this.#queue.length === 0 || this.#closed) return;
    const wait = Math.max(0, this.#queue[0]!.at - this.#now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#drain();
    }, wait);
  }

  #drain(): void {
    const now = this.#now();
    while (this.#queue.length > 0 && this.#queue[0]!.at <= now + 0.5) {
      const { item } = this.#queue.shift()!;
      this.#stats.delivered++;
      this.#deliver(item);
    }
    this.#arm();
  }

  /** Discards anything still in flight. */
  close(): void {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#queue = [];
  }

  inFlight(): number {
    return this.#queue.length;
  }

  stats(): DelayLineStats {
    return { ...this.#stats };
  }
}
