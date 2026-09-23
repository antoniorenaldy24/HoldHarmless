/**
 * Phase producers — §5.4, module 3.2.
 *
 * The phase dimension moves only through the producers in §5.4's table, and
 * this file is the only place that moves it. Everything else — the gate, the
 * channel, the classifier — is forbidden from touching it by construction,
 * which is what makes INV-13 ("a channel change never moves the phase") a
 * property of the code rather than a rule people remember.
 *
 * THREE THINGS THE TABLE SAYS THAT ARE EASY TO GET WRONG.
 *
 * 1. `record_outcome` is NOT in the table. Accepting it sets outcomeWritten and
 *    nothing else. If it also ended the call, the agent would be past the
 *    closing before it had spoken one — the race ADR-015 exists to kill.
 *
 * 2. `readbackAttempts` has exactly ONE writer: confirm_readback(matched:false).
 *    Not the re-prompt timer, not the phase timeout, not a retry elsewhere.
 *
 * 3. CLOSING → DONE needs TWO conditions — a completed closing turn and a
 *    written outcome — and they can become true in either order. The turn is
 *    latched, so an outcome written after the closing was spoken still produces
 *    DONE, and the producer recorded is the reply.done that spoke it (§5.4,
 *    §21 3.4: "DONE produced only by reply.done"). This is also how §5.7's
 *    CLOSING after-limit reaches DONE without a timer producing it: the limit's
 *    action writes the outcome deterministically, and the latch does the rest.
 */

import type { CallEventBody, ClosingKind, Outcome, Phase, Producer, ToolName } from '@holdharmless/events';
import { policyFor } from './policy.js';
import { positionId } from './positions.js';

export const READBACK_ATTEMPT_LIMIT = 3;

export type PhaseState = {
  phase: Phase;
  closingKind?: ClosingKind;
  capturedAuthNumber?: string;
  readbackAttempts: number;
  outcomeWritten: boolean;
  /** Accumulated HUMAN channel time, not wall clock: a long hold spends no budget (§5.4). */
  humanChannelMs: number;
};

export type PhaseOptions = {
  emit?: (event: CallEventBody) => void;
  /** Called when a phase change requires the §8.6 escalation summary. */
  onEscalation?: (cause: 'readback_limit' | 'phase_timeout' | 'tool') => void;
  initial?: Partial<PhaseState>;
};

export interface PhaseMachine {
  readonly state: Readonly<PhaseState>;
  /** A tool the handler has already authorized and validated (§8.7 order). */
  onToolAccepted(name: ToolName, args: Record<string, unknown>): void;
  /** The channel moved. Only two entries touch the phase, both atomically (§5.3). */
  onChannelChange(to: string): void;
  /** reply.done for a turn that carried the [[CLOSING]] marker (§7.6). */
  onClosingTurnComplete(status: 'completed' | 'interrupted'): void;
  /** Accumulated HUMAN time; the backstop for tool-driven transitions (§5.4). */
  addHumanTime(ms: number): void;
  reset(): void;
}

export function createPhaseMachine(options: PhaseOptions = {}): PhaseMachine {
  const emit = options.emit ?? (() => {});
  const escalated = options.onEscalation ?? (() => {});

  const fresh = (): PhaseState => ({
    phase: 'NOT_STARTED',
    readbackAttempts: 0,
    outcomeWritten: false,
    humanChannelMs: 0,
    ...options.initial,
  });

  let state = fresh();
  /** Set by a completed closing turn; half of CLOSING → DONE's condition. */
  let closingTurnComplete = false;

  const move = (to: Phase, producer: Producer, closingKind?: ClosingKind): void => {
    if (to === state.phase) return;
    const from = state.phase;
    state.phase = to;
    if (closingKind) state.closingKind = closingKind;
    emit({ t: 'phase.changed', from, to, producer, ...(closingKind ? { closingKind } : {}) });
    if (to === 'CLOSING') maybeFinishClosing(producer);
  };

  /** Fires DONE when both §5.4 conditions hold, whichever became true last. */
  const maybeFinishClosing = (_producer: Producer): void => {
    if (state.phase !== 'CLOSING' || !closingTurnComplete || !state.outcomeWritten) return;
    move('DONE', { kind: 'session', event: 'reply.done' });
  };

  return {
    get state() {
      return state;
    },

    onToolAccepted(name: ToolName, args: Record<string, unknown>): void {
      const producer: Producer = { kind: 'tool', seq: 0, name };
      switch (name) {
        case 'capture_auth_number': {
          state.capturedAuthNumber = String(args['value']);
          if (state.phase === 'EXCHANGE') move('READBACK', producer);
          return;
        }
        case 'confirm_readback': {
          if (state.phase !== 'READBACK') return;
          if (args['matched'] === true) {
            move('CLOSING', producer, 'wrapup');
            return;
          }
          // The one writer of readbackAttempts, and the only one (§5.4).
          state.readbackAttempts += 1;
          if (typeof args['corrected_value'] === 'string') state.capturedAuthNumber = args['corrected_value'];
          if (state.readbackAttempts >= READBACK_ATTEMPT_LIMIT) {
            escalated('readback_limit');
            move('CLOSING', producer, 'escalation');
            return;
          }
          move('EXCHANGE', producer);
          return;
        }
        case 'escalate_to_human': {
          escalated('tool');
          move('CLOSING', producer, 'escalation');
          return;
        }
        case 'record_outcome': {
          // Not a phase producer. It sets one flag, and that flag is half of
          // CLOSING → DONE's condition — which is why writing it late still
          // ends the call, without a timer ever producing DONE.
          state.outcomeWritten = true;
          maybeFinishClosing(producer);
          return;
        }
        default:
          return; // send_dtmf, get_auth_request, capture_reference, notify_transfer
      }
    },

    onChannelChange(to: string): void {
      // §5.3: phase is untouched by every row except these two, and both are
      // applied in the same handler as the channel change (settle()).
      if (to === 'HUMAN' && state.phase === 'NOT_STARTED') {
        move('EXCHANGE', { kind: 'transport', cause: 'channel_became_human' });
        return;
      }
      if (to === 'CLOSED' && state.phase !== 'DONE') {
        move('DONE', { kind: 'transport', cause: 'channel_became_closed' });
      }
    },

    onClosingTurnComplete(status: 'completed' | 'interrupted'): void {
      // An interrupted closing was not delivered: the far end cut in, and the
      // call is not finished (§5.4 requires status 'completed').
      if (status !== 'completed') return;
      closingTurnComplete = true;
      maybeFinishClosing({ kind: 'session', event: 'reply.done' });
    },

    addHumanTime(ms: number): void {
      state.humanChannelMs += ms;
      const limit = policyFor(positionId('HUMAN', state.phase))?.phaseTimeoutMs;
      if (limit === undefined || state.humanChannelMs < limit) return;
      // The backstop: if the model never calls capture_auth_number, the call
      // does not sit in EXCHANGE forever. Escalation, deterministically
      // summarized, not a silent close (§5.4).
      if (state.phase === 'EXCHANGE' || state.phase === 'READBACK') {
        escalated('phase_timeout');
        move('CLOSING', { kind: 'timer', name: `PHASE_TIMEOUT_${state.phase}_MS` }, 'escalation');
      }
    },

    reset(): void {
      state = fresh();
      closingTurnComplete = false;
    },
  };
}
