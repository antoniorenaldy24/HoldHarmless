/**
 * Replays a Fixture through a pipeline, with no wall-clock time passing —
 * ADR-021. A 25-minute call replays in milliseconds.
 *
 * TWO TIMER MODES, because "replay" means two different things:
 *
 *  - 'recorded' (the default): reproduce the live run. A pipeline timer fires
 *    exactly where the timeline says it fired live, and nowhere else. This is
 *    what makes "replay reproduces the identical event sequence" (§21 1.9) true
 *    even when the live event loop stalled. The first version of this player
 *    recomputed timer times from the timeline instead, and failed about 1 run
 *    in 80: a message recorded after a timer was due had still been handled
 *    before it, live. If the pipeline under replay arms or cancels timers
 *    differently from the live run, that is reported as a divergence rather
 *    than papered over.
 *
 *  - 'virtual': ask what a CHANGED pipeline would do. Timers fire at arm time +
 *    delay on a virtual clock, and recorded firings are ignored. At equal time
 *    a timeline item runs before a timer, and timers run in the order armed —
 *    an arbitrary rule, but having one is what makes this mode deterministic.
 *    Pending timers run out before end(), as the call's own end would allow.
 *
 * This file imports nothing that can open a connection. That is the "zero API
 * calls" of §21 1.9, and a test holds it to that.
 *
 * On the §12.8 FixturePlayer interface: it takes the two classifiers and the
 * call model as sinks. None of those exist before week 2, so the player takes a
 * PipelineFactory instead — the classifiers and call model will be one pipeline.
 */

import type { CallEvent } from '@holdharmless/events';
import type { Fixture } from './format.js';
import { eventNumberer, type PipelineFactory } from './pipeline.js';

type Timer = { id: number; at: number; fn: () => void; cancelled: boolean; fired: boolean };

export type PlayOptions = {
  timers?: 'recorded' | 'virtual';
  /** Replays with the recorded call id unless another is given. */
  callId?: string;
  /** 'virtual' only: guards against a pipeline that re-arms a timer forever. */
  maxTimerFirings?: number;
};

export class ReplayDivergence extends Error {}

export function play(fixture: Fixture, pipeline: PipelineFactory, options: PlayOptions = {}): CallEvent[] {
  const mode = options.timers ?? 'recorded';
  const callId = options.callId ?? fixture.events[0]?.callId ?? fixture.id;
  const maxFirings = options.maxTimerFirings ?? 100_000;

  let now = 0;
  const timers: Timer[] = [];

  const numberer = eventNumberer(callId, Date.parse(fixture.recordedAt), () => now);
  const p = pipeline({
    nowMs: () => now,
    schedule: (fn, ms) => {
      const t: Timer = { id: timers.length, at: now + Math.max(0, ms), fn, cancelled: false, fired: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    },
    emit: numberer.emit,
  });

  const fire = (t: Timer) => {
    t.fired = true;
    t.fn();
  };

  let firings = 0;
  const runVirtualTimers = (limit: number, inclusive: boolean) => {
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && !t.fired && (inclusive ? t.at <= limit : t.at < limit));
      if (due.length === 0) return;
      due.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = due[0]!;
      now = Math.max(now, next.at);
      if (++firings > maxFirings) throw new Error(`more than ${maxFirings} timer firings: a pipeline timer re-arms itself forever`);
      fire(next);
    }
  };

  let last = 0;
  for (const item of fixture.timeline) {
    if (item.atMs < last) throw new Error(`timeline goes backwards at ${item.atMs} ms (after ${last} ms)`);
    last = item.atMs;

    if (item.kind === 'timer') {
      if (mode === 'virtual') continue;
      now = item.atMs;
      const t = timers[item.id];
      if (!t) throw new ReplayDivergence(`at ${item.atMs} ms timer #${item.id} fired live, but the replayed pipeline armed only ${timers.length}`);
      if (t.cancelled) throw new ReplayDivergence(`at ${item.atMs} ms timer #${item.id} fired live, but the replayed pipeline had cancelled it`);
      if (t.fired) throw new ReplayDivergence(`timer #${item.id} is recorded as firing twice`);
      fire(t);
      continue;
    }

    if (mode === 'virtual') runVirtualTimers(item.atMs, false); // items first at equal time
    now = item.atMs;
    p.onItem(item);
  }

  if (mode === 'virtual') {
    runVirtualTimers(Number.POSITIVE_INFINITY, true);
    p.end?.();
    runVirtualTimers(Number.POSITIVE_INFINITY, true);
  } else {
    // Live, the recording ended here: end() ran, and any timer still armed
    // never fired (the recorder drops firings after finish).
    p.end?.();
  }
  return numberer.events;
}
