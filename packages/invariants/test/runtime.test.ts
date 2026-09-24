/**
 * Acceptance criteria for module 1.5 (§21 week 1):
 *   "INV-1 to INV-21 implemented; all run against a hand-built fixture;
 *    violations emitted, never repaired"
 *
 * Two halves, and the second matters more. The correct calls must pass every
 * invariant — and each invariant must FAIL on a log crafted to break it. §16.1:
 * "a metric that cannot fail is not a metric". An invariant that no mutation
 * can turn red is not checking anything.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { CallEventBody } from '@holdharmless/events';
import { INVARIANTS, checkInvariants, isReportable, type InvariantContext } from '../src/index.js';
import {
  APPROVED, ESCALATED, build, call, request,
  indexOf, replaceAt, insertAfter, removeAt, type Step,
} from './fixtures.js';

const ctxOf = (steps: readonly Step[], priority: 'routine' | 'expedited' = 'routine', extra: Partial<InvariantContext> = {}): InvariantContext => ({
  call: call(),
  request: request({ priority }),
  log: build(steps),
  ...extra,
});

const approved = () => ctxOf(APPROVED, 'routine');
const escalated = () => ctxOf(ESCALATED, 'expedited');

function failures(ctx: InvariantContext): string[] {
  return checkInvariants(ctx).map((r) => r.id);
}

function assertFails(ctx: InvariantContext, id: string): void {
  const result = checkInvariants(ctx).find((r) => r.id === id);
  assert.ok(result, `${id} should have failed on this mutation, but it passed`);
}

describe('the invariant set', () => {
  test('all 21 are implemented, once each, with a documented moment', () => {
    const ids = INVARIANTS.map((i) => i.id);
    assert.deepEqual(ids, Array.from({ length: 21 }, (_, n) => `INV-${n + 1}`));
    for (const inv of INVARIANTS) {
      assert.ok(['transition', 'call-end', 'replay'].includes(inv.when), inv.id);
      assert.ok(inv.description.length > 40, `${inv.id} needs a real description`);
    }
  });
});

describe('correct calls pass every invariant', () => {
  test('call A — approved via a queue hold and read-back', () => {
    assert.deepEqual(checkInvariants(approved()), []);
  });

  test('call B — escalated after an announced transfer to a second party', () => {
    assert.deepEqual(checkInvariants(escalated()), []);
  });

  test('violations are reported, never repaired — the log is untouched', () => {
    const ctx = ctxOf(replaceAt(APPROVED, 2, { ...(APPROVED[2]!.body as object), to: 'open' } as CallEventBody));
    const before = JSON.stringify(ctx.log);
    checkInvariants(ctx);
    assert.equal(JSON.stringify(ctx.log), before);
  });
});

describe('each invariant fails on a log crafted to break it', () => {
  test('INV-1 — a gate that does not match the derivation', () => {
    // IVR in dtmf mode derives dtmf_only; this sets it open.
    assertFails(ctxOf(replaceAt(APPROVED, 2, { ...(APPROVED[2]!.body as object), to: 'open' } as CallEventBody)), 'INV-1');
  });

  test('INV-1 — an action taken under a stale gate', () => {
    // Drop the gate.changed that opens the line for the representative.
    const i = indexOf(APPROVED, (b) => b.t === 'gate.changed' && b.to === 'open');
    assertFails(ctxOf(removeAt(APPROVED, i)), 'INV-1');
  });

  test('INV-2 — DTMF sent after the gate has closed', () => {
    const i = indexOf(APPROVED, (b) => b.t === 'gate.changed' && b.from === 'dtmf_only' && b.to === 'closed');
    assertFails(ctxOf(insertAfter(APPROVED, i, { t: 'dtmf.sent', digits: '0', reason: 'operator' })), 'INV-2');
  });

  test('INV-2 — the harness heard the agent during hold', () => {
    const i = indexOf(APPROVED, (b) => b.t === 'harness.telemetry' && b.metric === 'agent_speech_during_hold_ms');
    assertFails(ctxOf(replaceAt(APPROVED, i, { t: 'harness.telemetry', metric: 'agent_speech_during_hold_ms', value: 140 })), 'INV-2');
  });

  test('INV-3 — dtmf_only -> closed without a clear (the case transport 1.3 missed)', () => {
    const i = indexOf(APPROVED, (b) => b.t === 'gate.changed' && b.from === 'dtmf_only' && b.to === 'closed');
    assertFails(ctxOf(replaceAt(APPROVED, i, { ...(APPROVED[i]!.body as object), clearSent: false } as CallEventBody)), 'INV-3');
  });

  test('INV-4 — a recovery reply requested during hold', () => {
    const i = indexOf(APPROVED, (b) => b.t === 'channel.changed' && b.to === 'HOLD');
    assertFails(ctxOf(insertAfter(APPROVED, i, { t: 'reply.requested', cause: 'silence_recovery', produces: 'speech' })), 'INV-4');
  });

  test('INV-4 — no cause is exempt during hold, escalation included', () => {
    // Until v1.3 one 'hold_probe' was exempt. It was removed (§6.7), and the
    // type no longer admits that cause — so the only way to test the old hole is
    // to show that every remaining cause is refused.
    const i = indexOf(APPROVED, (b) => b.t === 'channel.changed' && b.to === 'HOLD');
    assertFails(ctxOf(insertAfter(APPROVED, i, { t: 'reply.requested', cause: 'escalation_instruction', produces: 'speech' })), 'INV-4');
  });

  test('INV-4 — a DTMF re-prompt passes a dtmf_only gate, and a spoken one does not', () => {
    // §5.7's decision of 2026-09-23, which INV-4 did not carry until module 3.7.
    // IVR silence recovery is a reply whose effect is send_dtmf, requested where
    // the gate is dtmf_only: permitted. The same reply producing SPEECH there is
    // the hold probe's mistake wearing a different hat.
    const i = indexOf(APPROVED, (b) => b.t === 'prompt.loaded' && b.files.includes('IVR_DTMF.txt'));
    const dtmf = ctxOf(insertAfter(APPROVED, i, { t: 'reply.requested', cause: 'silence_recovery', produces: 'dtmf' }));
    assert.ok(!failures(dtmf).includes('INV-4'), 'a DTMF reply at a dtmf_only gate is what §5.7 asks for');
    assertFails(ctxOf(insertAfter(APPROVED, i, { t: 'reply.requested', cause: 'silence_recovery', produces: 'speech' })), 'INV-4');
  });

  test('INV-5 — three silence re-prompts where §5.7 allows two', () => {
    const i = indexOf(APPROVED, (b) => b.t === 'disclosure.delivered');
    const r: CallEventBody = { t: 'reply.requested', cause: 'silence_recovery', produces: 'speech' };
    assertFails(ctxOf(insertAfter(APPROVED, i, r, r, r)), 'INV-5');
  });

  test('INV-6 — hedge and disclosure in one prompt', () => {
    const i = indexOf(APPROVED, (b) => b.t === 'prompt.loaded' && b.hedged);
    assertFails(ctxOf(replaceAt(APPROVED, i, {
      t: 'prompt.loaded', files: ['PARTY_HEDGE.txt', 'EXCHANGE.txt', 'DISCLOSURE.txt'], hedged: true, disclosureIncluded: true, substitutions: [],
    })), 'INV-6');
  });

  test('INV-6 — back from a transfer without the hedge', () => {
    const i = indexOf(ESCALATED, (b) => b.t === 'prompt.loaded' && b.hedged);
    assertFails(ctxOf(replaceAt(ESCALATED, i, {
      t: 'prompt.loaded', files: ['EXCHANGE.txt', 'DISCLOSURE.txt'], hedged: false, disclosureIncluded: true, substitutions: [],
    }), 'expedited'), 'INV-6');
  });

  test('INV-7 — fewer disclosures than the harness used parties', () => {
    const i = indexOf(ESCALATED, (b) => b.t === 'harness.telemetry' && b.metric === 'parties_used');
    assertFails(ctxOf(replaceAt(ESCALATED, i, { t: 'harness.telemetry', metric: 'parties_used', value: 3 }), 'expedited'), 'INV-7');
  });

  test('INV-7 — no ground truth at all is a failure, not a pass', () => {
    const i = indexOf(APPROVED, (b) => b.t === 'harness.telemetry' && b.metric === 'parties_used');
    assertFails(ctxOf(removeAt(APPROVED, i)), 'INV-7');
  });

  test('INV-8 — a transfer that never reset disclosure', () => {
    const i = indexOf(ESCALATED, (b) => b.t === 'party.changed');
    assertFails(ctxOf(removeAt(ESCALATED, i), 'expedited'), 'INV-8');
  });

  test('INV-9 — escalated with a summary that fails §8.1', () => {
    let steps = removeAt(ESCALATED, indexOf(ESCALATED, (b) => b.t === 'escalation.summary'));
    const i = indexOf(steps, (b) => b.t === 'tool.called' && b.name === 'escalate_to_human');
    steps = replaceAt(steps, i, { t: 'tool.called', toolCallId: 'tc2', name: 'escalate_to_human', args: { reason: 'x', context_summary: 'Needs clinical staff.' } });
    assertFails(ctxOf(steps, 'expedited'), 'INV-9');
  });

  test('INV-9 — a summary whose urgency contradicts the request', () => {
    // The log says EXPEDITED; the request is routine.
    assertFails(ctxOf(ESCALATED, 'routine'), 'INV-9');
  });

  test('INV-10 — record_outcome accepted after a final status', () => {
    const i = indexOf(APPROVED, (b) => b.t === 'outcome.written');
    assertFails(ctxOf(insertAfter(APPROVED, i,
      { t: 'tool.called', toolCallId: 'tc9', name: 'record_outcome', args: { status: 'approved' } },
      { t: 'tool.returned', toolCallId: 'tc9', name: 'record_outcome', result: { ok: true }, latencyMs: 1 },
    )), 'INV-10');
  });

  test('INV-12 — an NPI that passes the check digit could be real', () => {
    assertFails({ ...approved(), request: request({ providerNpi: '1234567893' }) }, 'INV-12');
  });

  test('INV-12 — a phone number outside the fictional range', () => {
    assertFails({ ...approved(), request: request({ clinicCallbackPhone: '212-555-0842' }) }, 'INV-12');
  });

  test('INV-13 — the phase moved on an acoustic observation', () => {
    const i = indexOf(APPROVED, (b) => b.t === 'phase.changed' && b.to === 'READBACK');
    assertFails(ctxOf(replaceAt(APPROVED, i, { t: 'phase.changed', from: 'EXCHANGE', to: 'READBACK', producer: { kind: 'acoustic', seq: 1 } })), 'INV-13');
  });

  test('INV-14 — a tool call with no outcome', () => {
    const i = indexOf(APPROVED, (b) => b.t === 'tool.returned' && b.toolCallId === 'tc2');
    assertFails(ctxOf(removeAt(APPROVED, i)), 'INV-14');
  });

  test('INV-15 — a safety violation paired with a state_not_allowed rejection', () => {
    const i = indexOf(APPROVED, (b) => b.t === 'channel.changed' && b.to === 'HOLD');
    assertFails(ctxOf(insertAfter(APPROVED, i,
      { t: 'tool.called', toolCallId: 'tc8', name: 'record_outcome', args: { status: 'approved' } },
      { t: 'tool.rejected', toolCallId: 'tc8', name: 'record_outcome', reason: 'state_not_allowed', detail: 'not permitted in HOLD' },
      { t: 'safety.violation', kind: 'auth_number_mismatch', detail: 'x', toolCallId: 'tc8' },
    )), 'INV-15');
  });

  test('INV-16 — a log with no profile in force', () => {
    assertFails(ctxOf(removeAt(APPROVED, 0)), 'INV-16');
  });

  test('INV-18 — a second writer overwrites a final status', () => {
    const i = indexOf(APPROVED, (b) => b.t === 'outcome.written');
    assertFails(ctxOf(insertAfter(APPROVED, i, { t: 'outcome.written', writer: 'call_model', status: 'failed', skipped: false })), 'INV-18');
  });

  test('INV-19 — recorded as failed despite escalation evidence', () => {
    const i = indexOf(ESCALATED, (b) => b.t === 'outcome.written');
    assertFails(ctxOf(replaceAt(ESCALATED, i, { t: 'outcome.written', writer: 'call_model', status: 'failed', skipped: false }), 'expedited'), 'INV-19');
  });

  test('INV-19 — the link dropped and escalated was never written', () => {
    const i = indexOf(ESCALATED, (b) => b.t === 'outcome.written');
    let steps = removeAt(ESCALATED, i);
    steps = insertAfter(steps, indexOf(steps, (b) => b.t === 'escalation.summary'), { t: 'call.dropped', cause: 'link_drop' });
    assertFails(ctxOf(steps, 'expedited'), 'INV-19');
  });

  test('INV-20 — the agent closed before the outcome was written', () => {
    const closing = indexOf(APPROVED, (b) => b.t === 'turn.transcribed' && b.isClosing);
    const body = APPROVED[closing]!.body;
    const outcomeCall = indexOf(APPROVED, (b) => b.t === 'tool.called' && b.name === 'record_outcome');
    const steps = removeAt(APPROVED, closing);
    assertFails(ctxOf([...steps.slice(0, outcomeCall), { ms: 324900, body }, ...steps.slice(outcomeCall)]), 'INV-20');
  });

  test('INV-21 — a transition with no §5.3 row for its producer', () => {
    // HOLD -> HUMAN is produced by a semantic observation, never an acoustic one.
    const i = indexOf(APPROVED, (b) => b.t === 'channel.changed' && b.from === 'HOLD' && b.to === 'HUMAN');
    assertFails(ctxOf(replaceAt(APPROVED, i, { t: 'channel.changed', from: 'HOLD', to: 'HUMAN', producer: { kind: 'acoustic', seq: 1 } })), 'INV-21');
  });

  test('INV-11 and INV-17 read the static tables; their failure modes are proved in static.test.ts', () => {
    const replayOnly = INVARIANTS.filter((i) => i.id === 'INV-11' || i.id === 'INV-17');
    for (const inv of replayOnly) assert.equal(inv.when, 'replay');
  });

  test('every mutation above produced a failure the correct call did not have', () => {
    // A guard against a mutation that trips a DIFFERENT invariant only by accident:
    // the base calls are clean, so any failure in a mutated call was introduced.
    assert.deepEqual(failures(approved()), []);
    assert.deepEqual(failures(escalated()), []);
  });
});

describe('isReportable (INV-16, reporting half)', () => {
  test('a TELEPHONY call is reportable', () => {
    assert.equal(isReportable(approved().log), true);
  });

  test('a call whose metrics were produced under CLEAN is not', () => {
    const steps = replaceAt(APPROVED, 0, { t: 'call.started', requestId: 'req-1', attempts: 0, priority: 'routine', networkProfile: 'CLEAN' });
    assert.equal(isReportable(build(steps)), false);
  });
});
