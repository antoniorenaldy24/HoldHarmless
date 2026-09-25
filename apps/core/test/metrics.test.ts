/**
 * §16.3's log derivations — module 4.2.
 *
 * These tests exist because the suite passed 606/606 with both of the metrics
 * here hard-wired to zero. §16.3 names `gate_false_close_count` and
 * `party_detection_miss_count` as derived from the event log; the view was
 * reading both out of `harness.telemetry`, which nothing sends. Panel 7 reported
 * 0 for each, on every call, and 0 is what a clean call reports — so the failure
 * looked exactly like success, and no test noticed because none existed.
 *
 * The bar for every case below: it must be possible for the number to be WRONG.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthRequest, CallEvent, CallEventBody } from '@holdharmless/events';
import { dashboardView, derivedMetrics, p90 } from '../src/index.js';

let seq = 0;
const T0 = Date.parse('2026-09-26T10:00:00.000Z');
const ev = (offsetMs: number, body: CallEventBody): CallEvent => ({
  seq: seq++,
  callId: 'CALL-M',
  at: new Date(T0 + offsetMs).toISOString(),
  ...body,
});
const reset = () => { seq = 0; };

/**
 * A semantic observation as the layer really emits one.
 *
 * Written out in full rather than cast. The first version of this helper used
 * `as never` and was wrong in three places: `windowsMs` belongs to the ACOUSTIC
 * observation, `sourceDelta` was missing, and `party.changed` carries `reason`
 * with one of three values, not a `cause` of `'transfer_phrase'`. Every test
 * below passed anyway, because the derivation does not read those fields — luck,
 * not coverage, and the next field it does read would have been the wrong one.
 */
const semantic = (winner: 'HOLD_CUE' | 'HUMAN', accepted = true): CallEventBody => ({
  t: 'semantic.observed',
  obs: {
    at: new Date(T0).toISOString(),
    seq,
    scores: winner === 'HOLD_CUE'
      ? { HOLD_CUE: 0.9, HUMAN: 0.05, IVR_PROMPT: 0.05 }
      : { HOLD_CUE: 0.05, HUMAN: 0.9, IVR_PROMPT: 0.05 },
    winner,
    confidence: 0.9,
    effectiveMinWeight: 0.5,
    signalsAvailable: ['holdCue'],
    sourceDelta: winner === 'HOLD_CUE' ? 'let me check' : 'so the member is active',
    accepted,
  },
});

/** §16.3 counts a party the core NOTICED; why it noticed is §5.5's business. */
const partyChanged = (newIndex: number): CallEventBody => ({
  t: 'party.changed', reason: 'transfer', newIndex,
});

const gate = (from: 'open' | 'closed', to: 'open' | 'closed', holdSuspected: boolean): CallEventBody => ({
  t: 'gate.changed', from, to, channel: 'HUMAN', holdSuspected, clearSent: to === 'closed',
  producer: { kind: 'semantic', seq: 1 },
});

// ---------------------------------------------------------------------------
// gate_false_close_count — the measured price of §6.3's eager list
// ---------------------------------------------------------------------------

describe('gate_false_close_count (§16.3)', () => {
  test('a cue that was RIGHT costs nothing: the channel reached HOLD', () => {
    reset();
    const m = derivedMetrics([
      ev(0, semantic('HOLD_CUE')),
      ev(10, { t: 'hold.suspected', trigger: 'hold_cue', atMs: T0 + 10 }),
      ev(20, gate('open', 'closed', true)),
      ev(3000, { t: 'channel.changed', from: 'HUMAN', to: 'HOLD', producer: { kind: 'acoustic', seq: 2 } }),
      ev(3000, { t: 'hold.cleared', reason: 'hold_confirmed' }),
    ]);
    assert.equal(m.gateFalseCloseCount, 0);
    assert.deepEqual(m.falseCloseDurationsMs, []);
  });

  test('a cue that was WRONG is counted, with how long the agent was muted', () => {
    // "Let me check" while the representative keeps talking (§6.3, A-27). The
    // gate shut, §5.5 confirmed a person at N=2, no hold ever happened.
    reset();
    const m = derivedMetrics([
      ev(0, semantic('HOLD_CUE')),
      ev(10, { t: 'hold.suspected', trigger: 'hold_cue', atMs: T0 + 10 }),
      ev(20, gate('open', 'closed', true)),
      ev(1220, { t: 'hold.cleared', reason: 'human_confirmed' }),
      ev(1220, gate('closed', 'open', false)),
    ]);
    assert.equal(m.gateFalseCloseCount, 1);
    assert.deepEqual(m.falseCloseDurationsMs, [1200]);
  });

  test('a cue spoken while the gate was already shut had no victim and is not charged', () => {
    // Inside HOLD or IVR the gate is closed anyway (ADR-007), so the cue cost
    // nobody anything. Charging for it would inflate the headline figure with
    // episodes that muted no one.
    reset();
    const m = derivedMetrics([
      ev(0, semantic('HOLD_CUE')),
      ev(10, { t: 'hold.suspected', trigger: 'hold_cue', atMs: T0 + 10 }),
      ev(1220, { t: 'hold.cleared', reason: 'human_confirmed' }),
    ]);
    assert.equal(m.gateFalseCloseCount, 0);
  });

  test('only a CUE opens a chargeable episode — an acoustic suspicion is not §6.3s cost', () => {
    // §16.3 says "closed on HOLD_CUE". A provisional PERIODIC is the acoustic
    // layer's business (§6.7 prices that separately, and module 4.1 measured it).
    reset();
    const m = derivedMetrics([
      ev(10, { t: 'hold.suspected', trigger: 'periodic_provisional', atMs: T0 + 10 }),
      ev(20, gate('open', 'closed', true)),
      ev(1220, { t: 'hold.cleared', reason: 'human_confirmed' }),
    ]);
    assert.equal(m.gateFalseCloseCount, 0);
  });

  test('several episodes on one call are counted separately', () => {
    reset();
    const m = derivedMetrics([
      ev(0, semantic('HOLD_CUE')),
      ev(10, { t: 'hold.suspected', trigger: 'hold_cue', atMs: T0 + 10 }),
      ev(20, gate('open', 'closed', true)),
      ev(820, { t: 'hold.cleared', reason: 'human_confirmed' }),
      ev(820, gate('closed', 'open', false)),
      ev(5000, semantic('HOLD_CUE')),
      ev(5010, { t: 'hold.suspected', trigger: 'hold_cue', atMs: T0 + 5010 }),
      ev(5020, gate('open', 'closed', true)),
      ev(7020, { t: 'hold.cleared', reason: 'human_confirmed' }),
    ]);
    assert.equal(m.gateFalseCloseCount, 2);
    assert.deepEqual(m.falseCloseDurationsMs, [800, 2000]);
  });

  test('an episode still open when the call ends is reported, not silently counted', () => {
    // A call that drops mid-episode is evidence of neither a false close nor a
    // correct one. Folding it into either would move the headline figure for a
    // reason nobody reading the panel could see.
    reset();
    const m = derivedMetrics([
      ev(0, semantic('HOLD_CUE')),
      ev(10, { t: 'hold.suspected', trigger: 'hold_cue', atMs: T0 + 10 }),
      ev(20, gate('open', 'closed', true)),
      ev(900, { t: 'call.dropped', cause: 'link_drop' }),
    ]);
    assert.equal(m.gateFalseCloseCount, 0);
    assert.equal(m.unresolvedCueEpisodes, 1);
  });
});

// ---------------------------------------------------------------------------
// hold_cue_to_gate_ms
// ---------------------------------------------------------------------------

describe('hold_cue_to_gate_ms (§16.3)', () => {
  test('timed from the observation to the gate shutting', () => {
    reset();
    const m = derivedMetrics([
      ev(0, semantic('HOLD_CUE')),
      ev(140, gate('open', 'closed', true)),
    ]);
    assert.deepEqual(m.holdCueToGateMs, [140]);
  });

  test('an observation the classifier did not accept is not evidence (§6.4)', () => {
    // `suspicion.onSemantic` returns early on `accepted: false`, so an
    // unaccepted observation never reached the gate. Timing against it would
    // report a latency for a causal chain that did not happen.
    reset();
    const m = derivedMetrics([
      ev(0, semantic('HOLD_CUE', false)),
      ev(140, gate('open', 'closed', true)),
    ]);
    assert.deepEqual(m.holdCueToGateMs, []);
  });

  test('one gate closure is charged to one observation, not to every earlier cue', () => {
    reset();
    const m = derivedMetrics([
      ev(0, semantic('HOLD_CUE')),
      ev(100, semantic('HOLD_CUE')),
      ev(140, gate('open', 'closed', true)),
      ev(900, gate('closed', 'open', false)),
      ev(1000, gate('open', 'closed', true)),
    ]);
    assert.deepEqual(m.holdCueToGateMs, [40], 'the second closure had no cue behind it');
  });
});

// ---------------------------------------------------------------------------
// party_detection_miss_count
// ---------------------------------------------------------------------------

describe('party_detection_miss_count (§16.3)', () => {
  test('the denominator is the harness s and the numerator is ours', () => {
    reset();
    const m = derivedMetrics([
      ev(0, { t: 'harness.telemetry', metric: 'parties_used', value: 2 }),
      // The core never noticed the second party: the hedge carried the call.
    ]);
    assert.equal(m.partiesDetected, 1);
    assert.equal(m.partyDetectionMissCount, 1);
  });

  test('a party the core DID detect is not a miss', () => {
    reset();
    const m = derivedMetrics([
      ev(0, { t: 'harness.telemetry', metric: 'parties_used', value: 2 }),
      ev(10, partyChanged(2)),
    ]);
    assert.equal(m.partyDetectionMissCount, 0);
  });

  test('no reported party count means no metric, not a zero', () => {
    // A miss count computed against an assumed denominator is a number that
    // cannot fail (§16.1). Null is what the panel shows as "—".
    reset();
    assert.equal(derivedMetrics([ev(0, partyChanged(2))]).partyDetectionMissCount, null);
  });

  test('detecting MORE parties than the harness used is clamped, not negative', () => {
    reset();
    const m = derivedMetrics([
      ev(0, { t: 'harness.telemetry', metric: 'parties_used', value: 1 }),
      ev(10, partyChanged(3)),
    ]);
    assert.equal(m.partyDetectionMissCount, 0, 'over-detection is a different fault and has its own metric');
  });
});

describe('hedge_applied_count (§16.3)', () => {
  test('counted from prompt.loaded, and only when hedged', () => {
    reset();
    const m = derivedMetrics([
      ev(0, { t: 'prompt.loaded', files: ['a'], hedged: true, disclosureIncluded: false, substitutions: [] }),
      ev(10, { t: 'prompt.loaded', files: ['a'], hedged: false, disclosureIncluded: false, substitutions: [] }),
      ev(20, { t: 'prompt.loaded', files: ['a'], hedged: true, disclosureIncluded: false, substitutions: [] }),
    ]);
    assert.equal(m.hedgeAppliedCount, 2);
  });
});

// ---------------------------------------------------------------------------
// The view must show the derivation, not a telemetry value
// ---------------------------------------------------------------------------

describe('panel 7 shows the derived figures (§16.3), not harness telemetry', () => {
  const requests = (): AuthRequest[] => [{
    id: 'R1', patientRef: 'p', memberId: 'm', patientDob: '1970-01-01',
    cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-01',
    payerId: 'payer', payerEndpoint: 'ws://x', clinicName: 'Clinic', clinicCallbackPhone: '555',
    priority: 'routine', clinicalSummary: 's', status: 'in_progress', attempts: 1,
  }];

  test('a false close reaches the panel from the log alone', () => {
    reset();
    const log = [
      ev(0, { t: 'call.started', requestId: 'R1', attempts: 1, priority: 'routine', networkProfile: 'TELEPHONY' }),
      ev(100, semantic('HOLD_CUE')),
      ev(110, { t: 'hold.suspected', trigger: 'hold_cue', atMs: T0 + 110 }),
      ev(120, gate('open', 'closed', true)),
      ev(1320, { t: 'hold.cleared', reason: 'human_confirmed' }),
      ev(1320, gate('closed', 'open', false)),
    ];
    const v = dashboardView(log, { redact: false, requests: requests(), nowMs: T0 + 2000 });
    assert.equal(v.compliance.gateFalseCloseCount, 1);
    assert.deepEqual(v.compliance.falseCloseDurationsMs, [1200]);
  });

  test('a harness telemetry value for either metric is IGNORED', () => {
    // The unwiring test. If someone restores the `harness.telemetry` read, this
    // fails: the harness is not the source for a §16.3 derivation, and a number
    // arriving from there must not be able to overwrite what the log says.
    reset();
    const log = [
      ev(0, { t: 'call.started', requestId: 'R1', attempts: 1, priority: 'routine', networkProfile: 'TELEPHONY' }),
      ev(50, { t: 'harness.telemetry', metric: 'gate_false_close_count', value: 99 }),
      ev(60, { t: 'harness.telemetry', metric: 'party_detection_miss_count', value: 99 }),
      ev(70, { t: 'harness.telemetry', metric: 'parties_used', value: 1 }),
    ];
    const v = dashboardView(log, { redact: false, requests: requests(), nowMs: T0 + 1000 });
    assert.equal(v.compliance.gateFalseCloseCount, 0);
    assert.equal(v.compliance.partyDetectionMissCount, 0);
  });

  test('parties_used still comes from the harness — it is the one part we cannot know (ADR-018)', () => {
    reset();
    const log = [
      ev(0, { t: 'call.started', requestId: 'R1', attempts: 1, priority: 'routine', networkProfile: 'TELEPHONY' }),
      ev(50, { t: 'harness.telemetry', metric: 'parties_used', value: 3 }),
    ];
    const v = dashboardView(log, { redact: false, requests: requests(), nowMs: T0 + 1000 });
    assert.equal(v.compliance.partyDetectionMissCount, 2);
  });
});

describe('p90', () => {
  test('it is the value below which nine tenths fall, and null on no samples', () => {
    assert.equal(p90([]), null);
    assert.equal(p90([5]), 5);
    assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
    assert.equal(p90([10, 1]), 10, 'order does not matter');
  });
});
