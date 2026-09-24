/**
 * A-22 — the far end goes silent without closing, at EVERY position. Module 3.7.
 *
 *   "Harness goes silent without closing, at every position. Every call ends
 *    where §5.7 specifies."
 *
 * The failure this exists to prevent has no symptom of its own: the far end
 * stops talking, the agent waits for a turn that never comes, and the call sits
 * open until something else kills it. Nothing is logged as wrong, the request
 * never reaches a result, and the clinic is billed for the session.
 *
 * The table in §5.7 is the specification, so it is read here as data rather
 * than retyped: the last test walks every position that has a policy and
 * asserts the observable ending matches the `afterLimit` its row declares. A
 * position added to the table with no ending fails that test rather than
 * silently going unrecovered.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CallEventBody, Channel, DropCause, NavMode, Phase, ReplyProduct } from '@holdharmless/events';
import { gateAdmitsProduct } from '@holdharmless/events';
import { POSITION_POLICY, allPositions, createPhaseMachine, gateFor, parsePositionId } from '@holdharmless/callmodel';
import { createSilenceRecovery, MAX_HOLD_RAMP_STEPS } from '../src/index.js';

type Setup = {
  channel?: Channel;
  phase?: Phase;
  navMode?: NavMode;
  disclosed?: boolean;
  holdSuspected?: boolean;
  /** Refuse the reply, as the session does on ADR-022's conditions. */
  refuseReplies?: boolean;
};

function setup(over: Setup = {}) {
  const events: CallEventBody[] = [];
  const replies: { produces: ReplyProduct; instruction: string }[] = [];
  /** Every ASK, including the ones the gate refused. §5.7 forbids the asking. */
  const attempts: { produces: ReplyProduct }[] = [];
  const ramps: number[] = [];
  const closes: DropCause[] = [];
  const outcomes: string[] = [];

  const pos = {
    channel: over.channel ?? 'HUMAN',
    phase: over.phase ?? 'EXCHANGE',
    navMode: over.navMode ?? ('dtmf' as NavMode),
    holdSuspected: over.holdSuspected ?? false,
    disclosedToCurrentParty: over.disclosed ?? true,
  };

  const phase = createPhaseMachine({ emit: (e) => events.push(e), initial: { phase: pos.phase } });
  const recovery = createSilenceRecovery({
    position: () => pos,
    emit: (e) => events.push(e),
    rePrompt: (produces, instruction) => {
      attempts.push({ produces });
      // The session's own ADR-022 check, applied here too: a recovery reply the
      // gate would not admit never reaches the wire, so it is never counted.
      const gate = gateFor(pos.channel, pos.holdSuspected, pos.navMode);
      if (over.refuseReplies || !gateAdmitsProduct(gate, produces)) return false;
      replies.push({ produces, instruction });
      return true;
    },
    rampHoldSensitivity: (step) => ramps.push(step),
    close: (cause) => closes.push(cause),
    phase,
    writeOutcomeIfUnwritten: () => outcomes.push('written'),
  });

  /** Silence, in whole timeouts: enough ticks to cross any §5.7 timeout n times. */
  const beSilent = (times: number) => {
    for (let i = 0; i < times; i++) recovery.tick(8000);
  };

  return { recovery, replies, attempts, ramps, closes, outcomes, events, phase, pos, beSilent };
}

describe('the silence clock', () => {
  test('a re-prompt waits for the position timeout, not for a tick', () => {
    const s = setup({ channel: 'HUMAN', phase: 'CLOSING', disclosed: true });
    s.recovery.tick(500);
    s.recovery.tick(500);
    assert.deepEqual(s.replies, [], '1000 ms is not yet the 2000 ms CLOSING timeout');
    s.recovery.tick(1000);
    assert.equal(s.replies.length, 1);
  });

  test('HUMAN/EXCHANGE waits less before the party has been told', () => {
    // 2500 ms undisclosed against 3000 ms disclosed. The shorter wait is for the
    // person who has heard nothing at all and has no reason to hold on.
    const quiet = setup({ disclosed: false });
    quiet.recovery.tick(2600);
    assert.equal(quiet.replies.length, 1);
    assert.match(quiet.replies[0]!.instruction, /Deliver the opening again/);

    const told = setup({ disclosed: true });
    told.recovery.tick(2600);
    // Length, not deepEqual([]): deepEqual against a literal empty array narrows
    // the array to never[] for the rest of the test, and the next line reads it.
    assert.equal(told.replies.length, 0, 'the disclosed timeout is 3000 ms');
    told.recovery.tick(500);
    assert.equal(told.replies.length, 1);
    assert.match(told.replies[0]!.instruction, /Offer the next item/);
  });

  test('the far end speaking resets the clock but not the count', () => {
    const s = setup();
    s.recovery.tick(3100);
    assert.equal(s.replies.length, 1);
    s.recovery.tick(2000);
    s.recovery.noteActivity();
    s.recovery.tick(2000);
    assert.equal(s.replies.length, 1, 'the clock restarted');
    s.recovery.tick(1100);
    assert.equal(s.replies.length, 2, 'and the count carried over');
  });

  test('INV-5: the clock does not advance while hold is suspected', () => {
    // A-28's case. The line is quiet because the agent is on hold, and counting
    // that would hang up on a call that is going fine.
    //
    // THE ASSERTION THAT MATTERS IS THE LAST ONE, and the first version of this
    // test did not have it. Deleting the freeze left the test passing, because
    // the gate is `closed` while hold is suspected and the rig's rePrompt
    // refuses on that — so the test was proving the GATE works, not the
    // counter. What only the freeze can produce is this: when hold clears,
    // the position starts from zero, so a short silence is still short.
    const s = setup({ holdSuspected: true });
    s.beSilent(20);
    assert.equal(s.replies.length, 0);
    assert.equal(s.closes.length, 0);
    // The assertion the freeze alone can satisfy. Everything else here is
    // satisfied by the GATE, which refuses a reply while hold is suspected —
    // which is why deleting the freeze left the earlier version of this test
    // green. §5.7 forbids the recovery ACTION here, not merely its success, so
    // what must be true is that nothing was even asked for.
    assert.equal(s.attempts.length, 0, 'a reply was requested while hold was suspected; the gate refusing it is not the point');

    s.pos.holdSuspected = false;
    s.recovery.tick(500);
    assert.equal(s.replies.length, 0, '160 seconds of hold must not be spent as silence the moment it clears');
    s.recovery.tick(2600);
    assert.equal(s.replies.length, 1, 'and the position recovers normally from zero');
  });
});

describe('what each position does when nobody speaks (§5.7, A-22)', () => {
  test('IVR repeats navigation three times, then closes as unresponsive', () => {
    const s = setup({ channel: 'IVR', phase: 'NOT_STARTED', navMode: 'dtmf' });
    s.beSilent(3);
    assert.equal(s.replies.length, 3, '§5.7 allows 3× at IVR');
    assert.ok(s.replies.every((r) => r.produces === 'dtmf'), 'navigation is DTMF, not speech');
    assert.deepEqual(s.closes, []);
    s.beSilent(1);
    assert.deepEqual(s.closes, ['unresponsive'], 'exactly at the limit, not after another attempt');
  });

  test('an IVR re-prompt is DTMF because a spoken one would be discarded', () => {
    // The refinement §5.7 decided: the gate here is `dtmf_only`, ADR-022 asks
    // whether it admits what the reply PRODUCES, and DTMF passes. The rig above
    // applies the real rule, so a reply asking for speech here would be refused
    // and never counted — and the position would reach its limit with nothing
    // ever heard.
    const s = setup({ channel: 'IVR', phase: 'NOT_STARTED', navMode: 'dtmf' });
    s.beSilent(1);
    assert.equal(gateFor('IVR', false, 'dtmf'), 'dtmf_only');
    assert.equal(s.replies[0]?.produces, 'dtmf');
  });

  test('HUMAN/EXCHANGE offers twice, then closes as unresponsive', () => {
    const s = setup({ phase: 'EXCHANGE', disclosed: true });
    s.beSilent(2);
    assert.equal(s.replies.length, 2);
    assert.deepEqual(s.closes, []);
    s.beSilent(1);
    assert.deepEqual(s.closes, ['unresponsive']);
  });

  test('HUMAN/READBACK repeats twice, then escalates instead of hanging up', () => {
    // The one position whose after-limit is not a close. A read-back that never
    // came back is a number nobody confirmed, and dropping the call would leave
    // it unrecorded and unflagged.
    const s = setup({ phase: 'READBACK' });
    s.phase.onChannelChange('HUMAN');
    s.beSilent(2);
    assert.equal(s.replies.length, 2);
    s.beSilent(1);
    assert.deepEqual(s.closes, [], 'READBACK does not hang up');
    assert.equal(s.phase.state.phase, 'CLOSING');
    assert.equal(s.phase.state.closingKind, 'escalation');
    assert.equal(s.phase.state.readbackAttempts, 0, 'the silence limit is not a read-back attempt: that counter has one writer');
  });

  test('HUMAN/CLOSING continues twice, then writes the outcome so the call can finish', () => {
    const s = setup({ phase: 'CLOSING' });
    s.beSilent(2);
    assert.equal(s.replies.length, 2);
    s.beSilent(1);
    assert.deepEqual(s.outcomes, ['written']);
    assert.deepEqual(s.closes, [], 'DONE comes from the latch, not from a hang-up');
  });

  test('HOLD raises sensitivity three times and then says nothing at all', () => {
    const s = setup({ channel: 'HOLD', phase: 'EXCHANGE' });
    s.beSilent(10);
    assert.deepEqual(s.ramps, [1, 2, 3], `§5.7 allows ${MAX_HOLD_RAMP_STEPS} steps`);
    assert.deepEqual(s.replies, [], 'the agent is silent for the whole of every hold');
    assert.deepEqual(s.closes, [], 'only HOLD_TIMEOUT_MS ends a hold');
  });

  test('TRANSFER does nothing whatsoever', () => {
    // Decided on 2026-09-23: the spoken question was removed because the gate is
    // always closed here, so it was billed and inaudible. Only
    // TRANSFER_TIMEOUT_MS ends the call.
    const s = setup({ channel: 'TRANSFER', phase: 'EXCHANGE' });
    s.beSilent(20);
    assert.deepEqual(s.replies, []);
    assert.deepEqual(s.ramps, []);
    assert.deepEqual(s.closes, []);
  });

  test('a reply the session refuses is not counted as a re-prompt', () => {
    // Otherwise the budget is spent on replies nobody heard, and the position
    // reaches its limit having never actually asked anything.
    //
    // The silence runs one tick PAST the limit on purpose: the after-limit
    // action fires on the timeout after the count reaches the limit, so a test
    // that stops at the limit cannot tell a counted refusal from an uncounted
    // one. That is how the first version of this test passed with the guard
    // deleted.
    const s = setup({ refuseReplies: true });
    s.beSilent(4);
    assert.equal(s.replies.length, 0);
    assert.equal(s.closes.length, 0, 'nothing was delivered, so the limit has not been reached');
  });
});

describe('A-22 across every position the table defines', () => {
  test('each one reaches the ending its §5.7 row declares, and none just sits there', () => {
    const covered: string[] = [];
    for (const id of allPositions()) {
      const policy = POSITION_POLICY[id];
      if (!policy?.silenceTimeoutMs) continue;
      const { channel, phase } = parsePositionId(id);
      // DONE positions have a policy but nothing to recover from.
      if (phase === 'DONE') continue;

      const s = setup({ channel, phase, navMode: 'dtmf', disclosed: true });
      if (channel === 'HUMAN') s.phase.onChannelChange('HUMAN');
      s.beSilent((policy.rePromptLimit ?? MAX_HOLD_RAMP_STEPS) + 2);

      const ending = policy.afterLimit;
      assert.ok(ending, `${id} has a silence timeout and no after-limit: the call would sit there`);
      switch (ending.kind) {
        case 'close':
          assert.deepEqual(s.closes, [ending.cause], `${id} should close as ${ending.cause}`);
          break;
        case 'phase':
          assert.deepEqual(s.closes, [], `${id} should not hang up`);
          if (ending.to === 'CLOSING') assert.equal(s.phase.state.phase, 'CLOSING', `${id} should escalate`);
          else assert.deepEqual(s.outcomes, ['written'], `${id} should write the outcome`);
          break;
        case 'await_timeout':
          assert.deepEqual(s.closes, [], `${id} waits for its channel timeout`);
          assert.deepEqual(s.replies, [], `${id} must not speak`);
          break;
      }
      covered.push(id);
    }
    // A sanity check on the sanity check: if the filter above ever stops
    // matching, this test would pass by testing nothing.
    assert.ok(covered.length >= 8, `only ${covered.length} positions were exercised: ${covered.join(', ')}`);
    assert.ok(covered.some((id) => id.startsWith('IVR/')), 'IVR was not covered');
    assert.ok(covered.includes('HUMAN/READBACK'), 'READBACK was not covered');
  });
});
