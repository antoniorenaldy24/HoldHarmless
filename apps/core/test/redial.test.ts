/**
 * A-16 — a redial after a drop produces no duplicate request. Module 3.6.
 *
 *   "Drop the link after the number is given but before record_outcome; the
 *    second call does not resubmit."
 *
 * This is the harm the product claims to reduce, arriving by the product's own
 * hand: a call that got everything right, died before it could write the
 * result, and was redialed into submitting the same authorization twice.
 *
 * FOUR THINGS HAVE TO HOLD, and they are separate mechanisms, so they are
 * separate assertions:
 *
 *   1. The dropped call leaves the request OPEN. INV-19 writes `escalated` when
 *      the log evidences an escalation and `failed` when attempts are spent;
 *      with attempts remaining and nothing escalated, it writes nothing at all.
 *   2. The redial is the SAME request, with attempts incremented — not a second
 *      record. Idempotency is keyed on `requestId` alone (§8.5), because the
 *      question is "does this request already have a result", not "did this
 *      call record one".
 *   3. The second call's prompt says so. DISCLOSURE.txt renders its follow-up
 *      paragraph under `<if attempts > 0>` and carries <LAST_REFERENCE>, which
 *      is why `capture_reference` writes to the REQUEST and not to the call.
 *   4. Only one outcome is ever accepted for the request (INV-10, INV-18). This
 *      is the hard stop: even if the agent ignored every instruction above, the
 *      queue refuses the second write.
 *
 * WHAT IS SIMULATED AND WHAT IS REAL. The drop is represented by the call
 * ending with a number captured and no outcome written — which is exactly the
 * state a dropped link leaves behind, and the state every mechanism above
 * reacts to. Everything else is the shipped code: the Work Queue, the tool
 * handlers with their authorization and validation, the effects that perform
 * the writes, the phase machine, and the real prompt files.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthRequest, Call, CallEventBody, ToolName } from '@holdharmless/events';
import { createPhaseMachine } from '@holdharmless/callmodel';
import { promptFor } from '@holdharmless/prompts';
import { createToolEffects, createToolHandlers, createWorkQueue, type WorkQueue } from '../src/index.js';

const REQUEST = (): AuthRequest => ({
  id: 'SYN-REQ-16', patientRef: 'SYN-PT-1', memberId: 'SYN-M-44821', patientDob: '1970-03-14',
  cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-01',
  payerId: 'SYN-PAYER-1', payerEndpoint: 'ws://127.0.0.1:8081/call', clinicName: 'Riverside Synthetic Clinic',
  clinicCallbackPhone: '555-0142', priority: 'routine', clinicalSummary: 'Synthetic clinical summary.',
  status: 'queued', attempts: 0,
});

const CALL = (id: string, requestId: string): Call => ({
  id, requestId, transport: 'loopback', navMode: 'dtmf', networkProfile: 'TELEPHONY',
  startedAt: '2026-09-24T00:00:00.000Z', channel: 'HUMAN', phase: 'EXCHANGE', holdSuspected: false,
  holdDurationMs: 0, cumulativeHoldMs: 0, humanChannelMs: 0, disclosedToCurrentParty: false,
  partiesDetected: 1, disclosuresDelivered: 0, readbackAttempts: 0, rePromptCounts: {}, holdRampSteps: 0,
  pendingContextCorrection: false, discardedToolResults: [], outcomeWritten: false, billableSessionMs: 0,
});

/**
 * One call, driven through the shipped pieces. Returns what the call did, so a
 * test can assert on the request afterwards rather than on this helper.
 */
function runCall(queue: WorkQueue, request: AuthRequest, callId: string, events: CallEventBody[]) {
  const phase = createPhaseMachine({ emit: (e) => events.push(e) });
  phase.onChannelChange('HUMAN');
  const call = CALL(callId, request.id);

  const effects = createToolEffects({
    request,
    queue,
    phase,
    emit: (e) => events.push(e),
    sendDtmf: () => {},
  });

  const handlers = createToolHandlers({
    state: () => ({
      channel: 'HUMAN',
      phase: phase.state.phase,
      call: { ...call, phase: phase.state.phase, ...(phase.state.capturedAuthNumber ? { capturedAuthNumber: phase.state.capturedAuthNumber } : {}) },
      request,
    }),
    effects,
    emit: (e) => events.push({ ...e } as CallEventBody),
  });

  let seq = 0;
  const call_ = (name: ToolName, args: unknown) => handlers.handle(callId, `tc-${callId}-${seq++}`, name, args);
  return { call_, phase };
}

describe('A-16 — a redial after a drop produces no duplicate request', () => {
  test('the whole path, through the shipped pieces', () => {
    const events: CallEventBody[] = [];
    const request = REQUEST();
    const queue = createWorkQueue({ requests: [request], emit: (e) => events.push(e) });

    // --- Call 1: the number is given, a reference is taken, then the link dies.
    const first = queue.next();
    assert.equal(first?.id, 'SYN-REQ-16');
    assert.equal(queue.scheduleRedial('SYN-REQ-16'), true, 'the first dial is an attempt like any other');
    const c1 = runCall(queue, request, 'CALL-1', events);
    assert.equal(c1.call_('capture_auth_number', { value: 'A472-91' }).ok, true);
    assert.equal(c1.call_('capture_reference', { reference: 'REF-99', kind: 'call_reference' }).ok, true);
    assert.equal(c1.phase.state.phase, 'READBACK', 'the number moved the phase');

    // The drop: the call ends here, with no record_outcome.
    const closed = queue.resolveOnClose('SYN-REQ-16', { escalationEvidenced: false });

    // 1. The request stays open.
    assert.equal(closed.written, false);
    assert.match(closed.reason ?? '', /stays open for redial/);
    assert.equal(queue.get('SYN-REQ-16')!.status, 'in_progress');

    // 2. The redial is the same request, one attempt later.
    assert.equal(queue.scheduleRedial('SYN-REQ-16'), true);
    const after = queue.get('SYN-REQ-16')!;
    assert.equal(after.attempts, 2, 'attempts counts calls; a second request would count from zero');
    assert.equal(after.lastReference, 'REF-99', 'the reference outlived the call that took it');

    // 3. The second call opens by asking whether it is already on file.
    const bundle = promptFor({
      channel: 'HUMAN', phase: 'EXCHANGE', navMode: 'dtmf',
      partyContinuityAssured: false, disclosedToCurrentParty: false,
      pendingContextCorrection: false, discardedToolResults: [],
      request: after, call: CALL('CALL-2', after.id),
    });
    assert.ok(bundle, 'the second call has a prompt');
    assert.match(bundle.text, /follow-up call for the same request/);
    assert.match(bundle.text, /do not submit a new request until they confirm none exists/);
    assert.match(bundle.text, /REF-99/, 'the reference the representative gave, said back to them');

    // 4. One outcome, and only one, for this request.
    const c2 = runCall(queue, after, 'CALL-2', events);
    assert.equal(c2.call_('capture_auth_number', { value: 'A472-91' }).ok, true);
    assert.equal(c2.call_('confirm_readback', { matched: true }).ok, true);
    const recorded = c2.call_('record_outcome', { status: 'approved', auth_number: 'A472-91' });
    assert.equal(recorded.ok, true);
    assert.equal(queue.get('SYN-REQ-16')!.status, 'approved');

    // A THIRD call tries to record the same approval again. Three guards stand
    // between it and a duplicate, in this order, and writing this test found
    // all three by being refused by each in turn:
    //
    //   1. POSITION (§8.7). record_outcome exists only in CLOSING.
    //   2. §8.5. An approval needs a number captured on THIS call.
    //   3. The QUEUE (INV-18). The request already has a result.
    //
    // Only the third is idempotency. The first two would also stop a duplicate,
    // and neither of them is the mechanism A-16 names, so the test walks past
    // both deliberately rather than passing on the strength of the wrong one.
    const third = runCall(queue, after, 'CALL-3', events);
    const byPosition = third.call_('record_outcome', { status: 'approved', auth_number: 'A472-91' });
    assert.equal(byPosition.ok, false);
    assert.match(byPosition.ok === false ? byPosition.reason : '', /not available right now \(HUMAN\/EXCHANGE\)/);

    assert.equal(third.call_('capture_auth_number', { value: 'A472-91' }).ok, true);
    assert.equal(third.call_('confirm_readback', { matched: true }).ok, true);
    const again = third.call_('record_outcome', { status: 'approved', auth_number: 'A472-91' });
    assert.equal(again.ok, true, 'position and §8.5 are satisfied; the QUEUE is what refuses');
    const writes = events.filter((e) => e.t === 'outcome.written' && e.status === 'approved');
    assert.equal(writes.length, 2, 'both attempts are recorded in the log');
    assert.equal(writes.filter((e) => e.t === 'outcome.written' && !e.skipped).length, 1, 'exactly one of them wrote');
    assert.match(writes.find((e) => e.t === 'outcome.written' && e.skipped)!.t === 'outcome.written'
      ? (writes.find((e) => e.t === 'outcome.written' && e.skipped) as { reason?: string }).reason ?? '' : '', /already approved/);
  });

  test('a redial is refused once the request has a result', () => {
    const events: CallEventBody[] = [];
    const request = REQUEST();
    const queue = createWorkQueue({ requests: [request], emit: (e) => events.push(e) });
    queue.updateStatus(request.id, 'approved', 'tool_handler');
    assert.equal(queue.scheduleRedial(request.id), false);
    assert.equal(queue.next(), null, 'and it is not offered for dialling either');
  });

  test('a drop with the attempts spent is failed, not redialed forever', () => {
    const events: CallEventBody[] = [];
    const request = { ...REQUEST(), attempts: 3, status: 'in_progress' as const };
    const queue = createWorkQueue({ requests: [request], emit: (e) => events.push(e) });
    assert.equal(queue.resolveOnClose(request.id, { escalationEvidenced: false }).written, true);
    assert.equal(queue.get(request.id)!.status, 'failed');
  });

  test('the reference reaches the request even when the call writes nothing else', () => {
    // The mechanism on its own: capture_reference is the one tool whose whole
    // purpose is to survive the call it was called on.
    const events: CallEventBody[] = [];
    const request = REQUEST();
    const queue = createWorkQueue({ requests: [request], emit: (e) => events.push(e) });
    const c = runCall(queue, request, 'CALL-X', events);
    assert.equal(c.call_('capture_reference', { reference: 'TICKET-7', kind: 'ticket_number' }).ok, true);
    assert.equal(request.lastReference, 'TICKET-7');
    assert.deepEqual(
      events.filter((e) => e.t === 'reference.captured').map((e) => (e.t === 'reference.captured' ? e.reference : '')),
      ['TICKET-7'],
    );
  });
});
