/**
 * Silence recovery — §5.7, INV-5, A-22, module 3.7.
 *
 * §5.7's table has been in `POSITION_POLICY` since module 1.x and nothing read
 * it. This file is its reader, and the whole of its job is one sentence: when
 * the far end stops talking, every position ends where the table says, and none
 * of them ends by the call sitting there.
 *
 * FIVE THINGS THE TABLE SAYS THAT ARE EASY TO GET WRONG.
 *
 * 1. The counter does not run while hold is suspected (INV-5, §6.5, A-28). A
 *    representative who puts the agent on hold has not gone quiet; the line has.
 *    Counting that silence would hang up on a call that is progressing.
 *
 * 2. A re-prompt needs the gate to admit WHAT IT PRODUCES, not to be open
 *    (ADR-022 condition 1 as §5.7 refined it). IVR recovery produces DTMF and is
 *    allowed where the gate is `dtmf_only`; a spoken reply there is the hold
 *    probe's mistake in a different costume.
 *
 * 3. HUMAN/EXCHANGE has TWO timeouts. Before the party has been told what they
 *    are speaking to, the wait is shorter — a person who has heard nothing has
 *    less reason to stay on the line than one who is waiting for the next item.
 *
 * 4. The after-limit action fires EXACTLY at the limit (INV-5): not on the
 *    attempt that reaches it, and not one silence later. The counter is compared
 *    before the action, and the position is left immediately after.
 *
 * 5. HOLD and TRANSFER have no spoken action at all. HOLD ramps semantic
 *    sensitivity three times and then does nothing; TRANSFER does nothing from
 *    the start. Both were decided by the project owner (§5.7, 2026-09-23) and
 *    both come to the same thing: the agent is silent for the whole of every
 *    hold and every transfer, so it is never billed for audio nobody hears.
 *
 * WHAT THIS FILE DOES NOT DO. It does not move the phase or the channel itself.
 * READBACK's limit calls the phase machine, which owns that transition and
 * records a timer as its producer; the close is a channel change, which this
 * file asks its caller to make. A file that performed transitions as well as
 * deciding them would be a second producer for dimensions that have exactly one.
 */

import type { CallEventBody, Channel, DropCause, NavMode, Phase, ReplyProduct } from '@holdharmless/events';
import { POSITION_POLICY, positionId, type AfterLimit, type PhaseMachine, type PositionId } from '@holdharmless/callmodel';

export type RecoveryPosition = {
  channel: Channel;
  phase: Phase;
  navMode: NavMode;
  /** INV-5: the counters freeze while this is true. */
  holdSuspected: boolean;
  /** §5.7: HUMAN/EXCHANGE waits less before the party has been told. */
  disclosedToCurrentParty: boolean;
};

export type RecoveryDeps = {
  position: () => RecoveryPosition;
  emit: (event: CallEventBody) => void;
  /**
   * Ask for the recovery reply. Returns false when it did not happen — the
   * session refuses on ADR-022's conditions, and a refusal must not be counted
   * as a re-prompt, or the limit would be reached by replies nobody heard.
   */
  rePrompt: (produces: ReplyProduct, instruction: string) => boolean;
  /** HOLD's action: one step of semantic sensitivity, three times at most. */
  rampHoldSensitivity?: (step: number) => void;
  /** The channel's owner makes the transition; this file only decides it. */
  close: (cause: DropCause) => void;
  phase: PhaseMachine;
  /**
   * §5.7's CLOSING row: "the Call Model writes the outcome deterministically if
   * unwritten". Writing it is what lets the CLOSING → DONE latch finish the
   * call without a timer ever producing DONE (§5.4).
   */
  writeOutcomeIfUnwritten: () => void;
};

export interface SilenceRecovery {
  /** Advances the silence clock and acts if the position's timeout has passed. */
  tick(elapsedMs: number): void;
  /** The far end spoke: the silence clock resets, the re-prompt count does not. */
  noteActivity(): void;
  /** The position changed: both reset, because §5.7 counts per position. */
  noteMoved(): void;
  /** Re-prompts delivered at the current position, for `Call.rePromptCounts`. */
  counts(): Readonly<Record<string, number>>;
}

/**
 * §5.7's action column, as the instruction the recovery reply carries.
 *
 * IVR is keyed by CHANNEL, not by position: the menu is navigated from every
 * phase — §5.6 gives IVR a policy row at NOT_STARTED, EXCHANGE, READBACK and
 * CLOSING alike, because a call can be sent back to a menu at any point — and
 * "repeat navigation" is the same action in all of them.
 */
const IVR_INSTRUCTION = 'Press the same menu option again. Do not speak.';

const INSTRUCTION: Partial<Record<PositionId, string>> = {
  'HUMAN/EXCHANGE': 'The representative has gone quiet. Offer the next item briefly.',
  'HUMAN/READBACK': 'The representative has gone quiet. Read the authorization number back again and ask them to confirm it.',
  'HUMAN/CLOSING': 'Continue the closing sequence.',
};

/** Before the party has been told, the opening is what gets delivered again. */
const UNDISCLOSED_INSTRUCTION = 'Nobody has answered yet. Deliver the opening again: say you are an AI assistant calling on behalf of the clinic, and why.';

export const MAX_HOLD_RAMP_STEPS = 3;

export function createSilenceRecovery(deps: RecoveryDeps): SilenceRecovery {
  let silenceMs = 0;
  let at: PositionId | null = null;
  const rePrompts: Record<string, number> = {};
  let rampSteps = 0;
  /**
   * The after-limit action fires ONCE per position (INV-5, "exactly at the
   * limit"). Found by the table-driven test in A-22: without this, a position
   * that is still ticked after its limit closes the call again on every
   * timeout, and two `call.dropped` events for one call is a log that cannot be
   * read. The caller usually stops ticking a closed call, and "usually" is not
   * a guarantee this file may rely on.
   */
  let limitFired: PositionId | null = null;

  const timeoutFor = (id: PositionId, disclosed: boolean): number | undefined => {
    const policy = POSITION_POLICY[id];
    if (!policy) return undefined;
    if (id === 'HUMAN/EXCHANGE' && !disclosed) return policy.silenceTimeoutBeforeDisclosureMs ?? policy.silenceTimeoutMs;
    return policy.silenceTimeoutMs;
  };

  const afterLimit = (id: PositionId, action: AfterLimit): void => {
    deps.emit({ t: 'harness.telemetry', metric: 'silence_recovery_limit_reached', value: 1, detail: id });
    switch (action.kind) {
      case 'close':
        deps.close(action.cause);
        return;
      case 'phase':
        if (action.to === 'CLOSING') {
          deps.phase.onRecoveryLimit();
          return;
        }
        // DONE is never produced by this timer. The outcome is written, and
        // §5.4's latch produces DONE from the closing turn that already
        // completed — which is why a call cannot end reporting a result that
        // was never recorded.
        deps.writeOutcomeIfUnwritten();
        return;
      case 'await_timeout':
        // HOLD after three ramp steps, and TRANSFER always. The channel's own
        // timeout is the only exit, and it is not this file's to fire.
        return;
      default:
        return;
    }
  };

  return {
    tick(elapsedMs: number): void {
      const pos = deps.position();
      const id = positionId(pos.channel, pos.phase);
      if (id !== at) {
        at = id;
        silenceMs = 0;
        rampSteps = 0;
        limitFired = null;
      }

      // INV-5, first half. Frozen, not merely ignored: the clock does not
      // advance, so nothing accumulates to be acted on when hold clears.
      if (pos.holdSuspected) return;

      const policy = POSITION_POLICY[id];
      const timeout = timeoutFor(id, pos.disclosedToCurrentParty);
      if (!policy || timeout === undefined) return;

      silenceMs += elapsedMs;
      if (silenceMs < timeout) return;
      silenceMs = 0;

      // HOLD's action is not a reply at all: it raises the classifier's
      // sensitivity, three times, and then the agent waits out HOLD_TIMEOUT_MS
      // in silence (§6.7, ADR-007).
      if (pos.channel === 'HOLD') {
        if (rampSteps >= MAX_HOLD_RAMP_STEPS) return;
        rampSteps++;
        deps.rampHoldSensitivity?.(rampSteps);
        return;
      }

      const limit = policy.rePromptLimit;
      if (limit === undefined) return;

      // INV-5, second half: EXACTLY at the limit. The comparison happens before
      // the re-prompt, so the limit's action replaces the attempt that would
      // have exceeded it rather than following it.
      const delivered = rePrompts[id] ?? 0;
      if (delivered >= limit) {
        if (policy.afterLimit && limitFired !== id) {
          limitFired = id;
          afterLimit(id, policy.afterLimit);
        }
        return;
      }

      const produces: ReplyProduct = pos.channel === 'IVR' && pos.navMode === 'dtmf' ? 'dtmf' : 'speech';
      const instruction =
        pos.channel === 'IVR'
          ? IVR_INSTRUCTION
          : id === 'HUMAN/EXCHANGE' && !pos.disclosedToCurrentParty
            ? UNDISCLOSED_INSTRUCTION
            : INSTRUCTION[id] ?? 'The far end has gone quiet.';

      // A refusal is not a re-prompt. The session applies ADR-022's conditions
      // again at the point of sending, and counting a reply it refused would
      // spend the position's budget on silence.
      if (deps.rePrompt(produces, instruction)) rePrompts[id] = delivered + 1;
    },

    noteActivity(): void {
      silenceMs = 0;
    },

    noteMoved(): void {
      // §5.7 counts per position, and §9.1 keys `rePromptCounts` by position id
      // for the same reason: two re-prompts in EXCHANGE must not spend the
      // budget that READBACK is entitled to.
      silenceMs = 0;
      at = null;
      limitFired = null;
    },

    counts(): Readonly<Record<string, number>> {
      return { ...rePrompts };
    },
  };
}
