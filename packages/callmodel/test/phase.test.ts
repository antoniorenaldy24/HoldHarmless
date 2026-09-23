/**
 * Acceptance criteria for module 3.2 (§21 week 3):
 *   "capture_auth_number and confirm_readback drive every phase transition;
 *    readbackAttempts has one writer; phase timeouts route to escalation"
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CallEventBody, ToolName } from '@holdharmless/events';
import { POSITION_POLICY, READBACK_ATTEMPT_LIMIT, createPhaseMachine, positionId, type PhaseState } from '../src/index.js';

type PhaseEvent = Extract<CallEventBody, { t: 'phase.changed' }>;

function setup(initial?: Partial<PhaseState>) {
  const events: CallEventBody[] = [];
  const escalations: string[] = [];
  const m = createPhaseMachine({
    emit: (e) => events.push(e),
    onEscalation: (cause) => escalations.push(cause),
    ...(initial ? { initial } : {}),
  });
  const phases = () => events.filter((e): e is PhaseEvent => e.t === 'phase.changed');
  return { m, events, escalations, phases };
}

/** A call that has reached a representative and is exchanging information. */
const exchanging = () => {
  const s = setup();
  s.m.onChannelChange('HUMAN');
  return s;
};

describe('the §5.4 table, row by row', () => {
  test('NOT_STARTED to EXCHANGE, when the channel first becomes HUMAN', () => {
    const { m, phases } = setup();
    m.onChannelChange('HUMAN');
    assert.equal(m.state.phase, 'EXCHANGE');
    assert.deepEqual(phases().map((e) => [e.from, e.to]), [['NOT_STARTED', 'EXCHANGE']]);
  });

  test('a later return to HUMAN does not move the phase back (INV-13)', () => {
    const { m } = exchanging();
    m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    m.onChannelChange('HOLD');
    m.onChannelChange('HUMAN');
    assert.equal(m.state.phase, 'READBACK', 'the phase rode along, as §5.3 requires');
  });

  test('EXCHANGE to READBACK, by capture_auth_number, storing the value', () => {
    const { m, phases } = exchanging();
    m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    assert.equal(m.state.phase, 'READBACK');
    assert.equal(m.state.capturedAuthNumber, 'A472-91');
    assert.equal(phases().at(-1)!.producer.kind, 'tool');
  });

  test('READBACK to CLOSING wrapup, by confirm_readback(true)', () => {
    const { m, phases } = exchanging();
    m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    m.onToolAccepted('confirm_readback', { matched: true });
    assert.equal(m.state.phase, 'CLOSING');
    assert.equal(m.state.closingKind, 'wrapup');
    assert.equal(phases().at(-1)!.closingKind, 'wrapup');
  });

  test('READBACK to EXCHANGE, by confirm_readback(false), counting the attempt', () => {
    const { m } = exchanging();
    m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    m.onToolAccepted('confirm_readback', { matched: false, corrected_value: 'A473-91' });
    assert.equal(m.state.phase, 'EXCHANGE');
    assert.equal(m.state.readbackAttempts, 1);
    assert.equal(m.state.capturedAuthNumber, 'A473-91', 'a correction always outranks what was believed (READBACK.txt)');
  });

  test('any to CLOSING escalation, by escalate_to_human, from either working phase', () => {
    for (const reachReadback of [false, true]) {
      const { m, escalations } = exchanging();
      if (reachReadback) m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
      m.onToolAccepted('escalate_to_human', { reason: 'clinical', context_summary: 'Routine. ...' });
      assert.equal(m.state.phase, 'CLOSING');
      assert.equal(m.state.closingKind, 'escalation');
      assert.deepEqual(escalations, ['tool']);
    }
  });

  test('any to DONE, when the channel becomes CLOSED', () => {
    const { m, phases } = exchanging();
    m.onChannelChange('CLOSED');
    assert.equal(m.state.phase, 'DONE');
    assert.equal(phases().at(-1)!.producer.kind, 'transport');
  });
});

describe('readbackAttempts has exactly one writer (§5.4)', () => {
  test('only confirm_readback(false) increments it', () => {
    const { m } = exchanging();
    m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    const others: [ToolName, Record<string, unknown>][] = [
      ['capture_reference', { reference: 'REF-1' }],
      ['notify_transfer', { destination: 'utilization management' }],
      ['record_outcome', { status: 'call_failed' }],
      ['confirm_readback', { matched: true }],
    ];
    for (const [name, args] of others) {
      const before = m.state.readbackAttempts;
      m.onToolAccepted(name, args);
      assert.equal(m.state.readbackAttempts, before, `${name} wrote readbackAttempts`);
    }
  });

  test('neither a phase timeout nor a channel change writes it', () => {
    const { m } = exchanging();
    m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    m.addHumanTime(POSITION_POLICY[positionId('HUMAN', 'READBACK')]!.phaseTimeoutMs!);
    m.onChannelChange('HOLD');
    m.onChannelChange('HUMAN');
    assert.equal(m.state.readbackAttempts, 0);
  });

  test('the third failed attempt escalates instead of returning to EXCHANGE', () => {
    const { m, escalations, phases } = exchanging();
    m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    for (let i = 1; i <= READBACK_ATTEMPT_LIMIT; i++) {
      if (m.state.phase === 'EXCHANGE') m.onToolAccepted('capture_auth_number', { value: `A472-9${i}` });
      m.onToolAccepted('confirm_readback', { matched: false, corrected_value: `A47${i}-91` });
    }
    assert.equal(m.state.readbackAttempts, READBACK_ATTEMPT_LIMIT);
    assert.equal(m.state.phase, 'CLOSING');
    assert.equal(m.state.closingKind, 'escalation');
    assert.deepEqual(escalations, ['readback_limit']);
    assert.ok(phases().some((e) => e.from === 'READBACK' && e.to === 'EXCHANGE'), 'the earlier attempts did return to EXCHANGE');
  });
});

describe('phase timeouts route to escalation (§5.4 backstop)', () => {
  test('EXCHANGE times out on accumulated HUMAN time and escalates', () => {
    const { m, escalations, phases } = exchanging();
    const limit = POSITION_POLICY[positionId('HUMAN', 'EXCHANGE')]!.phaseTimeoutMs!;
    m.addHumanTime(limit - 1);
    assert.equal(m.state.phase, 'EXCHANGE', 'one millisecond short is not a timeout');
    m.addHumanTime(1);
    assert.equal(m.state.phase, 'CLOSING');
    assert.equal(m.state.closingKind, 'escalation');
    assert.deepEqual(escalations, ['phase_timeout']);
    assert.equal(phases().at(-1)!.producer.kind, 'timer');
  });

  test('the budget is HUMAN time, so a long hold spends none of it (§5.4)', () => {
    const { m } = exchanging();
    const limit = POSITION_POLICY[positionId('HUMAN', 'EXCHANGE')]!.phaseTimeoutMs!;
    m.addHumanTime(limit - 1000);
    m.onChannelChange('HOLD');
    // Twenty minutes of hold: the Call Model adds no human time during it.
    m.onChannelChange('HUMAN');
    assert.equal(m.state.phase, 'EXCHANGE');
    assert.equal(m.state.humanChannelMs, limit - 1000);
  });

  test('READBACK has its own, shorter budget', () => {
    const { m, escalations } = exchanging();
    m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    m.addHumanTime(POSITION_POLICY[positionId('HUMAN', 'READBACK')]!.phaseTimeoutMs!);
    assert.equal(m.state.phase, 'CLOSING');
    assert.deepEqual(escalations, ['phase_timeout']);
  });

  test('CLOSING does not time out into DONE — only §5.4\'s two conditions end a call', () => {
    const { m, escalations } = exchanging();
    m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    m.onToolAccepted('confirm_readback', { matched: true });
    const before = escalations.length;
    m.addHumanTime(POSITION_POLICY[positionId('HUMAN', 'CLOSING')]!.phaseTimeoutMs! * 10);
    assert.equal(m.state.phase, 'CLOSING');
    // And no escalation is reported: a call already in CLOSING has nothing to
    // escalate, and a spurious one would put a summary on a finished call.
    assert.equal(escalations.length, before, 'a CLOSING timeout reported an escalation');
  });

  test('a call already in DONE is not escalated by a late tick', () => {
    const { m, escalations } = exchanging();
    m.onChannelChange('CLOSED');
    m.addHumanTime(POSITION_POLICY[positionId('HUMAN', 'EXCHANGE')]!.phaseTimeoutMs! * 2);
    assert.equal(m.state.phase, 'DONE');
    assert.deepEqual(escalations, []);
  });
});

describe('CLOSING to DONE needs both conditions, in either order (§5.4, ADR-015)', () => {
  const inClosing = () => {
    const s = exchanging();
    s.m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    s.m.onToolAccepted('confirm_readback', { matched: true });
    return s;
  };

  test('record_outcome alone does not end the call', () => {
    const { m } = inClosing();
    m.onToolAccepted('record_outcome', { status: 'approved', auth_number: 'A472-91' });
    assert.equal(m.state.outcomeWritten, true);
    assert.equal(m.state.phase, 'CLOSING', 'accepting the tool ended the call — the ADR-015 race');
  });

  test('a completed closing turn alone does not end the call either', () => {
    const { m } = inClosing();
    m.onClosingTurnComplete('completed');
    assert.equal(m.state.phase, 'CLOSING');
  });

  test('outcome first, then the closing turn: DONE, produced by reply.done', () => {
    const { m, phases } = inClosing();
    m.onToolAccepted('record_outcome', { status: 'approved', auth_number: 'A472-91' });
    m.onClosingTurnComplete('completed');
    assert.equal(m.state.phase, 'DONE');
    const done = phases().at(-1)!;
    assert.deepEqual([done.from, done.to], ['CLOSING', 'DONE']);
    assert.deepEqual(done.producer, { kind: 'session', event: 'reply.done' });
  });

  test('closing turn first, then the outcome: DONE as well — the §5.7 after-limit path', () => {
    // The Call Model writes the outcome deterministically after the closing
    // re-prompt limit. Without the latch that write would land in a call that
    // had already spoken its closing and could never finish.
    const { m, phases } = inClosing();
    m.onClosingTurnComplete('completed');
    m.onToolAccepted('record_outcome', { status: 'call_failed' });
    assert.equal(m.state.phase, 'DONE');
    assert.deepEqual(phases().at(-1)!.producer, { kind: 'session', event: 'reply.done' });
  });

  test('an interrupted closing turn is not a closing: the far end cut in', () => {
    const { m } = inClosing();
    m.onToolAccepted('record_outcome', { status: 'call_failed' });
    m.onClosingTurnComplete('interrupted');
    assert.equal(m.state.phase, 'CLOSING');
    m.onClosingTurnComplete('completed');
    assert.equal(m.state.phase, 'DONE');
  });

  test('a closing turn completed before the phase reached CLOSING does not end it early', () => {
    const { m } = exchanging();
    m.onClosingTurnComplete('completed'); // a stray, mid-exchange
    m.onToolAccepted('record_outcome', { status: 'call_failed' });
    assert.equal(m.state.phase, 'EXCHANGE');
  });
});

describe('tools that are not phase producers', () => {
  test('send_dtmf, get_auth_request, capture_reference and notify_transfer move nothing', () => {
    const { m, phases } = exchanging();
    const before = phases().length;
    m.onToolAccepted('get_auth_request', { fields: ['member_id'] });
    m.onToolAccepted('capture_reference', { reference: 'REF-4417-B' });
    m.onToolAccepted('notify_transfer', { destination: 'utilization management' });
    m.onToolAccepted('send_dtmf', { digits: '3', reason: 'prior auth' });
    assert.equal(phases().length, before);
    assert.equal(m.state.phase, 'EXCHANGE');
  });

  test('capture_auth_number outside EXCHANGE stores the value without moving the phase', () => {
    // The handler already refuses it outside its allowlist; if it ever arrived,
    // it must not drag a CLOSING call back into READBACK.
    const { m } = exchanging();
    m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    m.onToolAccepted('confirm_readback', { matched: true });
    m.onToolAccepted('capture_auth_number', { value: 'B999-00' });
    assert.equal(m.state.phase, 'CLOSING');
    assert.equal(m.state.capturedAuthNumber, 'B999-00');
  });

  test('confirm_readback outside READBACK does nothing at all', () => {
    const { m } = exchanging();
    m.onToolAccepted('confirm_readback', { matched: false, corrected_value: 'X' });
    assert.equal(m.state.phase, 'EXCHANGE');
    assert.equal(m.state.readbackAttempts, 0);
  });
});
