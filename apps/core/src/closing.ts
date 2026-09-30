/**
 * The end of a call — module 4.0, reply half, step 5.
 *
 * Three things, each specified and none wired until now:
 *
 *   1. THE CLOSING DETECTOR (§7.6). A turn is closing when the reply that
 *      produced it was generated under a prompt whose [[CLOSING]] marker had
 *      been reached. §7.6 says the marker is "tracked by marker position" and
 *      stops there: a marker is stripped before the prompt is sent (§7.4), so
 *      the model cannot say it reached one. What it CAN be seen to do is the
 *      step each marker introduces. Both closing prompts put [[RECORD_OUTCOME]]
 *      before "call record_outcome" and [[CLOSING]] after it, so:
 *
 *        [[RECORD_OUTCOME]] is reached when the model CALLS record_outcome;
 *        [[CLOSING]]        is reached when the reply that carried an ACCEPTED
 *                           record_outcome ends — the model has its result and
 *                           everything it says next is past the marker.
 *
 *      The reply is classified when it STARTS, because that is when it began to
 *      be generated. The reply carrying the tool call started before the marker,
 *      so whatever it said around the call is not closing; the one after it is.
 *
 *      The blind spot, stated: a model that says goodbye in the same reply as
 *      its record_outcome call, or without ever calling it, produces no turn
 *      this marks as closing — so INV-20 cannot see that goodbye. Marker order
 *      in the prompts (check #5) is the half of the guarantee that covers it.
 *
 *   2. DONE, THEN THE HANGUP (§5.4, ADR-015). DONE is produced by the closing
 *      reply's reply.done together with outcomeWritten — the phase machine's
 *      latch. The hangup waits for the goodbye to be HEARD: first for the Audio
 *      Bridge to drain (the model emits audio faster than real time, so seconds
 *      of it are queued when reply.done arrives), then for a mark to come back
 *      from the far end, bounded. Hanging up on reply.done would cut the
 *      closing off mid-word — the social signal the whole order exists for.
 *
 *   3. THE OUTCOME WHEN THE LINE CLOSES WITHOUT ONE (INV-18, INV-19). The
 *      Work Queue's `resolveOnClose`, with the escalation evidence read from
 *      the log. A close that was not our own hangup is also a `call.dropped`,
 *      and a request that reached a final status gets `call.ended`.
 */

import { createClosingTracker, type ClosingTracker } from '@holdharmless/detectors';
import { realTimers, type ChannelTimers } from '@holdharmless/callmodel';
import type { AuthRequest, DropCause, Outcome, Producer } from '@holdharmless/events';
import type { CallTransport } from '@holdharmless/transport';
import type { AudioBridge } from './audio-bridge.js';
import type { CallLoop } from './call.js';
import { escalationEvidencedIn, urgencyOf } from './escalation.js';
import type { EventLog } from './log.js';
import type { WorkQueue } from './work-queue.js';

/** The transport cause our own hangup is recorded with. */
export const AGENT_HANGUP = 'agent_hangup';
/** How often the drain is checked, and how long it may take at most. */
export const DRAIN_POLL_MS = 100;
export const DRAIN_LIMIT_MS = 15_000;
/** How long to wait for the far end to confirm the goodbye was played. */
export const PLAYOUT_MARK_TIMEOUT_MS = 2_000;
const CLOSING_MARK = 'closing-played';

export type ClosingDeps = {
  loop: CallLoop;
  bridge: AudioBridge;
  transport: CallTransport;
  log: EventLog;
  request: AuthRequest;
  queue: WorkQueue;
  /** The marker order of the prompt for the CURRENT position. */
  markersAt: () => readonly string[];
  /** session.end — never a bare close (§15). */
  endSession: () => Promise<void>;
  /** Everything else the call runs is stopped here. */
  onFinished: () => void;
  timers?: ChannelTimers;
  /** Where the close is handled; after the controller's handler, not inside it. */
  defer?: (fn: () => void) => void;
};

export type CallEnd = { dropped: DropCause | null; outcome: Outcome | null };

export interface ClosingSequence {
  /** For the session: was the reply now being generated started past [[CLOSING]]? */
  isClosing(): boolean;
  onReplyStarted(): void;
  onReplyDone(status: 'completed' | 'interrupted'): void;
  /** Resolves once the line is closed and everything about it is written. */
  readonly finished: Promise<CallEnd>;
  stop(): void;
}

const FINAL_OUTCOMES: readonly Outcome['status'][] = ['approved', 'denied', 'pending_info', 'escalated', 'failed'];

/** What a close that was not our own hangup is recorded as (§9.3 DropCause). */
export function dropCauseOf(producer: Producer): DropCause {
  if (producer.kind === 'timer') return producer.name.includes('REPROMPT') || producer.name.includes('UNRESPONSIVE') ? 'unresponsive' : 'timeout';
  if (producer.kind === 'transport') {
    if (producer.cause === 'far_end_hangup' || producer.cause === 'timeout') return producer.cause;
    return 'link_drop'; // link_drop, a refused link, anything the transport could not name
  }
  return 'link_drop';
}

export function createClosingSequence(deps: ClosingDeps): ClosingSequence {
  const { loop, log, request } = deps;
  const timers = deps.timers ?? realTimers;
  const defer = deps.defer ?? queueMicrotask;

  let tracker: ClosingTracker | null = null;
  /**
   * An accepted record_outcome in the reply now running. Not matched by
   * toolCallId: record_outcome is allowed only in CLOSING (§5.6), so a
   * tool.returned for it can only be the one this position called.
   */
  let recordAccepted = false;
  let replyIsClosing = false;
  let hangingUp = false;
  let closed = false;
  let stopped = false;
  const cancels: (() => void)[] = [];

  let resolveFinished!: (end: CallEnd) => void;
  const finished = new Promise<CallEnd>((r) => (resolveFinished = r));

  const note = (marker: string): void => {
    if (!tracker) return;
    try {
      tracker.noteMarkerReached(marker);
    } catch {
      // A marker this prompt does not have, or one reached out of order: the
      // tracker refuses it, and the closing detector keeps its last state.
      // Either would mean the session believes it runs a prompt other than the
      // loaded one; refusing keeps isClosing from being set on a guess.
    }
  };

  const hangup = (): void => {
    if (hangingUp || closed || stopped) return;
    hangingUp = true;
    let waited = 0;
    const whenDrained = (): void => {
      if (stopped || closed) return;
      const queued = deps.bridge.pending('agent') + deps.bridge.pending('dtmf');
      if (queued > 0 && waited < DRAIN_LIMIT_MS) {
        waited += DRAIN_POLL_MS;
        cancels.push(timers.after(DRAIN_POLL_MS, whenDrained));
        return;
      }
      // The bridge is empty; the far end may still be playing. Ask it to say
      // when it has, and do not wait for ever if it never does.
      let done = false;
      const hangUpNow = (): void => {
        if (done || stopped || closed) return;
        done = true;
        void deps.transport.hangup();
        // The loopback transport does not report its own hangup as a close,
        // and a carrier might not either: the channel is closed here.
        loop.channels.transportClosed(AGENT_HANGUP);
      };
      deps.transport.onMark((name) => {
        if (name === CLOSING_MARK) hangUpNow();
      });
      void deps.transport.mark(CLOSING_MARK);
      cancels.push(timers.after(PLAYOUT_MARK_TIMEOUT_MS, hangUpNow));
    };
    whenDrained();
  };

  // Runs once: §5.3 has no row out of CLOSED, so channel.changed → CLOSED
  // happens at most once per call.
  const finish = (producer: Producer): void => {
    closed = true;
    for (const c of cancels.splice(0)) c();
    const ours = producer.kind === 'transport' && producer.cause === AGENT_HANGUP;
    // A close by timer — a hold or a transfer nobody ended — leaves the line
    // open at the far end. It is hung up here; the loop has already moved on.
    if (!ours && producer.kind !== 'transport') void deps.transport.hangup();

    // INV-18/19: the Call Model writes only when the call wrote nothing.
    if (!loop.phase.state.outcomeWritten) {
      deps.queue.resolveOnClose(request.id, {
        escalationEvidenced: escalationEvidencedIn(log.events(), urgencyOf(request)),
      });
    }
    const dropped = ours ? null : dropCauseOf(producer);
    if (dropped) log.append({ t: 'call.dropped', cause: dropped });

    const status = deps.queue.get(request.id)?.status ?? request.status;
    let outcome: Outcome | null = null;
    if ((FINAL_OUTCOMES as readonly string[]).includes(status)) {
      const captured = loop.phase.state.capturedAuthNumber;
      outcome = {
        status: status as Outcome['status'],
        ...(status === 'approved' && captured !== undefined ? { authNumber: captured } : {}),
        ...(request.lastReference !== undefined ? { reference: request.lastReference } : {}),
      };
      log.append({ t: 'call.ended', outcome });
    }

    void deps
      .endSession()
      .catch(() => undefined)
      .finally(() => {
        deps.onFinished();
        resolveFinished({ dropped, outcome });
      });
  };

  const unsubscribe = log.subscribe((e) => {
    if (stopped) return;
    switch (e.t) {
      case 'phase.changed':
        if (e.to === 'CLOSING') {
          // The markers of the closing prompt for THIS position, known now —
          // not when the configurator gets the prompt to the session, which may
          // be after the model has already called record_outcome.
          // Once per call: §5.4 has no row out of CLOSING but DONE.
          tracker = createClosingTracker(deps.markersAt());
        }
        if (e.to === 'DONE' && loop.gate.channel !== 'CLOSED') hangup();
        return;
      case 'tool.called':
        if (e.name === 'record_outcome' && loop.phase.state.phase === 'CLOSING') {
          note('RECORD_OUTCOME');
        }
        return;
      case 'tool.returned':
        if (e.name === 'record_outcome') recordAccepted = true;
        return;
      case 'channel.changed':
        if (e.to === 'CLOSED') {
          const producer = e.producer;
          // After the controller's handler has finished: the phase follow-up
          // (CLOSED → DONE) belongs next to the channel change in the log.
          defer(() => finish(producer));
        }
        return;
      default:
        return;
    }
  });

  return {
    isClosing: () => replyIsClosing,
    onReplyStarted(): void {
      replyIsClosing = tracker?.isClosing() ?? false;
    },
    onReplyDone(status): void {
      if (stopped) return;
      if (recordAccepted) {
        // The reply that carried the accepted record_outcome has ended.
        recordAccepted = false;
        note('CLOSING');
      }
      if (replyIsClosing) loop.phase.onClosingTurnComplete(status);
    },
    finished,
    stop(): void {
      stopped = true;
      unsubscribe();
      for (const c of cancels.splice(0)) c();
    },
  };
}
