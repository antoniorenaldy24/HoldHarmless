/**
 * The disclosure path — ADR-017, ADR-018, module 2.5.
 *
 * Two questions, two fields, and they never borrow each other's answer:
 *
 *   disclosedToCurrentParty — does this person know they are talking to an AI?
 *   phase                   — where is the work?
 *
 * THE FIELD IS SET BY OBSERVATION, NEVER BY PROVENANCE. Loading a prompt that
 * contains disclosure instructions proves nothing: the agent's reply may have
 * skipped the sentence, and after that it would be free to read a member ID to
 * someone who was never told. It becomes true only when a disclosure phrase
 * appears in the agent's own transcript (§7.6).
 *
 * THE HARD CASE HAS NO DETECTOR. A representative says "hold on", hands over to
 * a colleague for twenty seconds, and a different person returns. No transfer
 * was announced; no signal fires; the system cannot know. The answer is
 * PARTY_HEDGE.txt — a prompt that does not depend on detection — prepended on
 * every return to HUMAN without assured continuity. Continuity is assured only
 * when the hold segment was shorter than PARTY_CONTINUITY_MS, and that segment
 * is measured from SUSPICION (holdSuspectedAt), not from the confirmed channel
 * transition, which would under-report by the confirmation delay — up to twenty
 * seconds on the acoustic path, against a five-second threshold.
 *
 * The direction of failure is deliberate: too often, never too rarely.
 * Repeating a disclosure is awkward; omitting one is a breach.
 */

import type { CallEventBody, Channel } from '@holdharmless/events';
import { matchDisclosure } from '@holdharmless/detectors';

/** §13. A hold shorter than this is too brief for a person to change. */
export const PARTY_CONTINUITY_MS = 5_000;
/** §13, ADR-017: past this, even the same voice is treated as a new party. */
export const DISCLOSURE_RESET_HOLD_MS = 120_000;

export type PartyChangeReason = 'transfer' | 'long_hold' | 'ivr_return';

export type DisclosureOptions = {
  partyContinuityMs?: number;
  disclosureResetHoldMs?: number;
  emit?: (event: CallEventBody) => void;
};

export type HedgeInputs = {
  channel: Channel;
  channelCameFrom?: Channel;
  /** Length of the hold segment just ended, from holdSuspectedAt (ADR-017). */
  holdSegmentMs: number;
};

export interface DisclosureTracker {
  readonly disclosedToCurrentParty: boolean;
  /** The core's own estimate. Compared against harness ground truth, never trusted (ADR-018). */
  readonly partiesDetected: number;
  readonly disclosuresDelivered: number;

  /** §7.6's detector, applied to an assembled agent turn. Returns true if it was a disclosure. */
  onAgentTurn(text: string): boolean;
  /** A channel transition. `holdSegmentMs` is the segment that just ended. */
  onChannelChange(from: Channel, to: Channel, holdSegmentMs: number): void;
  /** ADR-019: the model announced a transfer. */
  onNotifyTransfer(): void;
  /** The §7.3 inputs this tracker owns, for promptFor. */
  promptInputs(inputs: HedgeInputs): { partyContinuityAssured: boolean; disclosedToCurrentParty: boolean; channelCameFrom?: Channel };
  reset(): void;
}

export function createDisclosureTracker(options: DisclosureOptions = {}): DisclosureTracker {
  const continuityMs = options.partyContinuityMs ?? PARTY_CONTINUITY_MS;
  const resetHoldMs = options.disclosureResetHoldMs ?? DISCLOSURE_RESET_HOLD_MS;
  const emit = options.emit ?? (() => {});

  let disclosed = false;
  let parties = 1;
  let delivered = 0;

  const newParty = (reason: PartyChangeReason): void => {
    parties++;
    disclosed = false;
    emit({ t: 'party.changed', reason, newIndex: parties });
  };

  return {
    get disclosedToCurrentParty() {
      return disclosed;
    },
    get partiesDetected() {
      return parties;
    },
    get disclosuresDelivered() {
      return delivered;
    },

    onAgentTurn(text: string): boolean {
      const match = matchDisclosure(text);
      if (!match) return false;
      delivered++;
      // Counted even when this party had already been told: the count is of
      // disclosures spoken, and INV-7 compares it against parties, not turns.
      if (!disclosed) disclosed = true;
      emit({ t: 'disclosure.delivered', partyIndex: parties, quote: text.slice(0, 200) });
      return true;
    },

    onChannelChange(from: Channel, to: Channel, holdSegmentMs: number): void {
      // ADR-017's reset list, in full.
      if (to === 'TRANSFER') {
        newParty('transfer');
        return;
      }
      if (to === 'IVR' && from === 'HOLD') {
        // Back in a menu: whoever answers next has not been told anything.
        newParty('ivr_return');
        return;
      }
      if (to === 'HUMAN' && (from === 'HOLD' || from === 'TRANSFER')) {
        if (from === 'TRANSFER' || holdSegmentMs > resetHoldMs) newParty('long_hold');
      }
    },

    onNotifyTransfer(): void {
      newParty('transfer');
    },

    promptInputs(inputs: HedgeInputs) {
      // Assured only for a return from a hold too short for a person to change.
      // A TRANSFER is never assured: it is an announced change of party.
      const assured =
        inputs.channelCameFrom === 'HOLD' ? inputs.holdSegmentMs < continuityMs : inputs.channelCameFrom !== 'TRANSFER';
      return {
        partyContinuityAssured: assured,
        disclosedToCurrentParty: disclosed,
        ...(inputs.channelCameFrom ? { channelCameFrom: inputs.channelCameFrom } : {}),
      };
    },

    reset(): void {
      disclosed = false;
      parties = 1;
      delivered = 0;
    },
  };
}
