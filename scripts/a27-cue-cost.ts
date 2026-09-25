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

import { createEventLog, derivedMetrics, startCallLoop, p90, type TranscriptSource } from '@holdharmless/core';
import { gateAdmits, type AudioSource, type CallTransport } from '@holdharmless/transport';
import type { AuthRequest, GateIntent } from '@holdharmless/events';

/**
 * §6.6's Block C, verbatim from `docs/recording-script.md`: twenty cue phrases
 * spoken with the representative carrying straight on. Every one of §6.3's
 * sixteen phrases appears at least once.
 */
const CUE_WITHOUT_HOLD: readonly string[] = [
  'Let me check — okay, I see it right here.',
  "One moment, yeah, it's showing as approved already.",
  "Hold on, that's not what I'm seeing.",
  'Let me pull that up, and while I do, can you give me the date of service again?',
  'Give me a second, okay, got it.',
  'Just a moment, alright, the member is active.',
  "Bear with me, I'm still in the other system.",
  'Hang on, I think I typed that wrong.',
  "Let me check the plan on this one, it's a commercial plan, not Medicare.",
  'One moment, sorry, my screen froze for a second.',
  'Let me pull that up, so this needs a medical review.',
  "Hold on — no, wait, that's a different member.",
  'Let me check the notes here, and it says conservative therapy was tried.',
  'Can you hold — actually, never mind, I have it.',
  "I'll be right back — actually, I don't need to step away, here it is.",
  'Let me pull that up, so the CPT is nine six four one three, is that right?',
  "Stay on the line, I'm just reading the clinical notes.",
  'Let me get someone else, or actually, I can do this myself.',
  'One moment while I document this, okay, done.',
  "Let me check, and I'll need the NPI again while I'm here.",
];

/**
 * What the representative says after the cue, in order, until the gate reopens.
 *
 * Drawn from the harness's own `rep1` catalogue (§10.5) rather than written for
 * this script: if ordinary working speech does not read `HUMAN`, that is the
 * finding, and inventing friendlier sentences here would hide it.
 */
const CONTINUES: readonly string[] = [
  "Okay. Can I get the provider's NPI, please?",
  "And the member's ID number?",
  "What is the member's date of birth?",
  'Which procedure code are you requesting?',
  'And the diagnosis code?',
  'What is the date of service?',
  'Can you give me the clinical reason for the request?',
  'Was conservative therapy tried for at least six weeks before this request?',
];

const request: AuthRequest = {
  id: 'A27', patientRef: 'p', memberId: 'm', patientDob: '1970-01-01',
  cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-01',
  payerId: 'payer', payerEndpoint: 'ws://x', clinicName: 'Clinic', clinicCallbackPhone: '555',
  priority: 'routine', clinicalSummary: 's', status: 'in_progress', attempts: 0,
};

/** A transport that only records; the gate is enforced exactly as the real one does. */
function recordingTransport() {
  let intent: GateIntent = 'closed';
  const t: CallTransport = {
    kind: 'loopback',
    dial: async () => {},
    sendAudio: (_f: Uint8Array, s: AudioSource) => gateAdmits(intent, s),
    clear: async () => [],
    mark: async () => {},
    applyGate: (next) => { intent = next; },
    gate: () => intent,
    hangup: async () => {},
    onAudio() {},
    onMark() {},
    onFault() {},
    onClosed() {},
  };
  return { t, get intent() { return intent; } };
}

/** A transcript source the script drives turn by turn. */
function scriptedTranscripts() {
  let delta: ((text: string, atMs: number) => void) | null = null;
  let end: ((text: string, atMs: number) => void) | null = null;
  const src: TranscriptSource = {
    onFarEndDelta(h) { delta = h; },
    onFarEndTurnEnd(h) { end = h; },
  };
  return {
    src,
    turn(text: string, atMs: number) {
      delta?.(text, atMs);
      end?.(text, atMs);
    },
  };
}

/** One trial: a cue with the representative carrying on, then ordinary turns. */
type Trial = {
  cue: string;
  closed: boolean;
  turnsToReopen: number | null;
  falseCloseCount: number;
  winners: string[];
};

/**
 * A representative turn, measured — not chosen.
 *
 * Over the 28 rendered `rep1`/`rep2` lines (§10.5): min 1872 ms, p25 2304,
 * median 3696, p75 5112, max 15240. The median prices the result, and the
 * MINIMUM is what decides whether A-27's bar is reachable at all — the cost is
 * structurally two turns, and even the two shortest lines in the whole
 * catalogue total 3744 ms against a bar of 1500.
 */
const TYPICAL_TURN_MS = 3_696;
const SHORTEST_TURN_MS = 1_872;

function runTrial(cue: string): Trial {
  const tp = recordingTransport();
  const ts = scriptedTranscripts();
  const log = createEventLog({ callId: `A27-${cue.slice(0, 8)}` });
  let atMs = 0;
  const loop = startCallLoop({
    request, log, transport: tp.t, transcripts: ts.src,
    navMode: 'dtmf', networkProfile: 'TELEPHONY', nowMs: () => atMs,
  });
  // The representative is on the line and the gate is open: that is the state
  // §6.3's cost is paid from. A cue in any other position mutes nobody.
  loop.gate.setChannel('HUMAN', { kind: 'transport', cause: 'a27' });

  atMs += TYPICAL_TURN_MS;
  ts.turn(cue, atMs);
  const closed = loop.gate.gate === 'closed';

  let turnsToReopen: number | null = null;
  for (let i = 0; i < CONTINUES.length; i++) {
    if (loop.gate.gate !== 'closed') break;
    atMs += TYPICAL_TURN_MS;
    ts.turn(CONTINUES[i]!, atMs);
    if (loop.gate.gate !== 'closed') {
      turnsToReopen = i + 1;
      break;
    }
  }
  if (!closed) turnsToReopen = 0;

  const winners = log.events()
    .filter((e) => e.t === 'semantic.observed')
    .map((e) => (e.t === 'semantic.observed' ? `${e.obs.winner}${e.obs.accepted ? '' : '?'}` : ''));

  return {
    cue,
    closed,
    turnsToReopen,
    falseCloseCount: derivedMetrics(log.events()).gateFalseCloseCount,
    winners,
  };
}

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
  console.log(`  implied mute at ${TYPICAL_TURN_MS} ms/turn:  p90 ${(p ?? 0) * TYPICAL_TURN_MS} ms  (bar: 1500 ms)`);
}

console.log('\n  This is an UPPER BOUND. The transcripts are perfect, so a live run can');
console.log('  only be worse, and the difference is the recognizer s contribution.');
console.log('  The real agent_mute_during_conversation_ms is measured at the harness (§16.2).');

// The finding, stated by the script rather than left to a reader's arithmetic.
if (p !== null) {
  const floor = p * SHORTEST_TURN_MS;
  console.log('\n  A-27 S BAR CANNOT BE MET, and not because of this implementation.');
  console.log(`  The cost is structurally ${p} turns: §6.5 clears suspicion at N=2, and every`);
  console.log(`  trial took exactly that — never more, never fewer. The SHORTEST representative`);
  console.log(`  line in the whole catalogue is ${SHORTEST_TURN_MS} ms, so the least this can ever`);
  console.log(`  cost is ${floor} ms against a bar of 1500 ms. At the median turn, ${p * TYPICAL_TURN_MS} ms.`);
  console.log('  The bar and the mechanism were never reconciled. §20 records the options.');
}

if (neverReopened > 0) process.exitCode = 1;
