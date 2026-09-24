/**
 * The writes a tool call actually makes — §8, module 3.6.
 *
 * `ToolEffects` has been an interface since module 3.1, and until now the only
 * implementations of it were in tests. That is a comfortable place to leave a
 * seam: every handler test passed while nothing in the product had ever stored
 * a reference number, and the one thing A-16 depends on — `capture_reference`
 * reaching `AuthRequest.lastReference`, which outlives the call — had never
 * executed outside an assertion.
 *
 * WHAT THIS FILE IS AND IS NOT. It is the binding between a validated tool call
 * and the state that owns each consequence. It owns no state of its own. Where
 * an owner exists it delegates (the phase machine for phase, the Work Queue for
 * status, the disclosure tracker for parties); where one does not exist yet it
 * takes a callback rather than inventing a second home for something. The
 * channel is the clearest case: `notify_transfer` moves it (ADR-019), no
 * channel machine exists yet, and guessing one here would put the channel in
 * two places at once.
 *
 * ORDER MATTERS IN ONE PLACE. `record_outcome` writes to the Work Queue first
 * and tells the phase machine second. INV-18 lets the queue refuse a write on a
 * request that already has a final status, and `outcomeWritten` must reflect
 * what the queue did rather than what the model asked for — otherwise a refused
 * write would still unlatch CLOSING → DONE, and the call would end reporting an
 * outcome nobody recorded.
 */

import type {
  AuthRequest,
  CallEventBody,
  Channel,
  Outcome,
  Producer,
} from '@holdharmless/events';
import type { DisclosureTracker, PhaseMachine } from '@holdharmless/callmodel';
import type { ToolEffects } from './tools.js';
import type { WorkQueue } from './work-queue.js';

export type ToolEffectDeps = {
  /** The live record. `lastReference` is written here because it survives the call. */
  request: AuthRequest;
  queue: WorkQueue;
  phase: PhaseMachine;
  emit: (event: CallEventBody) => void;
  /** The transport's keypad. The only effect with no state behind it. */
  sendDtmf: (digits: string, reason: string) => void;
  /** ADR-019's other half: the channel has an owner, and it is not this file. */
  setChannel?: (to: Channel, producer: Producer) => void;
  disclosure?: DisclosureTracker;
  /** §8.6. The coordinator decides which tier writes the summary. */
  escalate?: (reason: string, contextSummary: string) => void;
};

export function createToolEffects(deps: ToolEffectDeps): ToolEffects {
  return {
    sendDtmf(digits: string, reason: string): void {
      deps.sendDtmf(digits, reason);
    },

    captureAuthNumber(value: string, spokenForm?: string): void {
      // The phase machine is where a captured number becomes READBACK (§5.4);
      // the event is what the dashboard and §8.2's sanity check read.
      deps.phase.onToolAccepted('capture_auth_number', { value, ...(spokenForm ? { spoken_form: spokenForm } : {}) });
      deps.emit({ t: 'auth_number.captured', value, ...(spokenForm ? { spokenForm } : {}) });
    },

    confirmReadback(matched: boolean, correctedValue?: string): void {
      deps.phase.onToolAccepted('confirm_readback', {
        matched,
        ...(correctedValue !== undefined ? { corrected_value: correctedValue } : {}),
      });
    },

    notifyTransfer(destination: string, quote?: string): void {
      // Disclosure first: the party has changed whether or not anything else
      // succeeds, and a disclosure owed to a new party is the obligation this
      // tool exists to create (§5.5, ADR-019).
      deps.disclosure?.onNotifyTransfer();
      deps.setChannel?.('TRANSFER', { kind: 'tool', seq: 0, name: 'notify_transfer' });
      deps.emit({ t: 'turn.transcribed', speaker: 'agent', text: `[transfer announced to ${destination}${quote ? `: "${quote}"` : ''}]`, partial: false, redactable: false, isClosing: false });
    },

    captureReference(reference: string, kind?: string): void {
      // THE POINT OF A-16. A call can drop at any moment; what the clinic needs
      // on the next one is the number the representative gave, so the agent can
      // ask about a request already on file instead of submitting a second.
      // DISCLOSURE.txt renders it under `<if attempts > 0>`, which is why this
      // is written to the REQUEST and not to the call.
      deps.request.lastReference = reference;
      deps.emit({ t: 'reference.captured', reference, kind: kind ?? 'unspecified' });
    },

    escalate(reason: string, contextSummary: string): void {
      deps.escalate?.(reason, contextSummary);
    },

    recordOutcome(outcome: Outcome): void {
      // The queue decides (INV-18), and the phase machine is told what the queue
      // decided — never what the model asked for.
      const written = deps.queue.updateStatus(deps.request.id, outcome.status, 'tool_handler');
      if (!written.written) return;
      deps.phase.onToolAccepted('record_outcome', { status: outcome.status });
      // `Outcome.reference` is deliberately NOT copied to the request. §8.1's
      // record_outcome schema has no reference field, so nothing can set it on
      // this path; writing it here would be a branch no call reaches, and a
      // mutation of it survived every test — which is what dead code looks
      // like. `capture_reference` is the tool that owns lastReference.
    },
  };
}
