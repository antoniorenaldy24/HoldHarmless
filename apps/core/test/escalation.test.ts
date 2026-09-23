/**
 * Acceptance criteria for module 3.4 (§21 week 3):
 *   "All five §8.6 paths produce a summary with [URGENCY]; outcome before
 *    closing on every path; DONE produced only by reply.done; A-23 passes"
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthRequest, CallEvent, CallEventBody } from '@holdharmless/events';
import { createPhaseMachine } from '@holdharmless/callmodel';
import {
  ALWAYS_DETERMINISTIC,
  buildEscalationSummary,
  createEscalationCoordinator,
  createWorkQueue,
  escalationEvidencedIn,
  escalationSummaryProblems,
  urgencyOf,
  type EscalationCause,
} from '../src/index.js';

const ALL_CAUSES: EscalationCause[] = ['escalate_to_human', 'readback_limit', 'readback_reprompt', 'exchange_timeout', 'auth_number_mismatch'];

const request = (over: Partial<AuthRequest> = {}): AuthRequest => ({
  id: 'SYN-REQ-1', patientRef: 'SYN-PT-1', memberId: 'SYN-M-44821', patientDob: '1970-03-14',
  cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-01',
  payerId: 'SYN-PAYER-1', payerEndpoint: 'ws://127.0.0.1:8081/call', clinicName: 'Riverside Synthetic Clinic',
  clinicCallbackPhone: '555-0142', priority: 'routine', clinicalSummary: 'Synthetic summary.',
  status: 'in_progress', attempts: 0, ...over,
});

let seq = 0;
const event = (body: CallEventBody): CallEvent => ({ seq: ++seq, callId: 'SYN-CALL-1', at: new Date().toISOString(), ...body } as CallEvent);

/** A call that gave three fields, was asked a clinical question, and read a number back twice. */
const busyLog = (): CallEvent[] => [
  event({ t: 'tool.returned', toolCallId: 't1', name: 'get_auth_request', result: { fields: { member_id: 'SYN-M-44821', patient_dob: '1970-03-14' } }, latencyMs: 4 }),
  event({ t: 'tool.returned', toolCallId: 't2', name: 'get_auth_request', result: { fields: { cpt_code: '96413' } }, latencyMs: 3 }),
  event({ t: 'auth_number.captured', value: 'A472-91' }),
  event({ t: 'tool.called', toolCallId: 't3', name: 'confirm_readback', args: { matched: false, corrected_value: 'A473-91' } }),
  event({ t: 'turn.transcribed', speaker: 'far_end', text: 'Was conservative therapy tried for at least six weeks?', partial: false, redactable: true, isClosing: false }),
];

function coordinator(over: { request?: AuthRequest; log?: CallEvent[]; modelAvailable?: boolean } = {}) {
  const events: CallEventBody[] = [];
  const instructions: string[] = [];
  const c = createEscalationCoordinator({
    request: over.request ?? request(),
    log: () => over.log ?? busyLog(),
    emit: (e) => events.push(e),
    requestModelSummary: (i) => {
      instructions.push(i);
      return over.modelAvailable ?? true;
    },
  });
  const summaries = () => events.filter((e): e is Extract<CallEventBody, { t: 'escalation.summary' }> => e.t === 'escalation.summary');
  return { c, events, instructions, summaries };
}

describe('all five paths produce a summary, and every one starts with [URGENCY]', () => {
  for (const cause of ALL_CAUSES) {
    test(`${cause}: a usable summary reaches the log`, () => {
      const { c, summaries } = coordinator();
      const tier = c.begin(cause);
      if (tier === 'model_requested') c.onTurnComplete(); // the model stayed silent
      const summary = summaries().at(-1);
      assert.ok(summary, `${cause} produced no summary`);
      assert.deepEqual(escalationSummaryProblems(summary.summary, 'Routine'), []);
      assert.ok(summary.summary.startsWith('Routine.'), summary.summary);
      assert.match(summary.summary, /call back on 555-0142/);
    });
  }

  test('an expedited request says EXPEDITED, and the word is the first sentence', () => {
    const { c, summaries } = coordinator({ request: request({ priority: 'expedited' }) });
    c.begin('exchange_timeout');
    assert.ok(summaries().at(-1)!.summary.startsWith('EXPEDITED.'));
    assert.equal(summaries().at(-1)!.urgency, 'EXPEDITED');
  });

  test('the summary carries what was given, what was asked, and the reference', () => {
    const { summary } = buildEscalationSummary({
      cause: 'readback_limit',
      request: request({ lastReference: 'REF-4417-B' }),
      log: busyLog(),
    });
    assert.match(summary, /Already given: member id, patient dob, cpt code\./);
    assert.match(summary, /They asked: "Was conservative therapy tried for at least six weeks\?"/);
    assert.match(summary, /Read-back history: captured A472-91; corrected to A473-91\./);
    assert.match(summary, /Reference REF-4417-B\./);
  });

  test('what was given comes from tool.returned, not from what the prompt intended', () => {
    // A field the prompt planned to give but never returned must not appear:
    // the summary says what the representative actually heard.
    const { summary } = buildEscalationSummary({ cause: 'escalate_to_human', request: request(), log: [] });
    assert.doesNotMatch(summary, /Already given/);
    assert.match(summary, /^Routine\. /);
  });

  test('only get_auth_request tells the summary what was given', () => {
    // [GIVEN] means "read aloud to the representative". Another tool returning
    // something shaped like fields must not be read as disclosure — today none
    // does, which is a fact about the current results and not a guarantee.
    const log = [
      event({ t: 'tool.returned', toolCallId: 'x', name: 'record_outcome', result: { fields: { social_security: '000-00-0000' } }, latencyMs: 1 }),
      event({ t: 'tool.returned', toolCallId: 'y', name: 'get_auth_request', result: { fields: { member_id: 'SYN-M-44821' } }, latencyMs: 1 }),
    ];
    const { summary } = buildEscalationSummary({ cause: 'escalate_to_human', request: request(), log });
    assert.match(summary, /Already given: member id\./);
    assert.doesNotMatch(summary, /social security/);
  });

  test('a missing section is omitted rather than padded', () => {
    const { summary } = buildEscalationSummary({ cause: 'exchange_timeout', request: request(), log: [] });
    assert.doesNotMatch(summary, /Reference/);
    assert.doesNotMatch(summary, /They asked/);
    assert.doesNotMatch(summary, /Read-back history/);
  });
});

describe('the three tiers (§8.6)', () => {
  test('tier 1: the model is asked first, with a one-shot instruction', () => {
    const { c, instructions, summaries } = coordinator();
    assert.equal(c.begin('readback_limit'), 'model_requested');
    assert.equal(instructions.length, 1);
    assert.match(instructions[0]!, /escalate_to_human/);
    assert.deepEqual(summaries(), [], 'nothing is written while the model still has its turn');
    assert.equal(c.pending, true);
  });

  test('tier 1 succeeds: the model’s own summary is logged as the model’s', () => {
    const { c, summaries } = coordinator();
    c.begin('readback_limit');
    const written = 'Routine. Gave member ID and DOB. They asked about first-line therapy. Clinical staff need to call back on 555-0142.';
    assert.equal(c.onModelSummary(written), true);
    assert.equal(summaries().at(-1)!.source, 'model');
    assert.equal(summaries().at(-1)!.summary, written);
    assert.equal(c.pending, false);
  });

  test('tier 2: one turn with no summary, and the Call Model writes it', () => {
    const { c, summaries } = coordinator();
    c.begin('readback_reprompt');
    c.onTurnComplete();
    assert.equal(summaries().at(-1)!.source, 'deterministic');
    assert.equal(c.pending, false);
  });

  test('a later turn does not write a second summary', () => {
    const { c, summaries } = coordinator();
    c.begin('readback_reprompt');
    c.onTurnComplete();
    c.onTurnComplete();
    assert.equal(summaries().length, 1);
  });

  test('a model summary that breaks the rules is replaced, not stored', () => {
    // A summary INV-9 would reject is worse than none: the task looks handled.
    const { c, summaries } = coordinator();
    c.begin('readback_limit');
    assert.equal(c.onModelSummary('We should escalate this one.'), false);
    assert.equal(summaries().length, 1);
    assert.equal(summaries()[0]!.source, 'deterministic');
    assert.deepEqual(escalationSummaryProblems(summaries()[0]!.summary, 'Routine'), []);
  });

  test('tier 3: a mismatch and a phase timeout never ask the model', () => {
    for (const cause of ALWAYS_DETERMINISTIC) {
      const { c, instructions, summaries } = coordinator();
      assert.equal(c.begin(cause), 'deterministic');
      assert.deepEqual(instructions, [], `${cause} asked the model`);
      assert.equal(summaries().at(-1)!.source, 'deterministic');
    }
  });

  test('when the model cannot be asked at all, the summary is written immediately', () => {
    // ADR-022 forbids createReply while the gate is shut. Waiting a turn for a
    // reply that cannot happen would leave the escalation without a summary.
    const { c, summaries } = coordinator({ modelAvailable: false });
    assert.equal(c.begin('readback_limit'), 'deterministic');
    assert.equal(summaries().length, 1);
  });
});

describe('INV-9: the evidence is read from the log', () => {
  test('a valid summary in the log is evidence; nothing else is', () => {
    const { c, events } = coordinator();
    c.begin('exchange_timeout');
    const log = events.map((e) => event(e));
    assert.equal(escalationEvidencedIn(log, 'Routine'), true);
    assert.equal(escalationEvidencedIn([], 'Routine'), false);
  });

  test('a summary written for the wrong urgency is not evidence', () => {
    const { c, events } = coordinator({ request: request({ priority: 'expedited' }) });
    c.begin('exchange_timeout');
    const log = events.map((e) => event(e));
    assert.equal(escalationEvidencedIn(log, 'EXPEDITED'), true);
    assert.equal(escalationEvidencedIn(log, 'Routine'), false);
  });

  test('a malformed summary in the log is not evidence', () => {
    const log = [event({ t: 'escalation.summary', source: 'model', urgency: 'Routine', summary: 'escalate please' })];
    assert.equal(escalationEvidencedIn(log, 'Routine'), false);
  });

  test('the rules themselves', () => {
    assert.deepEqual(escalationSummaryProblems('Routine. Clinical staff need to call back on 555-0142 with the case.', 'Routine'), []);
    assert.match(escalationSummaryProblems('routine. clinical staff need to call back on 555-0142 today.', 'Routine')[0]!, /first sentence/);
    assert.match(escalationSummaryProblems('EXPEDITED. Clinical staff need to call back on 555-0142.', 'Routine')[0]!, /first sentence/);
    assert.match(escalationSummaryProblems('Routine. Short.', 'Routine').join(' '), /at least 40 characters/);
    assert.match(escalationSummaryProblems('Routine. The representative asked about the clinical indication for this request.', 'Routine')[0]!, /what needs to happen next/);
  });
});

describe('the outcome is written before the closing is spoken (ADR-015, INV-20)', () => {
  /** Runs a closing the way the Call Model will: outcome, then the closing turn. */
  const closingCall = (order: 'outcome_first' | 'closing_first') => {
    const log: CallEvent[] = [];
    const m = createPhaseMachine({ emit: (e) => log.push(event(e)) });
    m.onChannelChange('HUMAN');
    m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    m.onToolAccepted('confirm_readback', { matched: true });

    const writeOutcome = () => {
      m.onToolAccepted('record_outcome', { status: 'approved', auth_number: 'A472-91' });
      log.push(event({ t: 'outcome.written', writer: 'tool_handler', status: 'approved', skipped: false }));
    };
    const speakClosing = () => {
      log.push(event({ t: 'turn.transcribed', speaker: 'agent', text: 'Thank you, have a good day.', partial: false, redactable: false, isClosing: true }));
      m.onClosingTurnComplete('completed');
    };
    if (order === 'outcome_first') { writeOutcome(); speakClosing(); } else { speakClosing(); writeOutcome(); }
    return { log, phase: m.state.phase };
  };

  /** INV-20, as the invariant checker asks it. */
  const inv20 = (log: CallEvent[]): boolean => {
    const closingTurn = log.findIndex((e) => e.t === 'turn.transcribed' && e.speaker === 'agent' && e.isClosing);
    const outcome = log.findIndex((e) => e.t === 'outcome.written' && !e.skipped);
    return closingTurn === -1 || (outcome !== -1 && outcome < closingTurn);
  };

  test('the intended order satisfies INV-20 and ends the call', () => {
    const { log, phase } = closingCall('outcome_first');
    assert.equal(inv20(log), true);
    assert.equal(phase, 'DONE');
  });

  test('the wrong order is caught — the check is not vacuous', () => {
    const { log, phase } = closingCall('closing_first');
    assert.equal(inv20(log), false, 'a closing spoken before the outcome must be a violation');
    assert.equal(phase, 'DONE', 'the call still ends; what differs is that the log records the race');
  });

  test('every escalation path can write its outcome before any closing is spoken', () => {
    for (const cause of ALL_CAUSES) {
      const log: CallEvent[] = [];
      const { c } = coordinator();
      const m = createPhaseMachine({ emit: (e) => log.push(event(e)) });
      m.onChannelChange('HUMAN');
      c.begin(cause);
      if (c.pending) c.onTurnComplete();
      m.onToolAccepted('escalate_to_human', { reason: 'x', context_summary: 'y' });
      m.onToolAccepted('record_outcome', { status: 'escalated' });
      log.push(event({ t: 'outcome.written', writer: 'tool_handler', status: 'escalated', skipped: false }));
      log.push(event({ t: 'turn.transcribed', speaker: 'agent', text: 'Thank you.', partial: false, redactable: false, isClosing: true }));
      m.onClosingTurnComplete('completed');
      assert.equal(inv20(log), true, cause);
      assert.equal(m.state.phase, 'DONE', cause);
      assert.equal(m.state.closingKind, 'escalation', cause);
    }
  });
});

describe('A-23: an immediate close after the closing phrase is not a failure', () => {
  const escalatedCall = () => {
    const { c, events } = coordinator();
    c.begin('readback_limit');
    c.onTurnComplete();
    return events.map((e) => event(e));
  };

  test('ten escalation calls dropped under a second after the closing: escalated 10 of 10, zero redials', () => {
    let escalated = 0;
    let redials = 0;
    for (let i = 0; i < 10; i++) {
      const queue = createWorkQueue({ requests: [request({ id: `SYN-REQ-${i}`, status: 'in_progress', attempts: 1 })] });
      const log = escalatedCall();
      // The link closes before record_outcome was written — the race ADR-015
      // describes, arriving from the other party's hand on the receiver.
      const evidence = { escalationEvidenced: escalationEvidencedIn(log, 'Routine') };
      queue.resolveOnClose(`SYN-REQ-${i}`, evidence);
      if (queue.get(`SYN-REQ-${i}`)!.status === 'escalated') escalated++;
      if (queue.scheduleRedial(`SYN-REQ-${i}`)) redials++;
    }
    assert.equal(escalated, 10);
    assert.equal(redials, 0, 'an escalated request was redialed');
  });

  test('the mismatch re-entry path too: deterministic summary, then a drop', () => {
    const { c, events } = coordinator();
    c.begin('auth_number_mismatch');
    const log = events.map((e) => event(e));
    const queue = createWorkQueue({ requests: [request({ status: 'in_progress', attempts: 1 })] });
    queue.resolveOnClose('SYN-REQ-1', { escalationEvidenced: escalationEvidencedIn(log, 'Routine') });
    assert.equal(queue.get('SYN-REQ-1')!.status, 'escalated');
  });

  test('without a summary in the log the same drop is NOT escalated — the evidence is what decides', () => {
    const queue = createWorkQueue({ requests: [request({ status: 'in_progress', attempts: 3 })] });
    queue.resolveOnClose('SYN-REQ-1', { escalationEvidenced: escalationEvidencedIn([], 'Routine') });
    assert.equal(queue.get('SYN-REQ-1')!.status, 'failed');
  });

  test('urgencyOf reads the request, not the summary', () => {
    assert.equal(urgencyOf({ priority: 'expedited' }), 'EXPEDITED');
    assert.equal(urgencyOf({ priority: 'routine' }), 'Routine');
  });
});
