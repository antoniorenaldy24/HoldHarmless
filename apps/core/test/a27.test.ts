/**
 * A-27, enforced — the bar the project owner set on 2026-09-30.
 *
 * "The gate reopens within two far-end turns, always." It replaced a wall-clock
 * p90 of 1500 ms that no implementation of §6.5 could meet at a realistic turn
 * length: the cost is two turns BY DESIGN ("suspect fast, confirm slowly"),
 * and a turn is as long as a person's sentence. The structural bar is the
 * stronger statement, because it cannot drift with how talkative a
 * representative is — and it can still fail, which is what makes it a metric:
 * the latch module 4.0 found would break it on the first cue, and so would any
 * change to N.
 *
 * Runs §6.6's twenty Block-C utterances through the real semantic layer, the
 * real suspicion and gate, and the real call loop, over perfect transcripts.
 * The same trials `pnpm a27` prints, from the same module, so the number the
 * script reports and the number CI enforces cannot drift apart.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { A27_MAX_TURNS_TO_REOPEN, CUE_WITHOUT_HOLD, runTrial } from '../../../scripts/a27-trials.js';

describe('A-27 (structural): a cue spoken without a hold costs at most two turns', () => {
  const trials = CUE_WITHOUT_HOLD.map(runTrial);

  test('the corpus is the twenty utterances §6.6 asks for', () => {
    assert.equal(CUE_WITHOUT_HOLD.length, 20);
  });

  test('every cue closes the gate — §6.3 s list is decisive, as §6.5 intends', () => {
    const open = trials.filter((t) => !t.closed).map((t) => t.cue);
    assert.deepEqual(open, [], 'a cue §6.3 lists did not close the gate');
  });

  test(`every one reopens within ${A27_MAX_TURNS_TO_REOPEN} far-end turns`, () => {
    const late = trials
      .filter((t) => t.turnsToReopen === null || t.turnsToReopen > A27_MAX_TURNS_TO_REOPEN)
      .map((t) => `${t.turnsToReopen ?? 'never'}: ${t.cue}`);
    assert.deepEqual(late, [], 'the gate stayed shut past the bar');
  });

  test('each one is counted as a false close, from the log (§16.3)', () => {
    // A cue with no hold behind it is exactly what gate_false_close_count counts.
    // If this reads zero, the metric has stopped seeing the thing A-27 prices.
    assert.equal(trials.reduce((n, t) => n + t.falseCloseCount, 0), 20);
  });
});
