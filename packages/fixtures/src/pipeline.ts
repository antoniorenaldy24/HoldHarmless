/**
 * The seam that makes replay mean something.
 *
 * A Pipeline is the code under test: it consumes timeline items and emits
 * events. It sees the outside world only through PipelineIO — the clock, the
 * timer, and the event sink. Live, those are real; in replay they are virtual.
 * Because the pipeline cannot reach anything else, a replay can make no API
 * call, and two replays of one fixture cannot differ.
 */

import type { CallEvent, CallEventBody } from '@holdharmless/events';
import type { TimelineItem } from './format.js';

/** Returns a cancel function. Same shape as packages/agent's Scheduler. */
export type Scheduler = (fn: () => void, ms: number) => () => void;

export type PipelineIO = {
  /** Milliseconds since the start of the call. */
  nowMs(): number;
  schedule: Scheduler;
  emit(body: CallEventBody): void;
};

export interface Pipeline {
  onItem(item: TimelineItem): void;
  /** The call is over: emit anything still held. */
  end?(): void;
}

export type PipelineFactory = (io: PipelineIO) => Pipeline;

/**
 * Numbers events as JsonlEventLog does: seq from 1 per call, assigned here and
 * nowhere else (§3.3 rule 4).
 */
export function eventNumberer(callId: string, startMs: number, nowMs: () => number) {
  const events: CallEvent[] = [];
  return {
    events,
    emit(body: CallEventBody) {
      events.push({ seq: events.length + 1, callId, at: new Date(startMs + nowMs()).toISOString(), ...body } as CallEvent);
    },
  };
}

/**
 * The first point at which two event sequences differ, or null.
 * `at` is excluded: a live run is timed by the wall clock and a replay by the
 * timeline, and they agree to the timer's resolution, not to the millisecond.
 * Everything else — order, seq, type, every field — must be identical.
 */
export function firstDifference(a: readonly CallEvent[], b: readonly CallEvent[]): string | null {
  const strip = ({ at: _at, ...rest }: CallEvent) => JSON.stringify(rest);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ? strip(a[i]!) : '(none)';
    const y = b[i] ? strip(b[i]!) : '(none)';
    if (x !== y) return `event ${i + 1}: ${x} != ${y}`;
  }
  return null;
}
