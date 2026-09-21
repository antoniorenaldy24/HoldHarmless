/**
 * Hand-built call logs for acceptance 1.5: "all run against a hand-built fixture".
 *
 * Two complete, CORRECT calls, written event by event from §5.3, §5.4, §7.3 and
 * §8. Each is a sequence of bodies with a time offset; `build()` assigns seq and
 * timestamps the way the core would, so a mutation can insert or drop an event
 * without renumbering by hand.
 */

import type { AuthRequest, Call, CallEvent, CallEventBody } from '@holdharmless/events';

export type Step = { ms: number; body: CallEventBody };

const T0 = Date.parse('2026-09-21T09:00:00.000Z');
export const epoch = (offsetMs: number) => T0 + offsetMs;

export function build(steps: readonly Step[], callId = 'call-1'): CallEvent[] {
  return steps.map((s, i) => ({
    ...s.body,
    seq: i + 1,
    callId,
    at: new Date(epoch(s.ms)).toISOString(),
  })) as CallEvent[];
}

export function request(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    id: 'req-1',
    patientRef: 'SYN-P-0001',
    memberId: 'SYN4471029',
    patientDob: '1968-03-14',
    cptCode: '96413',
    icdCode: 'C50.911',
    providerNpi: '1234567890', // fails the NPI check digit, so cannot be a real NPI
    serviceDate: '2026-10-01',
    payerId: 'PAYER-SYN-1',
    payerEndpoint: 'ws://127.0.0.1:8081/call',
    clinicName: 'Northgate Oncology Associates',
    clinicCallbackPhone: '800-555-0142',
    priority: 'routine',
    clinicalSummary: 'Stage II HER2+ breast carcinoma; approved regimen per tumor board.',
    status: 'in_progress',
    attempts: 0,
    ...overrides,
  };
}

export function call(overrides: Partial<Call> = {}): Call {
  return {
    id: 'call-1',
    requestId: 'req-1',
    transport: 'loopback',
    navMode: 'dtmf',
    networkProfile: 'TELEPHONY',
    startedAt: new Date(T0).toISOString(),
    channel: 'CLOSED',
    phase: 'DONE',
    holdSuspected: false,
    holdDurationMs: 0,
    cumulativeHoldMs: 0,
    humanChannelMs: 0,
    disclosedToCurrentParty: false,
    partiesDetected: 1,
    disclosuresDelivered: 1,
    readbackAttempts: 0,
    rePromptCounts: {},
    holdRampSteps: 0,
    pendingContextCorrection: false,
    discardedToolResults: [],
    outcomeWritten: true,
    billableSessionMs: 0,
    ...overrides,
  };
}

const turn = (speaker: 'agent' | 'far_end', text: string, isClosing = false): CallEventBody => ({
  t: 'turn.transcribed', speaker, text, partial: false, redactable: false, isClosing,
});

// ---------------------------------------------------------------------------
// Call A — approved. IVR menu, a queue hold, one representative, read-back.
// ---------------------------------------------------------------------------

export const APPROVED: readonly Step[] = [
  { ms: 0, body: { t: 'call.started', requestId: 'req-1', attempts: 0, priority: 'routine', networkProfile: 'TELEPHONY' } },
  { ms: 100, body: { t: 'channel.changed', from: 'DIALING', to: 'IVR', producer: { kind: 'transport', cause: 'link_established' } } },
  { ms: 100, body: { t: 'gate.changed', from: 'closed', to: 'dtmf_only', channel: 'IVR', holdSuspected: false, clearSent: false, producer: { kind: 'transport', cause: 'link_established' } } },
  { ms: 200, body: { t: 'prompt.loaded', files: ['IVR_DTMF.txt'], hedged: false, disclosureIncluded: false, substitutions: [] } },
  { ms: 4000, body: turn('far_end', 'For prior authorization, press two.') },
  { ms: 5000, body: { t: 'dtmf.sent', digits: '2', reason: 'prior authorization' } },

  // Queue hold: suspected on provisional periodicity, confirmed by autocorrelation.
  { ms: 8000, body: { t: 'hold.suspected', trigger: 'periodic_provisional', atMs: epoch(8000) } },
  { ms: 8000, body: { t: 'gate.changed', from: 'dtmf_only', to: 'closed', channel: 'IVR', holdSuspected: true, clearSent: true, producer: { kind: 'acoustic', seq: 7 } } },
  { ms: 28000, body: { t: 'channel.changed', from: 'IVR', to: 'HOLD', producer: { kind: 'acoustic', seq: 80 } } },
  // §5.5: confirming HOLD clears suspicion. The gate stays closed by derivation.
  { ms: 28000, body: { t: 'hold.cleared', reason: 'hold_confirmed' } },
  { ms: 28000, body: { t: 'prompt.loaded', files: ['HOLD.txt'], hedged: false, disclosureIncluded: false, substitutions: [] } },

  // A representative answers. The atomic group from one handler (§5.5).
  { ms: 300000, body: { t: 'channel.changed', from: 'HOLD', to: 'HUMAN', producer: { kind: 'semantic', seq: 900 } } },
  { ms: 300000, body: { t: 'phase.changed', from: 'NOT_STARTED', to: 'EXCHANGE', producer: { kind: 'semantic', seq: 900 } } },
  { ms: 300000, body: { t: 'gate.changed', from: 'closed', to: 'open', channel: 'HUMAN', holdSuspected: false, clearSent: false, producer: { kind: 'semantic', seq: 900 } } },
  // Back from a long hold: continuity is not assured, so the hedge — and not
  // DISCLOSURE.txt alongside it — carries the disclosure (§7.3).
  { ms: 300100, body: { t: 'prompt.loaded', files: ['PARTY_HEDGE.txt', 'EXCHANGE.txt'], hedged: true, disclosureIncluded: false, substitutions: ['CLINIC_NAME'] } },
  { ms: 301000, body: turn('far_end', 'Prior authorization, this is Dana.') },
  { ms: 303000, body: turn('agent', "Hi Dana, I'm an AI assistant calling on behalf of Northgate Oncology Associates about a prior authorization.") },
  { ms: 303000, body: { t: 'disclosure.delivered', partyIndex: 1, quote: 'an AI assistant calling on behalf of Northgate Oncology Associates' } },
  { ms: 305000, body: turn('far_end', "What's the member ID?") },
  { ms: 305500, body: { t: 'tool.called', toolCallId: 'tc1', name: 'get_auth_request', args: { fields: ['member_id'] } } },
  { ms: 305600, body: { t: 'tool.returned', toolCallId: 'tc1', name: 'get_auth_request', result: { member_id: 'SYN4471029' }, latencyMs: 100 } },
  { ms: 306000, body: turn('agent', 'The member ID is S Y N 4 4 7 1 0 2 9.') },
  { ms: 320000, body: turn('far_end', 'The authorization number is A 4 7 2 dash 9 1.') },
  { ms: 320500, body: { t: 'tool.called', toolCallId: 'tc2', name: 'capture_auth_number', args: { value: 'A472-91' } } },
  { ms: 320600, body: { t: 'tool.returned', toolCallId: 'tc2', name: 'capture_auth_number', result: { ok: true }, latencyMs: 100 } },
  { ms: 320600, body: { t: 'auth_number.captured', value: 'A472-91' } },
  { ms: 320600, body: { t: 'phase.changed', from: 'EXCHANGE', to: 'READBACK', producer: { kind: 'tool', seq: 24, name: 'capture_auth_number' } } },
  { ms: 320700, body: { t: 'prompt.loaded', files: ['READBACK.txt'], hedged: false, disclosureIncluded: false, substitutions: ['CAPTURED_AUTH_NUMBER'] } },
  { ms: 321000, body: turn('agent', 'Let me read that back: A, 4, 7, 2, dash, 9, 1.') },
  { ms: 324000, body: turn('far_end', "That's correct.") },
  { ms: 324500, body: { t: 'tool.called', toolCallId: 'tc3', name: 'confirm_readback', args: { matched: true } } },
  { ms: 324600, body: { t: 'tool.returned', toolCallId: 'tc3', name: 'confirm_readback', result: { ok: true }, latencyMs: 100 } },
  { ms: 324600, body: { t: 'phase.changed', from: 'READBACK', to: 'CLOSING', producer: { kind: 'tool', seq: 31, name: 'confirm_readback' }, closingKind: 'wrapup' } },
  { ms: 324700, body: { t: 'prompt.loaded', files: ['CLOSING_WRAPUP.txt'], hedged: false, disclosureIncluded: false, substitutions: [] } },
  // Outcome BEFORE the closing utterance (ADR-015).
  { ms: 325000, body: { t: 'tool.called', toolCallId: 'tc4', name: 'record_outcome', args: { status: 'approved', auth_number: 'A472-91' } } },
  { ms: 325100, body: { t: 'tool.returned', toolCallId: 'tc4', name: 'record_outcome', result: { ok: true }, latencyMs: 100 } },
  { ms: 325100, body: { t: 'outcome.written', writer: 'tool_handler', status: 'approved', skipped: false } },
  { ms: 325500, body: turn('agent', 'Thank you, Dana. Goodbye.', true) },
  { ms: 327000, body: { t: 'phase.changed', from: 'CLOSING', to: 'DONE', producer: { kind: 'session', event: 'reply.done' } } },
  { ms: 327000, body: { t: 'harness.telemetry', metric: 'parties_used', value: 1 } },
  { ms: 327000, body: { t: 'harness.telemetry', metric: 'agent_speech_during_hold_ms', value: 0 } },
  { ms: 327500, body: { t: 'channel.changed', from: 'HUMAN', to: 'CLOSED', producer: { kind: 'transport', cause: 'far_end_hangup' } } },
  { ms: 327500, body: { t: 'gate.changed', from: 'open', to: 'closed', channel: 'CLOSED', holdSuspected: false, clearSent: true, producer: { kind: 'transport', cause: 'far_end_hangup' } } },
  { ms: 327600, body: { t: 'call.ended', outcome: { status: 'approved', authNumber: 'A472-91' } } },
];

// ---------------------------------------------------------------------------
// Call B — escalated. Expedited; an announced transfer to a second party, who
// asks a clinical question.
// ---------------------------------------------------------------------------

export const ESCALATION_SUMMARY =
  'EXPEDITED. Gave member ID SYN4471029, DOB, CPT 96413, ICD C50.911. Representative asked whether the patient ' +
  'failed first-line therapy, beyond the approved clinical summary. Clinical staff need to call back, reference REF-4417-B.';

export const ESCALATED: readonly Step[] = [
  { ms: 0, body: { t: 'call.started', requestId: 'req-1', attempts: 0, priority: 'expedited', networkProfile: 'TELEPHONY' } },
  { ms: 100, body: { t: 'channel.changed', from: 'DIALING', to: 'IVR', producer: { kind: 'transport', cause: 'link_established' } } },
  { ms: 100, body: { t: 'gate.changed', from: 'closed', to: 'dtmf_only', channel: 'IVR', holdSuspected: false, clearSent: false, producer: { kind: 'transport', cause: 'link_established' } } },
  { ms: 200, body: { t: 'prompt.loaded', files: ['IVR_DTMF.txt'], hedged: false, disclosureIncluded: false, substitutions: [] } },
  { ms: 3000, body: { t: 'dtmf.sent', digits: '2', reason: 'provider services' } },

  { ms: 9000, body: { t: 'channel.changed', from: 'IVR', to: 'HUMAN', producer: { kind: 'semantic', seq: 40 } } },
  { ms: 9000, body: { t: 'phase.changed', from: 'NOT_STARTED', to: 'EXCHANGE', producer: { kind: 'semantic', seq: 40 } } },
  { ms: 9000, body: { t: 'gate.changed', from: 'dtmf_only', to: 'open', channel: 'HUMAN', holdSuspected: false, clearSent: false, producer: { kind: 'semantic', seq: 40 } } },
  // Straight from IVR: no hedge, so DISCLOSURE.txt is emitted.
  { ms: 9100, body: { t: 'prompt.loaded', files: ['EXCHANGE.txt', 'DISCLOSURE.txt'], hedged: false, disclosureIncluded: true, substitutions: ['CLINIC_NAME'] } },
  { ms: 10000, body: turn('far_end', 'Provider services, this is Sam.') },
  { ms: 11000, body: turn('agent', "Hi Sam, I'm an AI assistant calling on behalf of Northgate Oncology Associates about an expedited prior authorization.") },
  { ms: 11000, body: { t: 'disclosure.delivered', partyIndex: 1, quote: 'an AI assistant calling on behalf of Northgate Oncology Associates' } },

  // Announced transfer (ADR-019): the model calls notify_transfer.
  { ms: 20000, body: turn('far_end', 'Let me transfer you to utilization management.') },
  { ms: 20500, body: { t: 'tool.called', toolCallId: 'tc1', name: 'notify_transfer', args: { destination: 'utilization management' } } },
  { ms: 20600, body: { t: 'tool.returned', toolCallId: 'tc1', name: 'notify_transfer', result: { ok: true }, latencyMs: 100 } },
  { ms: 20600, body: { t: 'hold.suspected', trigger: 'notify_transfer', atMs: epoch(20600) } },
  { ms: 20600, body: { t: 'gate.changed', from: 'open', to: 'closed', channel: 'HUMAN', holdSuspected: true, clearSent: true, producer: { kind: 'tool', seq: 15, name: 'notify_transfer' } } },
  { ms: 20600, body: { t: 'channel.changed', from: 'HUMAN', to: 'TRANSFER', producer: { kind: 'tool', seq: 15, name: 'notify_transfer' } } },
  { ms: 20600, body: { t: 'party.changed', reason: 'transfer', newIndex: 2 } },
  { ms: 20700, body: { t: 'prompt.loaded', files: ['TRANSFER.txt'], hedged: false, disclosureIncluded: false, substitutions: [] } },

  { ms: 50000, body: { t: 'channel.changed', from: 'TRANSFER', to: 'HUMAN', producer: { kind: 'semantic', seq: 300 } } },
  { ms: 50000, body: { t: 'hold.cleared', reason: 'human_confirmed' } },
  { ms: 50000, body: { t: 'gate.changed', from: 'closed', to: 'open', channel: 'HUMAN', holdSuspected: false, clearSent: false, producer: { kind: 'semantic', seq: 300 } } },
  // Back from TRANSFER: the hedge applies always (§5.3).
  { ms: 50100, body: { t: 'prompt.loaded', files: ['PARTY_HEDGE.txt', 'EXCHANGE.txt'], hedged: true, disclosureIncluded: false, substitutions: ['CLINIC_NAME'] } },
  { ms: 51000, body: turn('far_end', 'Utilization management, this is Riley.') },
  { ms: 52000, body: turn('agent', "Hi Riley, I'm an AI assistant calling on behalf of Northgate Oncology Associates.") },
  { ms: 52000, body: { t: 'disclosure.delivered', partyIndex: 2, quote: 'an AI assistant calling on behalf of Northgate Oncology Associates' } },

  { ms: 60000, body: turn('far_end', 'Did the patient fail first-line therapy?') },
  { ms: 60500, body: { t: 'tool.called', toolCallId: 'tc2', name: 'escalate_to_human', args: { reason: 'clinical question beyond the approved summary', context_summary: ESCALATION_SUMMARY } } },
  { ms: 60600, body: { t: 'tool.returned', toolCallId: 'tc2', name: 'escalate_to_human', result: { ok: true }, latencyMs: 100 } },
  { ms: 60600, body: { t: 'escalation.summary', source: 'model', urgency: 'EXPEDITED', summary: ESCALATION_SUMMARY } },
  { ms: 60600, body: { t: 'phase.changed', from: 'EXCHANGE', to: 'CLOSING', producer: { kind: 'tool', seq: 29, name: 'escalate_to_human' }, closingKind: 'escalation' } },
  { ms: 60700, body: { t: 'prompt.loaded', files: ['CLOSING_ESCALATION.txt'], hedged: false, disclosureIncluded: false, substitutions: [] } },
  { ms: 61000, body: turn('agent', 'That needs our clinical staff. Could I have a reference number?') },
  { ms: 64000, body: turn('far_end', 'Reference R E F 4 4 1 7 B.') },
  { ms: 64500, body: { t: 'tool.called', toolCallId: 'tc3', name: 'capture_reference', args: { reference: 'REF-4417-B', kind: 'call_reference' } } },
  { ms: 64600, body: { t: 'tool.returned', toolCallId: 'tc3', name: 'capture_reference', result: { ok: true }, latencyMs: 100 } },
  { ms: 64600, body: { t: 'reference.captured', reference: 'REF-4417-B', kind: 'call_reference' } },
  { ms: 65000, body: { t: 'tool.called', toolCallId: 'tc4', name: 'record_outcome', args: { status: 'escalated' } } },
  { ms: 65100, body: { t: 'tool.returned', toolCallId: 'tc4', name: 'record_outcome', result: { ok: true }, latencyMs: 100 } },
  { ms: 65100, body: { t: 'outcome.written', writer: 'tool_handler', status: 'escalated', skipped: false } },
  { ms: 65500, body: turn('agent', 'Thank you, Riley. Goodbye.', true) },
  { ms: 67000, body: { t: 'phase.changed', from: 'CLOSING', to: 'DONE', producer: { kind: 'session', event: 'reply.done' } } },
  { ms: 67000, body: { t: 'harness.telemetry', metric: 'parties_used', value: 2 } },
  { ms: 67000, body: { t: 'harness.telemetry', metric: 'agent_speech_during_hold_ms', value: 0 } },
  { ms: 67500, body: { t: 'channel.changed', from: 'HUMAN', to: 'CLOSED', producer: { kind: 'transport', cause: 'far_end_hangup' } } },
  { ms: 67500, body: { t: 'gate.changed', from: 'open', to: 'closed', channel: 'CLOSED', holdSuspected: false, clearSent: true, producer: { kind: 'transport', cause: 'far_end_hangup' } } },
  { ms: 67600, body: { t: 'call.ended', outcome: { status: 'escalated', reference: 'REF-4417-B' } } },
];

// ---------------------------------------------------------------------------
// Mutation helpers
// ---------------------------------------------------------------------------

export function indexOf(steps: readonly Step[], pred: (b: CallEventBody) => boolean): number {
  const i = steps.findIndex((s) => pred(s.body));
  if (i < 0) throw new Error('fixture mutation target not found');
  return i;
}

export function replaceAt(steps: readonly Step[], i: number, body: CallEventBody): Step[] {
  return steps.map((s, j) => (j === i ? { ms: s.ms, body } : s));
}

export function insertAfter(steps: readonly Step[], i: number, ...bodies: CallEventBody[]): Step[] {
  const at = steps[i]!.ms;
  return [...steps.slice(0, i + 1), ...bodies.map((body) => ({ ms: at, body })), ...steps.slice(i + 1)];
}

export function removeAt(steps: readonly Step[], i: number): Step[] {
  return steps.filter((_, j) => j !== i);
}
