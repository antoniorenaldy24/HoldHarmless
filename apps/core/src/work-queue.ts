/**
 * The Work Queue — §12.9, §8.5's idempotency rule, INV-18 and INV-19.
 *
 * It owns `AuthRequest.status`, which is the one piece of state that outlives a
 * call. Everything here exists because of that: a call is an attempt, and the
 * request is the thing being attempted.
 *
 * IDEMPOTENCY IS KEYED ON requestId ALONE (§8.5). A compound key with callId
 * would only prevent double writes within one call, and that is not the case
 * that needs protection. The case is REDIAL: the link drops after the
 * representative gave the authorization number and before record_outcome was
 * written, the Work Queue redials, and the second call submits the request
 * again. The question the key must answer is "does this request already have a
 * result", not "did this call record one".
 *
 * TWO WRITERS, ONE RULE (INV-18). The Tool Handler writes through
 * record_outcome; the Call Model writes when a call ends without one. Both
 * write only while the status is not final, which closes the race where a
 * legitimate record_outcome lands just after the link closed. Every attempt
 * emits outcome.written — including the skipped ones, with a reason, because a
 * write that did not happen is exactly what an audit needs to see.
 *
 * INV-19 is the safety net above that: a call whose log already holds evidence
 * of an escalation is never recorded as `failed` when the link drops.
 */

import type { AuthRequest, AuthRequestStatus, CallEventBody } from '@holdharmless/events';

/** §9.1: the statuses a request never leaves. */
export const FINAL_STATUSES: readonly AuthRequestStatus[] = ['approved', 'denied', 'pending_info', 'escalated', 'escalated_resolved', 'failed'];

export const isFinal = (status: AuthRequestStatus): boolean => FINAL_STATUSES.includes(status);

export type Writer = 'tool_handler' | 'call_model';

export type WriteResult = { written: boolean; reason?: string };

export type WorkQueueOptions = {
  requests: AuthRequest[];
  maxAttempts?: number;
  emit?: (event: CallEventBody) => void;
};

export interface WorkQueue {
  /** The next request to dial, or null. A final status is never dialed. */
  next(): AuthRequest | null;
  /** False when the status is final, or attempts are exhausted (§8.5). */
  scheduleRedial(requestId: string): boolean;
  /**
   * INV-18. Writes only while the status is not final; every call emits
   * outcome.written, with `skipped` and a reason when it did not write.
   */
  updateStatus(requestId: string, status: AuthRequestStatus, writer: Writer): WriteResult;
  /**
   * INV-19: what the Call Model writes when a call ends without an outcome.
   * `escalationEvidenced` comes from the event log, not from a belief.
   */
  resolveOnClose(requestId: string, evidence: { escalationEvidenced: boolean }): WriteResult;
  markEscalationHandled(requestId: string, requeue: boolean): void;
  get(requestId: string): AuthRequest | undefined;
}

export const MAX_ATTEMPTS = 3;

export function createWorkQueue(options: WorkQueueOptions): WorkQueue {
  const emit = options.emit ?? (() => {});
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const byId = new Map(options.requests.map((r) => [r.id, r]));

  const write = (request: AuthRequest, status: AuthRequestStatus, writer: Writer): WriteResult => {
    if (isFinal(request.status)) {
      // Not an error: the expected shape of a redial that crossed a late write,
      // and of a second record_outcome in one call. Logged, never applied.
      const reason = `${request.id} is already ${request.status}`;
      emit({ t: 'outcome.written', writer, status, skipped: true, reason });
      return { written: false, reason };
    }
    request.status = status;
    emit({ t: 'outcome.written', writer, status, skipped: false });
    return { written: true };
  };

  return {
    next(): AuthRequest | null {
      return [...byId.values()].find((r) => !isFinal(r.status) && r.attempts < maxAttempts) ?? null;
    },

    scheduleRedial(requestId: string): boolean {
      const request = byId.get(requestId);
      if (!request) return false;
      if (isFinal(request.status)) return false;
      if (request.attempts >= maxAttempts) {
        // MAX_ATTEMPTS exhausted is itself a result (§9.1: `failed` is final
        // after MAX_ATTEMPTS), so it is written rather than left in progress.
        write(request, 'failed', 'call_model');
        return false;
      }
      request.attempts += 1;
      // A request being dialled right now is not a request waiting to be
      // dialled, and until module 3.6 nothing in the product ever said so:
      // `in_progress` was a status §9.1 defines, panel 1 displays, and no code
      // wrote. It belongs with `attempts`, which changes at the same moment and
      // for the same reason, so both have one writer. No event: `call.started`
      // already carries requestId and attempts, and routing this through
      // updateStatus would put a non-outcome into the outcome log.
      request.status = 'in_progress';
      return true;
    },

    updateStatus(requestId: string, status: AuthRequestStatus, writer: Writer): WriteResult {
      const request = byId.get(requestId);
      if (!request) return { written: false, reason: `no request ${requestId}` };
      return write(request, status, writer);
    },

    resolveOnClose(requestId: string, evidence: { escalationEvidenced: boolean }): WriteResult {
      const request = byId.get(requestId);
      if (!request) return { written: false, reason: `no request ${requestId}` };
      if (isFinal(request.status)) {
        const reason = `${request.id} is already ${request.status}`;
        emit({ t: 'outcome.written', writer: 'call_model', status: request.status, skipped: true, reason });
        return { written: false, reason };
      }
      // INV-19: evidence in the log outranks the fact that the link died. A
      // call that escalated and then dropped escalated; it did not fail.
      if (evidence.escalationEvidenced) return write(request, 'escalated', 'call_model');
      if (request.attempts >= maxAttempts) return write(request, 'failed', 'call_model');
      // Not final: the request goes back for a redial rather than being closed
      // by a dropped link.
      return { written: false, reason: 'link closed with attempts remaining; the request stays open for redial' };
    },

    markEscalationHandled(requestId: string, requeue: boolean): void {
      const request = byId.get(requestId);
      if (!request) return;
      if (requeue) {
        // A human handled it and wants another call: the status leaves its
        // final state deliberately, and only here.
        request.status = 'queued';
        request.attempts = 0;
        emit({ t: 'outcome.written', writer: 'call_model', status: 'queued', skipped: false, reason: 'escalation handled, requeued' });
        return;
      }
      request.status = 'escalated_resolved';
      emit({ t: 'outcome.written', writer: 'call_model', status: 'escalated_resolved', skipped: false, reason: 'escalation handled' });
    },

    get(requestId: string): AuthRequest | undefined {
      return byId.get(requestId);
    },
  };
}
