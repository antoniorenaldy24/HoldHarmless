/**
 * A-27, the part that can be measured without a live session — module 4.2.
 *
 * §20: "`HOLD_CUE` phrases spoken without a hold do not mute the agent
 * excessively. 20 utterances of 'let me check' with the persona continuing.
 * `gate_false_close_count` recorded; `agent_mute_during_conversation_ms` p90
 * < 1500 ms."
 *
 * WHAT THIS MEASURES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It runs the real semantic layer, the real suspicion and gate controller and
 * the real call loop over perfect transcripts — exactly what the representative
 * said, with no recognizer in between. That isolates §6.3's phrase list, which
 * is what A-27 is about; running it against live ASR would measure the list AND
 * the recognizer together, and a miss could belong to either.
 *
 * It does NOT produce `agent_mute_during_conversation_ms`. That is a duration,
 * and offline the duration is whatever this script chooses for the length of a
 * turn — a number I set is not a measurement. What IS a property of the
 * classifier, and is measured here, is **how many turns of ordinary speech it
 * takes to reopen the gate**. The duration follows from that and a real turn
 * length, and the harness measures the real thing on a live call (§16.2).
 *
 * So this is the upper bound: how well §6.3 can do when the transcript is
 * perfect. A live run can only be worse, and the gap between them is the
 * recognizer's contribution.
 */

import { p90 } from '@holdharmless/core';
import { A27_MAX_TURNS_TO_REOPEN, CUE_WITHOUT_HOLD, SHORTEST_TURN_MS, TYPICAL_TURN_MS, runTrial } from './a27-trials.js';

const trials = CUE_WITHOUT_HOLD.map(runTrial);

console.log('A-27, upper bound: §6.3s list against perfect transcripts');
console.log('Twenty cue phrases with the representative carrying straight on.\n');

let closed = 0;
let neverReopened = 0;
const turns: number[] = [];
for (const t of trials) {
  if (t.closed) closed++;
  if (t.closed && t.turnsToReopen === null) neverReopened++;
  if (t.turnsToReopen !== null && t.turnsToReopen > 0) turns.push(t.turnsToReopen);
  const verdict = !t.closed ? 'not closed'
    : t.turnsToReopen === null ? '** NEVER REOPENED **'
    : `reopened after ${t.turnsToReopen} turn${t.turnsToReopen === 1 ? '' : 's'}`;
  console.log(`  ${verdict.padEnd(24)} ${t.cue.slice(0, 62)}`);
  if (t.turnsToReopen === null) console.log(`      winners: ${t.winners.join(' ')}`);
}

const falseCloses = trials.reduce((n, t) => n + t.falseCloseCount, 0);
const p = p90(turns);
console.log(`\n  gate closed on the cue:        ${closed}/20`);
console.log(`  gate_false_close_count:        ${falseCloses}/20  (derived from the log, §16.3)`);
console.log(`  never reopened:                ${neverReopened}/20`);
if (turns.length > 0) {
  const sorted = [...turns].sort((a, b) => a - b);
  console.log(`  turns to reopen:               min ${sorted[0]}  median ${sorted[Math.floor(sorted.length / 2)]}  p90 ${p}`);
}

console.log('\n  This is an UPPER BOUND. The transcripts are perfect, so a live run can');
console.log('  only be worse, and the difference is the recognizer s contribution.');
console.log('  The real agent_mute_during_conversation_ms is measured at the harness (§16.2).');

// THE BAR, as the project owner set it on 2026-09-30: structural, not a clock.
// "The gate reopens within two far-end turns, always." The 1500 ms wall-clock
// bar it replaces could not be met at any realistic turn length — the cost is
// two turns by design (§6.5) and a turn is as long as a sentence — so the
// wall-clock figure is REPORTED below and bounded by nothing.
const late = trials.filter((t) => t.closed && (t.turnsToReopen === null || t.turnsToReopen > A27_MAX_TURNS_TO_REOPEN));
console.log(`\n  A-27 (structural): reopened within ${A27_MAX_TURNS_TO_REOPEN} far-end turns in ${trials.length - late.length}/${trials.length}   ${late.length === 0 ? 'PASS' : '** FAIL **'}`);
if (p !== null) {
  console.log('  What it costs, reported and not bounded:');
  console.log(`    rendered catalogue: shortest turn ${SHORTEST_TURN_MS} ms, median ${TYPICAL_TURN_MS} ms -> ${p * TYPICAL_TURN_MS} ms typical`);
  console.log('    the owner s own voice: median turn 2880 ms -> 5760 ms typical (`pnpm human-calibration`)');
}

if (late.length > 0) process.exitCode = 1;
