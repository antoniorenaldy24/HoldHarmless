/**
 * A-27's trials, shared by the script that prints them (`pnpm a27`) and the
 * test that enforces them in CI (`apps/core/test/a27.test.ts`).
 *
 * Split out on 2026-09-30, when the project owner made A-27's bar STRUCTURAL:
 * "the gate reopens within two far-end turns, always". A bar that only a
 * script checks is a bar somebody has to remember to run. The corpus and the
 * trial live here once, so the number the script prints and the number CI
 * enforces cannot drift apart.
 */

import { createEventLog, derivedMetrics, startCallLoop, type TranscriptSource } from '@holdharmless/core';
import { gateAdmits, type AudioSource, type CallTransport } from '@holdharmless/transport';
import type { AuthRequest, GateIntent } from '@holdharmless/events';

/** The bar the owner set: reopened within this many far-end turns, every time. */
export const A27_MAX_TURNS_TO_REOPEN = 2;

/**
 * §6.6's Block C, verbatim from `docs/recording-script.md`: twenty cue phrases
 * spoken with the representative carrying straight on. Every one of §6.3's
 * sixteen phrases appears at least once.
 */
export const CUE_WITHOUT_HOLD: readonly string[] = [
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
export const CONTINUES: readonly string[] = [
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
export type Trial = {
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
export const TYPICAL_TURN_MS = 3_696;
export const SHORTEST_TURN_MS = 1_872;

/**
 * §6.6's Block B, verbatim from `docs/recording-script.md`: twenty cue phrases
 * that a hold DOES follow. The honest half of the pair; Block C above is the
 * filler half. Kept beside it because the defect that made a hold cue lose to
 * `responsiveness` (2026-09-30) was only visible with both in hand.
 */
export const CUE_WITH_HOLD: readonly string[] = [
  'One moment.',
  'One moment please, let me look that up.',
  'Okay, let me put you on hold for just a second.',
  'Can you hold for me?',
  'Bear with me.',
  'Hold on.',
  'Hang on, I need to check something.',
  'Let me check.',
  'Give me a second.',
  'Just a moment.',
  'Let me pull that up.',
  "I'll be right back.",
  "Stay on the line, I'm going to look into this.",
  'Let me transfer you.',
  "I'm going to transfer you to utilization management. Please hold.",
  'Connecting you now.',
  'Let me get someone else who can help with that.',
  'Okay… one moment.',
  'Alright, let me check on that.',
  'Oh, hold on, let me get that for you.',
];

export type TrialOptions = {
  /**
   * The agent spoke just before the representative's cue — the ORDINARY case,
   * since "one moment" is usually said in reply to the agent. Until 2026-09-30
   * no trial had it, which is how a cue losing to `responsiveness` went unseen.
   */
  agentSpokeFirst?: boolean;
};

export function runTrial(cue: string, opts: TrialOptions = {}): Trial {
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

  if (opts.agentSpokeFirst) {
    // The agent finishes its request; the representative answers a second later.
    atMs += TYPICAL_TURN_MS;
    loop.noteAgentSpoke();
  }
  atMs += opts.agentSpokeFirst ? 1_000 : TYPICAL_TURN_MS;
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
