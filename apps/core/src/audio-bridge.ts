/**
 * The Audio Bridge — §3.2, §4, ADR-007, ADR-008. Scheduled for week 2 and never
 * built; found missing in module 4.0 when the reply half needed it.
 *
 * §3.2 gives it "gate enforcement, clear, mark accounting, pacing, DTMF
 * injection, jitter policy". This file is the part the reply half cannot run
 * without — pacing, the gate, DTMF — and the reason it cannot is written in §4:
 *
 *   "A 200 ms queue only works if the sender is paced." AssemblyAI emits
 *   reply.audio faster than real time; an unpaced sender overflows the far
 *   end's 200 ms playout queue within a fraction of a second, the queue drops
 *   its OLDEST frames (§10.3), and the far end hears only the tail of every
 *   reply. So the bridge paces to the 20 ms frame cadence and holds the burst
 *   on the core side.
 *
 * And the consequence §4 says is easy to miss: holding the burst here moves
 * ADR-007's "seconds of speech already queued when the gate closes" into THIS
 * buffer. A `clear` that empties only the far-end queue would leave those
 * seconds to be sent the moment the gate reopens. So:
 *
 *   1. NARROWING THE GATE FLUSHES THIS BUFFER FIRST, then tells the transport,
 *      which sends `clear` to the far end. Flush-then-delegate, so no frame can
 *      be paced out between the gate narrowing and the buffer emptying.
 *   2. AUDIO THAT ARRIVES WHILE THE GATE FORBIDS IT IS DROPPED ON ARRIVAL, not
 *      buffered. The model keeps generating while it is muted; buffering that
 *      would play it the instant the gate reopened — ADR-007's hazard, rebuilt
 *      one layer up.
 *
 * The rule for what a narrowing drops is `gateAdmits` itself: every queued
 * frame the new gate does not admit. `closed` drops everything; `dtmf_only`
 * drops agent speech and keeps tones, which is exactly what navigating a menu
 * needs. One rule, the same one the transport enforces, so the two layers
 * cannot disagree about what a gate means.
 */

import { BYTES_PER_FRAME, FRAME_MS, MULAW_SILENCE, dtmf } from '@holdharmless/audio';
import type { GateIntent } from '@holdharmless/events';
import type { GateTarget } from '@holdharmless/callmodel';
import { gateAdmits, type AudioSource, type CallTransport } from '@holdharmless/transport';

export type BridgeScheduler = {
  every(fn: () => void, ms: number): () => void;
};

const realScheduler: BridgeScheduler = {
  every(fn, ms) {
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  },
};

export type AudioBridgeOptions = {
  transport: CallTransport;
  /** Injected in tests; `performance.now()` otherwise. */
  now?: () => number;
  scheduler?: BridgeScheduler;
};

export type BridgeCounts = {
  /** Frames handed to the transport and accepted by it. */
  sent: number;
  /** Frames dropped on arrival because the gate forbade their source. */
  droppedOnArrival: number;
  /** Frames already queued and then flushed by a narrowing or an interruption. */
  flushed: number;
};

export interface AudioBridge extends GateTarget {
  /** μ-law bytes from the agent, in whatever chunks the session delivers them. */
  pushAgentAudio(bytes: Uint8Array): void;
  /**
   * The reply is complete: pad and queue the partial frame left over, so the
   * last syllable is not held back waiting for bytes that are never coming.
   */
  finishReply(): void;
  /**
   * The far end started speaking, or the server interrupted the reply (§3's
   * second and third `clear` triggers). Drops every queued agent frame and
   * clears the far end's queue.
   */
  interrupt(): Promise<void>;
  /** Tones, paced like speech. Resolves once the last frame has left or been flushed. */
  sendDtmf(digits: string): Promise<void>;
  /** Frames still queued here, by source — half of INV-3's "zero unplayed frames". */
  pending(source?: AudioSource): number;
  readonly counts: Readonly<BridgeCounts>;
  stop(): void;
}

type Queued = { frame: Uint8Array; source: AudioSource; onGone?: () => void };

export function createAudioBridge(options: AudioBridgeOptions): AudioBridge {
  const transport = options.transport;
  const now = options.now ?? (() => performance.now());
  const scheduler = options.scheduler ?? realScheduler;

  let gate: GateIntent = transport.gate();
  let queue: Queued[] = [];
  let partial = new Uint8Array(0);
  let cancelTimer: (() => void) | null = null;
  /** When the next frame may leave. Continuous across idle moments; see `tick`. */
  let nextDueAt = Number.NEGATIVE_INFINITY;
  const counts: BridgeCounts = { sent: 0, droppedOnArrival: 0, flushed: 0 };

  const release = (q: Queued) => q.onGone?.();

  const halt = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  const sendNext = () => {
    const q = queue.shift();
    if (!q) return;
    // The transport is layer 1 and enforces the gate again. A frame it refuses
    // here was admitted when queued and forbidden since — which a narrowing
    // should already have flushed, so a refusal is counted, not hidden.
    if (transport.sendAudio(q.frame, q.source)) counts.sent++;
    else counts.flushed++;
    release(q);
  };

  /**
   * THE SCHEDULE IS CONTINUOUS. `nextDueAt` is the moment the next frame may
   * leave, and it advances by exactly one frame per frame sent.
   *
   * The first version kept a start time and a count, and reset both whenever
   * the queue ran empty. Audio arrives from the session one frame at a time, so
   * the queue ran empty after every frame, the pacer "restarted", and every
   * frame went out the instant it arrived — no pacing at all, which is the
   * overflow §4 describes. The test that pushes a one-second burst caught it:
   * fifty frames sent where one was due.
   *
   * Paced by the ELAPSED clock, as the harness's Pacer is (§4.5): a timer that
   * fires late sends every frame that has come due, so a stall delays audio
   * rather than stretching it. And after an idle stretch the schedule restarts
   * from NOW rather than from the stale due time, so silence is never "caught
   * up" as a burst.
   */
  const tick = () => {
    while (queue.length > 0 && now() >= nextDueAt) {
      sendNext();
      nextDueAt += FRAME_MS;
    }
    if (queue.length === 0) halt();
  };

  const ensureRunning = () => {
    if (queue.length === 0) return;
    if (cancelTimer === null && nextDueAt < now()) nextDueAt = now();
    tick();
    if (queue.length > 0 && cancelTimer === null) cancelTimer = scheduler.every(tick, FRAME_MS / 2);
  };

  const enqueue = (frame: Uint8Array, source: AudioSource, onGone?: () => void) => {
    if (!gateAdmits(gate, source)) {
      // Rule 2 in the header: never buffer what the gate forbids right now.
      counts.droppedOnArrival++;
      onGone?.();
      return;
    }
    queue.push({ frame, source, ...(onGone ? { onGone } : {}) });
    ensureRunning();
  };

  const dropWhere = (drop: (q: Queued) => boolean) => {
    const kept: Queued[] = [];
    for (const q of queue) {
      if (drop(q)) {
        counts.flushed++;
        release(q);
      } else kept.push(q);
    }
    queue = kept;
    if (queue.length === 0) halt();
  };

  return {
    applyGate(intent: GateIntent): void {
      // Rule 1: flush what the new gate forbids, THEN delegate. The transport
      // sends `clear` on a narrowing (CallTransport's contract), so after this
      // call neither end holds an agent frame the gate does not admit.
      dropWhere((q) => !gateAdmits(intent, q.source));
      if (!gateAdmits(intent, 'agent')) partial = new Uint8Array(0);
      gate = intent;
      transport.applyGate(intent);
    },

    pushAgentAudio(bytes: Uint8Array): void {
      if (!gateAdmits(gate, 'agent')) {
        // Counted in frames, the unit everything else here is counted in.
        counts.droppedOnArrival += Math.floor((partial.length + bytes.length) / BYTES_PER_FRAME);
        partial = new Uint8Array(0);
        return;
      }
      const joined = new Uint8Array(partial.length + bytes.length);
      joined.set(partial);
      joined.set(bytes, partial.length);
      let off = 0;
      while (joined.length - off >= BYTES_PER_FRAME) {
        enqueue(joined.slice(off, off + BYTES_PER_FRAME), 'agent');
        off += BYTES_PER_FRAME;
      }
      partial = joined.slice(off);
    },

    finishReply(): void {
      if (partial.length === 0) return;
      const frame = new Uint8Array(BYTES_PER_FRAME).fill(MULAW_SILENCE);
      frame.set(partial);
      partial = new Uint8Array(0);
      enqueue(frame, 'agent');
    },

    async interrupt(): Promise<void> {
      dropWhere((q) => q.source === 'agent');
      partial = new Uint8Array(0);
      await transport.clear();
    },

    sendDtmf(digits: string): Promise<void> {
      const frames = dtmf.generate(digits);
      if (frames.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        let left = frames.length;
        const gone = () => {
          left--;
          if (left === 0) resolve();
        };
        for (const f of frames) enqueue(f, 'dtmf', gone);
      });
    },

    pending(source?: AudioSource): number {
      return source === undefined ? queue.length : queue.filter((q) => q.source === source).length;
    },

    get counts() {
      return counts;
    },

    stop(): void {
      dropWhere(() => true);
      partial = new Uint8Array(0);
    },
  };
}
