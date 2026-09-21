import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DelayLine, PROFILES, gateAdmits, gateTransitionRequiresClear } from '../src/index.js';

/** Deterministic PRNG so loss and jitter tests are reproducible. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('network profiles (§4.5)', () => {
  test('presets carry the documented values', () => {
    assert.deepEqual(PROFILES.CLEAN, { oneWayDelayMs: 0, jitterMs: 0, lossRate: 0, reorderRate: 0 });
    assert.deepEqual(PROFILES.TELEPHONY, { oneWayDelayMs: 25, jitterMs: 8, lossRate: 0, reorderRate: 0 });
    assert.deepEqual(PROFILES.DEGRADED, { oneWayDelayMs: 60, jitterMs: 25, lossRate: 0.01, reorderRate: 0 });
  });
});

describe('gate admission (INV-2)', () => {
  test('the full admission table', () => {
    assert.equal(gateAdmits('open', 'agent'), true);
    assert.equal(gateAdmits('open', 'dtmf'), true);
    assert.equal(gateAdmits('dtmf_only', 'agent'), false);
    assert.equal(gateAdmits('dtmf_only', 'dtmf'), true);
    assert.equal(gateAdmits('closed', 'agent'), false);
    assert.equal(gateAdmits('closed', 'dtmf'), false);
  });

  test('clear is required whenever the gate admits strictly less (INV-3)', () => {
    assert.equal(gateTransitionRequiresClear('open', 'closed'), true);
    assert.equal(gateTransitionRequiresClear('open', 'dtmf_only'), true);
    assert.equal(gateTransitionRequiresClear('dtmf_only', 'closed'), true, 'queued DTMF must not play into a hold');
    assert.equal(gateTransitionRequiresClear('closed', 'open'), false);
    assert.equal(gateTransitionRequiresClear('dtmf_only', 'open'), false);
    assert.equal(gateTransitionRequiresClear('closed', 'closed'), false);
  });
});

describe('DelayLine', () => {
  test('delivers in order under jitter (§4.4)', async () => {
    const got: number[] = [];
    const line = new DelayLine<number>({
      profile: { oneWayDelayMs: 5, jitterMs: 4, lossRate: 0, reorderRate: 0 },
      random: seeded(42),
      deliver: (n) => got.push(n),
    });
    for (let i = 0; i < 50; i++) line.push(i);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(got, Array.from({ length: 50 }, (_, i) => i));
  });

  test('loss drops at roughly the configured rate and counts every drop', async () => {
    const got: number[] = [];
    const line = new DelayLine<number>({
      profile: { oneWayDelayMs: 0, jitterMs: 0, lossRate: 0.1, reorderRate: 0 },
      random: seeded(7),
      deliver: (n) => got.push(n),
    });
    for (let i = 0; i < 2000; i++) line.push(i);
    await new Promise((r) => setTimeout(r, 20));

    const { sent, delivered, lost } = line.stats();
    assert.equal(sent, 2000);
    assert.equal(delivered + lost, sent, 'nothing vanishes unaccounted');
    assert.ok(lost > 150 && lost < 250, `lost ${lost} of 2000 at a 10% rate`);
  });

  test('reordering happens only when a profile asks for it', async () => {
    const got: number[] = [];
    const line = new DelayLine<number>({
      profile: { oneWayDelayMs: 0, jitterMs: 0, lossRate: 0, reorderRate: 0.3 },
      random: seeded(3),
      deliver: (n) => got.push(n),
    });
    for (let i = 0; i < 100; i++) line.push(i);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(line.stats().reordered > 0);
    assert.notDeepEqual(got, [...got].sort((a, b) => a - b));
  });

  test('close discards everything in flight', async () => {
    const got: number[] = [];
    const line = new DelayLine<number>({ profile: PROFILES.TELEPHONY, deliver: (n) => got.push(n) });
    line.push(1);
    line.close();
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(got, []);
  });
});
