/**
 * Panel 8's cards — §11, module 3.6.
 *
 * The panel itself is a few lines of React with no state; what can be wrong is
 * the reading of the log behind it, so that is what these tests are about.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthRequestStatus, CallEvent, CallEventBody } from '@holdharmless/events';
import { escalationCards } from '../src/index.js';

let seq = 0;
const ev = (callId: string, at: string, body: CallEventBody): CallEvent => ({ seq: seq++, callId, at, ...body });

const started = (callId: string, requestId: string, priority = 'routine', attempts = 1) =>
  ev(callId, '2026-09-24T10:00:00.000Z', { t: 'call.started', requestId, attempts, priority, networkProfile: 'TELEPHONY' });

const statuses = (map: Record<string, AuthRequestStatus>) => ({ statusOf: (id: string) => map[id] });

describe('panel 8 reads the log', () => {
  test('a deterministic escalation produces a card, tool call or not', () => {
    // The paths that may NOT ask the model — a read-back limit, a timeout, a
    // mismatch — are exactly the ones a tool-call-only projection would miss.
    const events = [
      started('C1', 'R1'),
      ev('C1', '2026-09-24T10:04:00.000Z', { t: 'escalation.summary', source: 'deterministic', urgency: 'Routine', summary: 'Routine. Read-back failed three times.' }),
    ];
    const [card] = escalationCards(events, statuses({ R1: 'escalated' }));
    assert.equal(card?.source, 'deterministic');
    assert.equal(card?.requestId, 'R1');
    assert.match(card!.summary!, /Read-back failed three times/);
    assert.equal(card?.resolved, false);
  });

  test('a summary rewritten by tier 2 replaces the one INV-9 rejected', () => {
    const events = [
      started('C1', 'R1'),
      ev('C1', '2026-09-24T10:04:00.000Z', { t: 'escalation.summary', source: 'model', urgency: 'Routine', summary: 'they need a call back' }),
      ev('C1', '2026-09-24T10:04:02.000Z', { t: 'escalation.summary', source: 'deterministic', urgency: 'EXPEDITED', summary: 'EXPEDITED. The representative asked about the induction protocol.' }),
    ];
    const cards = escalationCards(events, statuses({ R1: 'escalated' }));
    assert.equal(cards.length, 1, 'one call, one card');
    assert.equal(cards[0]?.source, 'deterministic');
    assert.equal(cards[0]?.urgency, 'EXPEDITED');
    assert.match(cards[0]!.summary!, /induction protocol/);
  });

  test('escalate_to_human with no summary is a card that says the summary is missing', () => {
    // INV-9 is violated here. Dropping the card would make the panel agree with
    // the bug: somebody is waiting for a call back and the screen is empty.
    const events = [
      started('C1', 'R1', 'expedited'),
      ev('C1', '2026-09-24T10:05:00.000Z', { t: 'tool.called', toolCallId: 't1', name: 'escalate_to_human', args: {} }),
    ];
    const [card] = escalationCards(events, statuses({ R1: 'escalated' }));
    assert.ok(card, 'the card exists');
    assert.equal(card.summary, undefined);
    assert.equal(card.urgency, 'EXPEDITED', 'the urgency still comes from the request');
  });

  test('a reference taken on an earlier call of the same request shows on the card', () => {
    // This is A-16's mechanism seen from the panel: the reference belongs to the
    // request, so the call that dropped still helps the person reading this.
    const events = [
      started('C1', 'R1'),
      ev('C1', '2026-09-24T10:02:00.000Z', { t: 'reference.captured', reference: 'REF-99', kind: 'call_reference' }),
      started('C2', 'R1', 'routine', 2),
      ev('C2', '2026-09-24T10:20:00.000Z', { t: 'auth_number.captured', value: 'A472-91' }),
      ev('C2', '2026-09-24T10:22:00.000Z', { t: 'escalation.summary', source: 'deterministic', urgency: 'Routine', summary: 'Routine. Mismatch on the recorded number.' }),
    ];
    const [card] = escalationCards(events, statuses({ R1: 'escalated' }));
    assert.equal(card?.reference, 'REF-99');
    assert.equal(card?.authNumber, 'A472-91');
    assert.equal(card?.attempts, 2);
  });

  test('"mark handled" is what makes a card resolved, and nothing else', () => {
    const events = [
      started('C1', 'R1'),
      ev('C1', '2026-09-24T10:04:00.000Z', { t: 'escalation.summary', source: 'model', urgency: 'Routine', summary: 'Routine. Call back needed.' }),
    ];
    assert.equal(escalationCards(events, statuses({ R1: 'escalated' }))[0]?.resolved, false);
    assert.equal(escalationCards(events, statuses({ R1: 'escalated_resolved' }))[0]?.resolved, true);
  });

  test('unhandled before handled, expedited before routine, newest first', () => {
    const events = [
      started('C1', 'R1', 'routine'),
      ev('C1', '2026-09-24T09:00:00.000Z', { t: 'escalation.summary', source: 'model', urgency: 'Routine', summary: 'old routine' }),
      started('C2', 'R2', 'expedited'),
      ev('C2', '2026-09-24T10:00:00.000Z', { t: 'escalation.summary', source: 'model', urgency: 'EXPEDITED', summary: 'urgent' }),
      started('C3', 'R3', 'routine'),
      ev('C3', '2026-09-24T11:00:00.000Z', { t: 'escalation.summary', source: 'model', urgency: 'Routine', summary: 'new routine' }),
      started('C4', 'R4', 'expedited'),
      ev('C4', '2026-09-24T12:00:00.000Z', { t: 'escalation.summary', source: 'model', urgency: 'EXPEDITED', summary: 'urgent but handled' }),
    ];
    const order = escalationCards(events, statuses({ R1: 'escalated', R2: 'escalated', R3: 'escalated', R4: 'escalated_resolved' }))
      .map((c) => c.summary);
    assert.deepEqual(order, ['urgent', 'new routine', 'old routine', 'urgent but handled']);
  });

  test('an empty log produces no cards, not a card with nothing in it', () => {
    assert.deepEqual(escalationCards([], statuses({})), []);
  });
});
