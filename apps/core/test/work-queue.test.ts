/**
 * Acceptance criteria for module 3.3 (§21 week 3), the idempotency half:
 *   "All five status rules; §8.5.1 rejects bare boilerplate; idempotency on
 *    requestId; A-24 confirmed at scale"
 *
 * The five status rules and §8.5.1 are tested with the handler (module 3.1).
 * This file covers the state that outlives a call: idempotency keyed on
 * requestId, INV-18's two writers, and INV-19's safety net.
 *
 * A-24 at scale is an experiment against the live API, not a unit test:
 * scripts/a24-capture-scale.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthRequest, AuthRequestStatus, CallEventBody } from '@holdharmless/events';
import { FINAL_STATUSES, MAX_ATTEMPTS, createWorkQueue, isFinal } from '../src/index.js';

const request = (over: Partial<AuthRequest> = {}): AuthRequest => ({
  id: 'SYN-REQ-1', patientRef: 'SYN-PT-1', memberId: 'SYN-M-1', patientDob: '1970-01-01',
  cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-01',
  payerId: 'SYN-PAYER-1', payerEndpoint: 'ws://127.0.0.1:8081/call', clinicName: 'Riverside Synthetic Clinic',
  clinicCallbackPhone: '555-0142', priority: 'routine', clinicalSummary: 'Synthetic summary.',
  status: 'queued', attempts: 0, ...over,
});

function setup(...requests: AuthRequest[]) {
  const events: CallEventBody[] = [];
  const queue = createWorkQueue({ requests: requests.length ? requests : [request()], emit: (e) => events.push(e) });
  const writes = () => events.filter((e): e is Extract<CallEventBody, { t: 'outcome.written' }> => e.t === 'outcome.written');
  return { queue, events, writes };
}

describe('idempotency is keyed on requestId, because the case is redial (§8.5)', () => {
  test('a second write to a finished request is refused, whichever writer tries', () => {
    for (const writer of ['tool_handler', 'call_model'] as const) {
      const { queue, writes } = setup();
      assert.deepEqual(queue.updateStatus('SYN-REQ-1', 'approved', 'tool_handler'), { written: true });
      const second = queue.updateStatus('SYN-REQ-1', 'denied', writer);
      assert.equal(second.written, false);
      assert.match(second.reason!, /already approved/);
      assert.equal(queue.get('SYN-REQ-1')!.status, 'approved', `${writer} overwrote a final status`);
      assert.deepEqual(writes().map((w) => w.skipped), [false, true]);
    }
  });

  test('the redial case: a request that already has a result is never dialed again', () => {
    const { queue } = setup(request({ status: 'approved', attempts: 1 }));
    assert.equal(queue.next(), null);
    assert.equal(queue.scheduleRedial('SYN-REQ-1'), false);
    assert.equal(queue.get('SYN-REQ-1')!.attempts, 1, 'a refused redial must not count as an attempt');
  });

  test('the same call writing twice is refused too — one key covers both cases', () => {
    const { queue } = setup();
    queue.updateStatus('SYN-REQ-1', 'pending_info', 'tool_handler');
    assert.equal(queue.updateStatus('SYN-REQ-1', 'approved', 'tool_handler').written, false);
  });

  test('every final status blocks a later write', () => {
    for (const status of FINAL_STATUSES) {
      const { queue } = setup(request({ status }));
      assert.equal(queue.updateStatus('SYN-REQ-1', 'approved', 'tool_handler').written, false, status);
    }
    assert.equal(isFinal('in_progress'), false);
    assert.equal(isFinal('queued'), false);
  });
});

describe('INV-18: every attempt is logged, including the ones that did not write', () => {
  test('a skipped write carries writer, status, skipped and a reason', () => {
    const { queue, writes } = setup(request({ status: 'denied' }));
    queue.updateStatus('SYN-REQ-1', 'approved', 'tool_handler');
    const event = writes().at(-1)!;
    assert.equal(event.writer, 'tool_handler');
    assert.equal(event.status, 'approved', 'the status that was ATTEMPTED, so an audit can see what was refused');
    assert.equal(event.skipped, true);
    assert.match(event.reason!, /already denied/);
  });

  test('a successful write is logged as not skipped, with the writer that made it', () => {
    const { queue, writes } = setup();
    queue.updateStatus('SYN-REQ-1', 'approved', 'call_model');
    assert.deepEqual(writes(), [{ t: 'outcome.written', writer: 'call_model', status: 'approved', skipped: false }]);
  });
});

describe('INV-19: evidence in the log outranks a dropped link', () => {
  test('a call that escalated and then dropped is recorded escalated, not failed', () => {
    const { queue } = setup(request({ status: 'in_progress', attempts: MAX_ATTEMPTS }));
    const result = queue.resolveOnClose('SYN-REQ-1', { escalationEvidenced: true });
    assert.deepEqual(result, { written: true });
    assert.equal(queue.get('SYN-REQ-1')!.status, 'escalated');
  });

  test('without evidence, and with attempts exhausted, the request fails', () => {
    const { queue } = setup(request({ status: 'in_progress', attempts: MAX_ATTEMPTS }));
    queue.resolveOnClose('SYN-REQ-1', { escalationEvidenced: false });
    assert.equal(queue.get('SYN-REQ-1')!.status, 'failed');
  });

  test('without evidence and with attempts remaining, nothing is written: the request is redialed', () => {
    const { queue, writes } = setup(request({ status: 'in_progress', attempts: 1 }));
    const result = queue.resolveOnClose('SYN-REQ-1', { escalationEvidenced: false });
    assert.equal(result.written, false);
    assert.match(result.reason!, /stays open for redial/);
    assert.equal(queue.get('SYN-REQ-1')!.status, 'in_progress');
    assert.deepEqual(writes(), [], 'a dropped link on a retryable call is not an outcome');
  });

  test('a late close after a legitimate record_outcome changes nothing', () => {
    // The race §8.5 names: record_outcome lands, then the link closes.
    const { queue } = setup(request({ status: 'in_progress', attempts: MAX_ATTEMPTS }));
    queue.updateStatus('SYN-REQ-1', 'approved', 'tool_handler');
    queue.resolveOnClose('SYN-REQ-1', { escalationEvidenced: false });
    assert.equal(queue.get('SYN-REQ-1')!.status, 'approved');
  });
});

describe('attempts and redial', () => {
  test('a redial counts an attempt, and the last one fails the request rather than leaving it open', () => {
    const { queue } = setup(request({ status: 'in_progress' }));
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      assert.equal(queue.scheduleRedial('SYN-REQ-1'), true, `attempt ${i}`);
      assert.equal(queue.get('SYN-REQ-1')!.attempts, i);
    }
    assert.equal(queue.scheduleRedial('SYN-REQ-1'), false);
    assert.equal(queue.get('SYN-REQ-1')!.status, 'failed', 'MAX_ATTEMPTS exhausted is a result, not a limbo');
  });

  test('next() skips finished requests and exhausted ones', () => {
    const { queue } = setup(
      request({ id: 'A', status: 'approved' }),
      request({ id: 'B', status: 'in_progress', attempts: MAX_ATTEMPTS }),
      request({ id: 'C', status: 'queued' }),
    );
    assert.equal(queue.next()?.id, 'C');
  });

  test('an unknown request is refused rather than invented', () => {
    const { queue } = setup();
    assert.equal(queue.scheduleRedial('nope'), false);
    assert.equal(queue.updateStatus('nope', 'approved', 'tool_handler').written, false);
    assert.equal(queue.resolveOnClose('nope', { escalationEvidenced: true }).written, false);
  });
});

describe('panel 8: marking an escalation handled', () => {
  test('resolved without a requeue becomes escalated_resolved, and stays final', () => {
    const { queue } = setup(request({ status: 'escalated' }));
    queue.markEscalationHandled('SYN-REQ-1', false);
    assert.equal(queue.get('SYN-REQ-1')!.status, 'escalated_resolved');
    assert.equal(queue.next(), null);
  });

  test('a requeue is the one place a final status is left, and it resets the attempts', () => {
    const { queue, writes } = setup(request({ status: 'escalated', attempts: 2 }));
    queue.markEscalationHandled('SYN-REQ-1', true);
    const r = queue.get('SYN-REQ-1')!;
    assert.equal(r.status, 'queued');
    assert.equal(r.attempts, 0);
    assert.equal(queue.next()?.id, 'SYN-REQ-1');
    assert.match(writes().at(-1)!.reason!, /requeued/);
  });
});

describe('the statuses themselves', () => {
  test('FINAL_STATUSES is exactly §9.1’s list', () => {
    assert.deepEqual([...FINAL_STATUSES].sort(), ['approved', 'denied', 'escalated', 'escalated_resolved', 'failed', 'pending_info']);
    for (const open of ['queued', 'in_progress'] as AuthRequestStatus[]) assert.ok(!FINAL_STATUSES.includes(open), open);
  });
});
