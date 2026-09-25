/**
 * What the eight panels show — §11, module 3.8.
 *
 * The React components draw; this is where what they draw is decided, so this
 * is where it is tested. Two of these tests exist because writing the view
 * found the mistake §16.1 exists to prevent: `perceived_response_ms` was being
 * computed from the core's own turn events, which would have produced a number
 * that cannot fail.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthRequest, CallEvent, CallEventBody } from '@holdharmless/events';
import { dashboardView, REDACTED } from '../src/index.js';

let seq = 0;
const T0 = Date.parse('2026-09-25T10:00:00.000Z');
const ev = (offsetMs: number, body: CallEventBody): CallEvent => ({
  seq: seq++,
  callId: 'CALL-1',
  at: new Date(T0 + offsetMs).toISOString(),
  ...body,
});

const request = (over: Partial<AuthRequest> = {}): AuthRequest => ({
  id: 'R1', patientRef: 'p', memberId: 'm', patientDob: '1970-01-01',
  cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-01',
  payerId: 'payer', payerEndpoint: 'ws://x', clinicName: 'Clinic', clinicCallbackPhone: '555',
  priority: 'routine', clinicalSummary: 's', status: 'queued', attempts: 0, ...over,
});

const turn = (speaker: 'agent' | 'far_end', text: string, over: { partial?: boolean; redactable?: boolean; isClosing?: boolean } = {}): CallEventBody => ({
  t: 'turn.transcribed', speaker, text,
  partial: over.partial ?? false,
  redactable: over.redactable ?? false,
  isClosing: over.isClosing ?? false,
});

/** A short call: IVR, a hold, a representative, a read-back, an outcome. */
function callLog(): CallEvent[] {
  seq = 0;
  return [
    ev(0, { t: 'call.started', requestId: 'R1', attempts: 1, priority: 'routine', networkProfile: 'TELEPHONY' }),
    ev(100, { t: 'channel.changed', from: 'DIALING', to: 'IVR', producer: { kind: 'transport', cause: 'link_established' } }),
    ev(100, { t: 'gate.changed', from: 'closed', to: 'dtmf_only', channel: 'IVR', holdSuspected: false, clearSent: false, producer: { kind: 'transport', cause: 'link_established' } }),
    ev(4000, turn('far_end', 'For prior authorization, press two.')),
    ev(5000, { t: 'dtmf.sent', digits: '2', reason: 'prior authorization' }),
    ev(8000, { t: 'hold.suspected', trigger: 'periodic_provisional', atMs: T0 + 8000 }),
    ev(8000, { t: 'gate.changed', from: 'dtmf_only', to: 'closed', channel: 'IVR', holdSuspected: true, clearSent: true, producer: { kind: 'acoustic', seq: 7 } }),
    ev(28000, { t: 'channel.changed', from: 'IVR', to: 'HOLD', producer: { kind: 'acoustic', seq: 80 } }),
    ev(28000, { t: 'hold.cleared', reason: 'hold_confirmed' }),
    ev(90000, { t: 'channel.changed', from: 'HOLD', to: 'HUMAN', producer: { kind: 'semantic', seq: 900 } }),
    ev(90000, { t: 'phase.changed', from: 'NOT_STARTED', to: 'EXCHANGE', producer: { kind: 'semantic', seq: 900 } }),
    ev(90000, { t: 'gate.changed', from: 'closed', to: 'open', channel: 'HUMAN', holdSuspected: false, clearSent: false, producer: { kind: 'semantic', seq: 900 } }),
    ev(91000, turn('far_end', 'Prior authorization, this is Dana.')),
    ev(93000, turn('agent', "Hi Dana, I'm an AI assistant calling on behalf of the clinic.")),
    ev(93000, { t: 'disclosure.delivered', partyIndex: 1, quote: 'an AI assistant calling on behalf of the clinic' }),
    ev(95000, turn('far_end', 'The member ID is M as in mike, four four eight two one.', { redactable: true })),
    ev(96000, { t: 'harness.telemetry', metric: 'perceived_response_ms', value: 412 }),
    ev(97000, { t: 'tool.called', toolCallId: 'tc-1', name: 'capture_auth_number', args: { value: 'A472-91' } }),
    ev(97010, { t: 'tool.returned', toolCallId: 'tc-1', name: 'capture_auth_number', result: { ok: true }, latencyMs: 10 }),
    ev(97010, { t: 'auth_number.captured', value: 'A472-91' }),
    ev(97010, { t: 'phase.changed', from: 'EXCHANGE', to: 'READBACK', producer: { kind: 'tool', seq: 0, name: 'capture_auth_number' } }),
    ev(99000, { t: 'tool.called', toolCallId: 'tc-2', name: 'record_outcome', args: { status: 'approved' } }),
    ev(99005, { t: 'tool.rejected', toolCallId: 'tc-2', name: 'record_outcome', reason: 'state_not_allowed', detail: 'record_outcome is not available right now (HUMAN/READBACK).' }),
  ];
}

const view = (log: CallEvent[], over: { redact?: boolean; requests?: AuthRequest[]; nowMs?: number } = {}) =>
  dashboardView(log, {
    redact: over.redact ?? false,
    requests: over.requests ?? [request({ status: 'in_progress', attempts: 1 })],
    nowMs: over.nowMs ?? T0 + 100000,
  });

describe('panel 2 — the active call', () => {
  test('channel and phase are two separate indicators, and the gate is a third', () => {
    const v = view(callLog());
    assert.equal(v.activeCall.channel, 'HUMAN');
    assert.equal(v.activeCall.phase, 'READBACK');
    assert.equal(v.activeCall.gate, 'open');
    assert.equal(v.activeCall.holdSuspected, false);
    assert.equal(v.activeCall.disclosedToCurrentParty, true);
    assert.equal(v.activeCall.ended, false);
  });

  test('the hold segment is the CURRENT one, and ends when somebody answers', () => {
    // ADR-017. A call that held for a minute and is now talking to a person
    // shows zero, not sixty seconds.
    assert.equal(view(callLog()).activeCall.holdSegmentMs, 0);
  });

  test('every panel can say which profile produced its numbers (INV-16)', () => {
    assert.equal(view(callLog()).profile, 'TELEPHONY');
  });
});

describe('panel 4 — the gate timeline over the channel timeline', () => {
  test('both timelines start at their fail-safe values, not at the first event', () => {
    const v = view(callLog());
    assert.equal(v.channelSpans[0]?.value, 'DIALING');
    assert.equal(v.gateSpans[0]?.value, 'closed', 'nothing is heard until the Call Model derives an open gate');
  });

  test('the interval ADR-007 exists for is visible: gate closed, channel not yet moved', () => {
    // This is the argument of the panel. The gate shuts at 8 s on the
    // provisional signal; the channel does not reach HOLD until 28 s. For those
    // twenty seconds the agent is muted on a channel that still says IVR, and
    // the two timelines drawn on one axis make that interval a thing you can
    // point at.
    const v = view(callLog());
    const closedFrom8s = v.gateSpans.find((s) => s.value === 'closed' && s.fromMs === 8000);
    assert.ok(closedFrom8s, 'the gate closed at 8 s');
    const channelThen = v.channelSpans.find((s) => s.fromMs <= 8000 && (s.toMs ?? Infinity) > 8000);
    assert.equal(channelThen?.value, 'IVR', 'and the channel was still IVR');
    const hold = v.channelSpans.find((s) => s.value === 'HOLD');
    assert.equal(hold?.fromMs, 28000);
    assert.equal(hold!.fromMs - closedFrom8s.fromMs, 20000, 'twenty seconds of derived silence');
  });

  test('a span carries what produced it', () => {
    const v = view(callLog());
    assert.equal(v.channelSpans.find((s) => s.value === 'HOLD')?.cause, 'acoustic');
    assert.equal(v.gateSpans.find((s) => s.value === 'open')?.cause, 'semantic');
  });
});

describe('panel 5 — the transcript', () => {
  test('redaction masks what the log flagged, and only that', () => {
    const plain = view(callLog());
    const masked = view(callLog(), { redact: true });
    const memberId = (v: ReturnType<typeof view>) => v.transcript.find((l) => l.seq === 15)!;
    assert.match(memberId(plain).text, /four four eight two one/);
    assert.equal(memberId(masked).text, REDACTED);
    assert.equal(memberId(masked).redacted, true);
    assert.equal(masked.transcript.filter((l) => l.redacted).length, 1, 'nothing else was masked');
    // By seq, not by index: `transcript` holds turns, and the log holds everything.
    assert.equal(masked.transcript.find((l) => l.seq === 12)?.text, 'Prior authorization, this is Dana.');
  });

  test('a far-end turn during an unfinished agent turn is marked as a barge-in', () => {
    seq = 0;
    const log = [
      ev(0, { t: 'call.started', requestId: 'R1', attempts: 1, priority: 'routine', networkProfile: 'TELEPHONY' }),
      ev(1000, turn('agent', 'Your authorization number is A as in', { partial: true })),
      ev(1500, turn('far_end', 'No, sorry, that is not it.')),
      ev(2000, turn('agent', 'Your authorization number is A as in alpha, four seven two.')),
      ev(3000, turn('far_end', 'That one is right.')),
    ];
    const v = view(log);
    assert.equal(v.transcript[1]?.bargeIn, true, 'the agent was mid-turn');
    assert.equal(v.transcript[3]?.bargeIn, false, 'the agent had finished');
  });
});

describe('panel 6 — tool calls', () => {
  test('latency, rejections with their reason, in call order', () => {
    const v = view(callLog());
    assert.equal(v.tools.length, 2);
    assert.equal(v.tools[0]?.name, 'capture_auth_number');
    assert.equal(v.tools[0]?.latencyMs, 10);
    assert.equal(v.tools[0]?.rejected, false);
    assert.equal(v.tools[1]?.rejected, true);
    assert.equal(v.tools[1]?.reason, 'state_not_allowed');
    assert.match(v.tools[1]!.detail!, /not available right now/);
  });

  test('a discarded result is marked rather than dropped (§8.8)', () => {
    seq = 0;
    const log = [
      ev(0, { t: 'call.started', requestId: 'R1', attempts: 1, priority: 'routine', networkProfile: 'TELEPHONY' }),
      ev(10, { t: 'tool.called', toolCallId: 'tc-9', name: 'capture_reference', args: {} }),
      ev(20, { t: 'tool.returned', toolCallId: 'tc-9', name: 'capture_reference', result: {}, latencyMs: 4 }),
      ev(30, { t: 'tool.result_discarded', toolCallId: 'tc-9', name: 'capture_reference' }),
    ];
    const row = view(log).tools[0]!;
    assert.equal(row.discarded, true, 'the write stood; only the result message was lost');
    assert.equal(row.latencyMs, 4);
  });
});

describe('panel 7 — compliance and cost', () => {
  test('perceived_response_ms comes from the HARNESS, never from our own events (§16.1)', () => {
    // The mistake this test exists to prevent was made while writing the view:
    // the number was being computed from the core's own turn timestamps, which
    // would have made it a measurement of the thing doing the measuring.
    const v = view(callLog());
    assert.deepEqual(v.compliance.perceivedResponseMs, [412]);

    const withoutTelemetry = callLog().filter((e) => !(e.t === 'harness.telemetry' && e.metric === 'perceived_response_ms'));
    assert.deepEqual(view(withoutTelemetry).compliance.perceivedResponseMs, [], 'with no harness measurement there is no number to show');
  });

  test('disclosure is counted per party, and a second one to the same party is over-disclosure', () => {
    seq = 0;
    const log = [
      ev(0, { t: 'call.started', requestId: 'R1', attempts: 1, priority: 'routine', networkProfile: 'TELEPHONY' }),
      ev(1000, { t: 'disclosure.delivered', partyIndex: 1, quote: 'q' }),
      ev(2000, { t: 'disclosure.delivered', partyIndex: 1, quote: 'q' }),
      ev(3000, { t: 'party.changed', reason: 'transfer', newIndex: 2 }),
      ev(4000, { t: 'disclosure.delivered', partyIndex: 2, quote: 'q' }),
    ];
    const c = view(log).compliance;
    assert.deepEqual(c.disclosurePerParty, [2, 1]);
    assert.equal(c.partiesDetected, 2);
    assert.equal(c.overDisclosureCount, 1);
  });

  test('violations are listed with their detail, not merely counted', () => {
    seq = 0;
    const log = [
      ev(0, { t: 'call.started', requestId: 'R1', attempts: 1, priority: 'routine', networkProfile: 'TELEPHONY' }),
      ev(1000, { t: 'safety.violation', kind: 'auth_number_mismatch', detail: 'recorded "A473-91" against captured "A472-91"', toolCallId: 'tc-9' }),
      ev(1100, { t: 'invariant.violated', id: 'INV-15', detail: 'a violation with no rejection beside it' }),
    ];
    const c = view(log).compliance;
    assert.equal(c.safetyViolations[0]?.kind, 'auth_number_mismatch');
    assert.match(c.safetyViolations[0]!.detail, /A472-91/);
    assert.equal(c.invariantViolations[0]?.id, 'INV-15');
  });
});

describe('panel 1 — the queue', () => {
  test('expedited first, then what is being worked on', () => {
    const v = view(callLog(), {
      requests: [
        request({ id: 'R-routine-done', status: 'approved' }),
        request({ id: 'R-expedited', priority: 'expedited', status: 'queued' }),
        request({ id: 'R-active', status: 'in_progress' }),
      ],
    });
    assert.deepEqual(v.queue.map((r) => r.id), ['R-expedited', 'R-active', 'R-routine-done']);
  });
});

describe('panel 8 — escalation tasks', () => {
  test('the cards come through the same view', () => {
    seq = 0;
    const log = [
      ev(0, { t: 'call.started', requestId: 'R1', attempts: 1, priority: 'expedited', networkProfile: 'TELEPHONY' }),
      ev(1000, { t: 'escalation.summary', source: 'deterministic', urgency: 'EXPEDITED', summary: 'EXPEDITED. Clinical staff need to call back.' }),
    ];
    const v = view(log, { requests: [request({ status: 'escalated' })] });
    assert.equal(v.escalations.length, 1);
    assert.equal(v.escalations[0]?.urgency, 'EXPEDITED');
    assert.equal(v.escalations[0]?.resolved, false);
  });
});

describe('the hold segment is measured in the right unit', () => {
  test('a hold still running reports its own length, not the epoch', () => {
    // How this was found: the demo script wrote `atMs: 8000` — an offset into
    // the call — where the event means EPOCH milliseconds, and panel 2 reported
    // a hold segment of fifty-six years. The event type now says the unit; this
    // says what the number has to look like.
    seq = 0;
    const log = [
      ev(0, { t: 'call.started', requestId: 'R1', attempts: 1, priority: 'routine', networkProfile: 'TELEPHONY' }),
      ev(1000, { t: 'channel.changed', from: 'DIALING', to: 'IVR', producer: { kind: 'transport', cause: 'link_established' } }),
      ev(8000, { t: 'hold.suspected', trigger: 'periodic_provisional', atMs: T0 + 8000 }),
      ev(28000, { t: 'channel.changed', from: 'IVR', to: 'HOLD', producer: { kind: 'acoustic', seq: 80 } }),
    ];
    const v = view(log, { nowMs: T0 + 40000 });
    assert.equal(v.activeCall.holdSegmentMs, 32000, 'from the moment suspicion began to now');
    assert.ok(v.activeCall.holdSegmentMs < 60 * 60 * 1000, 'a hold segment is a duration, not a timestamp');
  });

  test('a person answering ends the segment', () => {
    seq = 0;
    const log = [
      ev(0, { t: 'call.started', requestId: 'R1', attempts: 1, priority: 'routine', networkProfile: 'TELEPHONY' }),
      ev(8000, { t: 'hold.suspected', trigger: 'periodic_provisional', atMs: T0 + 8000 }),
      ev(28000, { t: 'channel.changed', from: 'IVR', to: 'HOLD', producer: { kind: 'acoustic', seq: 80 } }),
      ev(90000, { t: 'channel.changed', from: 'HOLD', to: 'HUMAN', producer: { kind: 'semantic', seq: 900 } }),
    ];
    assert.equal(view(log, { nowMs: T0 + 95000 }).activeCall.holdSegmentMs, 0);
  });
});
