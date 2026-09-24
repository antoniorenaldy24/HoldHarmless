/**
 * What a tool call actually writes — module 3.6.
 *
 * Two of these tests exist because a mutation survived. The file's own header
 * claimed that `record_outcome` tells the phase machine only what the QUEUE
 * decided, and nothing checked it: deleting the guard left every test green
 * while a call could end DONE on an outcome nobody recorded. The other is
 * `notify_transfer` and the disclosure it owes a new party.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthRequest, CallEventBody } from '@holdharmless/events';
import { createDisclosureTracker, createPhaseMachine } from '@holdharmless/callmodel';
import { createToolEffects, createWorkQueue } from '../src/index.js';

const REQUEST = (): AuthRequest => ({
  id: 'SYN-REQ-E', patientRef: 'SYN-PT-1', memberId: 'SYN-M-1', patientDob: '1970-03-14',
  cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-01',
  payerId: 'SYN-PAYER-1', payerEndpoint: 'ws://127.0.0.1:8081/call', clinicName: 'Clinic',
  clinicCallbackPhone: '555-0142', priority: 'routine', clinicalSummary: 'Summary.',
  status: 'in_progress', attempts: 1,
});

function setup(over: Partial<AuthRequest> = {}) {
  const events: CallEventBody[] = [];
  const request = { ...REQUEST(), ...over };
  const queue = createWorkQueue({ requests: [request], emit: (e) => events.push(e) });
  const phase = createPhaseMachine({ emit: (e) => events.push(e) });
  const disclosure = createDisclosureTracker();
  const channels: string[] = [];
  const effects = createToolEffects({
    request, queue, phase,
    emit: (e) => events.push(e),
    sendDtmf: () => {},
    disclosure,
    setChannel: (to) => channels.push(to),
  });
  return { effects, events, request, queue, phase, disclosure, channels };
}

describe('record_outcome tells the phase machine what the QUEUE decided', () => {
  test('an accepted write sets outcomeWritten', () => {
    const s = setup();
    s.effects.recordOutcome({ status: 'approved', authNumber: 'A472-91' });
    assert.equal(s.queue.get('SYN-REQ-E')!.status, 'approved');
    assert.equal(s.phase.state.outcomeWritten, true);
  });

  test('a write the queue REFUSED leaves outcomeWritten false — and the call unfinished', () => {
    // The failure this guards: the request already has a result, INV-18 skips
    // the write, and the phase machine is told anyway. CLOSING → DONE needs
    // outcomeWritten, so the call would end reporting an outcome that was never
    // recorded — the duplicate-request harm wearing a success badge.
    const s = setup({ status: 'denied' });
    s.effects.recordOutcome({ status: 'approved', authNumber: 'A472-91' });

    assert.equal(s.queue.get('SYN-REQ-E')!.status, 'denied', 'the queue kept the first result');
    assert.equal(s.phase.state.outcomeWritten, false, 'and the call model was not told otherwise');
    const skipped = s.events.filter((e) => e.t === 'outcome.written' && e.skipped);
    assert.equal(skipped.length, 1, 'the refusal is in the log, not silent');
  });

  test('the closing does not become DONE on a refused write', () => {
    const s = setup({ status: 'denied' });
    s.phase.onChannelChange('HUMAN');
    s.phase.onToolAccepted('escalate_to_human', {});
    assert.equal(s.phase.state.phase, 'CLOSING');
    s.phase.onClosingTurnComplete('completed');
    s.effects.recordOutcome({ status: 'approved' });
    assert.equal(s.phase.state.phase, 'CLOSING', 'both conditions are needed, and one of them did not happen');
  });
});

describe('notify_transfer owes the next party a disclosure', () => {
  test('the transfer resets disclosure and moves the channel', () => {
    const s = setup();
    s.disclosure.onAgentTurn('This is an AI assistant calling on behalf of Riverside Clinic.');
    assert.equal(s.disclosure.disclosedToCurrentParty, true);

    s.effects.notifyTransfer('pharmacy review', 'let me put you through');
    assert.equal(s.disclosure.disclosedToCurrentParty, false, 'a new party has not been told anything');
    assert.deepEqual(s.channels, ['TRANSFER'], 'ADR-019: this tool is the only way the channel reaches TRANSFER');
  });
});

describe('capture_reference is the tool that owns lastReference', () => {
  test('it writes to the REQUEST, which outlives the call', () => {
    const s = setup();
    s.effects.captureReference('REF-42', 'case_number');
    assert.equal(s.request.lastReference, 'REF-42');
  });

  test('an outcome does not quietly overwrite it', () => {
    // §8.1's record_outcome has no reference field: there is no path by which an
    // outcome could carry one, so nothing here may pretend to read it.
    const s = setup();
    s.effects.captureReference('REF-42', 'case_number');
    s.effects.recordOutcome({ status: 'approved', authNumber: 'A1', reference: 'SOMETHING-ELSE' });
    assert.equal(s.request.lastReference, 'REF-42');
  });
});
