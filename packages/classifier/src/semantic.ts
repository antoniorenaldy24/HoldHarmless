/**
 * The semantic layer — §6.2, §6.3, §6.7, interface in §12.4.
 *
 * Runs on each `transcript.user.delta`, not on final transcripts: the first
 * words of "Thank you for calling, press one for..." identify a menu hundreds
 * of milliseconds before the turn ends, and those milliseconds are the gate's.
 *
 * Output: IVR_PROMPT, HUMAN, HOLD_CUE — or UNKNOWN, which §6.4 requires
 * whenever the evidence does not clear the bar. UNKNOWN is a result here, not a
 * failure: `hold_exit_unknown_duration_ms` (§16.3) measures how much of it the
 * far end talks through.
 *
 * ONE CONTRADICTION IN THE DOCUMENT, RESOLVED IN FAVOUR OF §6.7. §12.4's
 * comment reads "Raises MIN_WEIGHT one step, never below the floor" — which
 * cannot both raise a number and keep it above a floor. §6.7 says the HOLD
 * recovery action "raises semantic sensitivity", and §6.8 says the layer runs
 * "during HOLD at elevated MIN_WEIGHT". So: entering HOLD RAISES MIN_WEIGHT (a
 * hold is hard to leave, which is A-7's hard constraint), and each ramp step
 * LOWERS it back toward MIN_WEIGHT_FLOOR — the non-hold baseline — never past
 * it, and at most three times (§6.7).
 */

import type { SemanticClass, SemanticObservation } from '@holdharmless/events';

// ---------------------------------------------------------------------------
// §6.3 — the closed list
// ---------------------------------------------------------------------------

export interface HoldCuePhrase {
  phrase: string;
  transferHint: boolean;
}

/**
 * Verbatim from §6.3, transfer hints included. The column is explicit per
 * phrase and never inferred: "stay on the line" closes the gate and is the
 * opposite of a transfer.
 *
 * The list is deliberately closed and short. Growing it turns this layer into
 * general language understanding, which is the LLM's job; additions require
 * fixture evidence (§6.3).
 */
export const HOLD_CUE_PHRASES: readonly HoldCuePhrase[] = [
  { phrase: 'one moment', transferHint: false },
  { phrase: 'let me put you on hold', transferHint: false },
  { phrase: 'can you hold', transferHint: false },
  { phrase: 'bear with me', transferHint: false },
  { phrase: 'hold on', transferHint: false },
  { phrase: 'hang on', transferHint: false },
  { phrase: 'let me check', transferHint: false },
  { phrase: 'give me a second', transferHint: false },
  { phrase: 'just a moment', transferHint: false },
  { phrase: 'let me pull that up', transferHint: false },
  { phrase: "i'll be right back", transferHint: false },
  { phrase: 'stay on the line', transferHint: false },
  { phrase: 'let me transfer', transferHint: true },
  { phrase: "i'm going to transfer", transferHint: true },
  { phrase: 'connecting you', transferHint: true },
  { phrase: 'let me get someone else', transferHint: true },
];

/** Lower case, apostrophes kept, everything else a single space, padded. */
export function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim()} `;
}

export function matchHoldCue(text: string): HoldCuePhrase | null {
  const n = normalize(text);
  // Longest first, so "let me put you on hold" is not reported as "hold on".
  // No phrase pair in the current §6.3 list actually needs this — it guards the
  // next addition, which §6.3 allows with fixture evidence.
  const byLength = [...HOLD_CUE_PHRASES].sort((a, b) => b.phrase.length - a.phrase.length);
  return byLength.find((p) => n.includes(` ${p.phrase} `) || n.includes(` ${p.phrase.replace(/'/g, '')} `)) ?? null;
}

// ---------------------------------------------------------------------------
// The other signals of §6.2
// ---------------------------------------------------------------------------

/**
 * Recorded-announcement language, not just menu options. The first version
 * listed "press", "say" and "menu" only, and scored 0.00 on "Your call may be
 * monitored or recorded" and on "Please enter the ten digit provider NPI" —
 * which then read as HUMAN through the absence rule, the one error A-4 forbids.
 */
const IVR_MARKERS = [
  'press', 'you may dial', 'dial', 'main menu', 'menu', 'option', 'options',
  'extension', 'listen carefully', 'has changed', 'have changed', 'thank you for calling',
  'your call may be', 'is being recorded', 'may be monitored', 'for quality', 'at any time',
  'to continue', 'to repeat', 'to return', 'please enter', 'followed by', 'pound key',
  'star key', 'the pound', 'if you know your', "party's extension", 'partys extension',
  'para ', 'oprima', 'please hold while', 'next available representative', 'all other inquiries',
  'this call is', 'your call is',
];

/** "for <option>, press <digit>" — the shape a menu repeats, in any wording. */
const ROUTING = /\bfor [a-z' ]{2,30}[, ]+(press|say|dial)\b|\b(press|say|dial) (the )?(one|two|three|four|five|six|seven|eight|nine|zero|pound|star|[0-9])\b/;

/** "I", "my", "me" — but never "we", which recorded announcements use freely. */
const FIRST_PERSON = / (i|i'm|i'll|i've|my|me)[ ']/;

/** Recorded-announcement and menu language (§6.2). */
export function menuLanguageScore(text: string): number {
  const n = normalize(text);
  let hits = 0;
  for (const m of IVR_MARKERS) if (n.includes(` ${m}`)) hits++;
  if (ROUTING.test(n)) hits += 2;
  // An imperative opening with no first person: "please enter", "to continue".
  if (/^ (please|to) [a-z]+ /.test(n) && !FIRST_PERSON.test(n)) hits += 1;
  // A menu ITEM's opening, before its "press N" arrives: "For eligibility and
  // benefits, ...". Four words in, this is all a delta has, and without it the
  // absence rule read those openings as HUMAN — A-4's forbidden error.
  if (/^ for [a-z' ]{3,40}$|^ for [a-z' ]{3,40} /.test(n) && !FIRST_PERSON.test(n)) hits += 1;
  return Math.min(1, hits / 2);
}

/** First person and the small talk a recorded announcement does not have (§6.2). */
export function conversationalScore(text: string): number {
  const n = normalize(text);
  let hits = 0;
  // FIRST person only. "you" and "your" are as common in a recorded
  // announcement as in a conversation ("your call may be monitored"), and
  // counting them cost A-4 several IVR lines.
  // "we" is missing on purpose: "we connect you", "we are currently
  // experiencing high call volume" are announcements, not conversation.
  for (const m of [" i'm ", ' i ', " i'll ", " i've ", " let's ", ' me ', ' my ']) if (n.includes(m)) hits++;
  for (const m of [' okay ', ' alright ', ' sure ', ' yeah ', ' yes ', ' no problem ', ' sorry ', ' thanks ', ' got it ', ' appreciate ']) if (n.includes(m)) hits++;
  // A question aimed at the caller, rather than a menu's "for X, press Y".
  if (/\b(can|could|what|which|who|when|do|does|did|may) (i|you|we)\b/.test(n) && !ROUTING.test(n)) hits += 2;
  return Math.min(1, hits / 3);
}

export function disfluencyScore(text: string): number {
  const n = normalize(text);
  let hits = 0;
  for (const m of [' um ', ' uh ', ' er ', ' you know ', ' i mean ', ' like i ']) if (n.includes(m)) hits++;
  return Math.min(1, hits / 2);
}

// ---------------------------------------------------------------------------

export const SEMANTIC_WEIGHTS = {
  holdCue: 1.0, // decisive
  responsiveness: 0.3,
  menuLanguage: 0.35,
  conversational: 0.15,
  turnLengthVariance: 0.1,
  disfluency: 0.05, // "very low — tiebreaker only" (§6.2)
} as const;

export type SemanticSignal = keyof typeof SEMANTIC_WEIGHTS;

/** §13. */
export const CLASSIFIER_MARGIN = 0.15;
export const MIN_WEIGHT_FLOOR = 0.45;
/** How much higher the bar sits during HOLD (§6.8), undone by three ramp steps. */
export const HOLD_ELEVATION = 0.3;
export const MAX_RAMP_STEPS = 3;
/** A reply this soon after the agent stopped speaking is a response to it. */
export const RESPONSIVENESS_WINDOW_MS = 4000;

export type SemanticOptions = {
  minWeightFloor?: number;
  holdElevation?: number;
  margin?: number;
  now?: () => Date;
};

export interface SemanticClassifier {
  push(delta: string, atMs: number): SemanticObservation | null;
  /** §6.7: one step of sensitivity, never past the floor, at most three. */
  rampSensitivity(): { step: number; effectiveMinWeight: number };
  setHoldMode(onHold: boolean): void;
  /**
   * Not in §12.4, and needed by it: "responsiveness to the agent's own speech"
   * is the highest-weighted HUMAN signal in §6.2, and nothing else can tell the
   * classifier when the agent last spoke. Unavailable during HOLD by design —
   * the agent is silent — which is the structural gap §6.2 describes, handled
   * here by dropping the signal and renormalizing (§6.4).
   *
   * WHO CALLS THIS MATTERS. In speech navigation mode the MENU answers the
   * agent too, and reporting that as agent speech makes a four-word menu
   * opening read HUMAN (measured). The Call Model reports agent speech only
   * where a person could be the one replying — never while navigating an IVR.
   */
  noteAgentSpoke(atMs: number): void;
  /** Ends the current utterance; the next delta starts a new one. */
  endTurn(): void;
  reset(): void;
}

export function createSemanticClassifier(options: SemanticOptions = {}): SemanticClassifier {
  const floor = options.minWeightFloor ?? MIN_WEIGHT_FLOOR;
  const elevation = options.holdElevation ?? HOLD_ELEVATION;
  const margin = options.margin ?? CLASSIFIER_MARGIN;
  const now = options.now ?? (() => new Date());

  let onHold = false;
  let rampStep = 0;
  let utterance = '';
  let agentSpokeAtMs: number | null = null;
  const turnLengths: number[] = [];

  const effectiveMinWeight = (): number =>
    onHold ? floor + (elevation * (MAX_RAMP_STEPS - rampStep)) / MAX_RAMP_STEPS : floor;

  return {
    push(delta: string, atMs: number): SemanticObservation | null {
      if (delta.trim() === '' && utterance === '') return null;
      utterance += delta;

      const scores: Record<SemanticClass, number> = { IVR_PROMPT: 0, HUMAN: 0, HOLD_CUE: 0 };
      const cue = matchHoldCue(utterance);

      // Responsiveness is unavailable during hold: the agent does not speak, so
      // nothing can be a response to it (§6.2's structural gap).
      const responsive =
        !onHold && agentSpokeAtMs !== null && atMs - agentSpokeAtMs <= RESPONSIVENESS_WINDOW_MS;
      const available: SemanticSignal[] = ['menuLanguage', 'conversational', 'disfluency'];
      if (cue) available.push('holdCue');
      if (!onHold && agentSpokeAtMs !== null) available.push('responsiveness');
      if (turnLengths.length >= 3) available.push('turnLengthVariance');

      const votes: Record<SemanticSignal, Record<SemanticClass, number>> = {
        holdCue: { IVR_PROMPT: 0, HUMAN: 0, HOLD_CUE: cue ? 1 : 0 },
        responsiveness: { IVR_PROMPT: responsive ? 0 : 0.5, HUMAN: responsive ? 1 : 0.5, HOLD_CUE: 0 },
        menuLanguage: (() => {
          const m = menuLanguageScore(utterance);
          // "Absence of menu language" is itself a HUMAN signal of medium weight (§6.2).
          return { IVR_PROMPT: m, HUMAN: 1 - m, HOLD_CUE: 0 };
        })(),
        conversational: (() => {
          const c = conversationalScore(utterance);
          return { IVR_PROMPT: 1 - c, HUMAN: c, HOLD_CUE: 0 };
        })(),
        turnLengthVariance: (() => {
          const v = varianceScore(turnLengths);
          return { IVR_PROMPT: 1 - v, HUMAN: v, HOLD_CUE: 0 };
        })(),
        disfluency: (() => {
          const d = disfluencyScore(utterance);
          return { IVR_PROMPT: 0.5 - d / 2, HUMAN: 0.5 + d / 2, HOLD_CUE: 0 };
        })(),
      };

      const total = available.reduce((sum, s) => sum + SEMANTIC_WEIGHTS[s], 0);
      for (const s of available) {
        const w = SEMANTIC_WEIGHTS[s] / total;
        for (const k of Object.keys(scores) as SemanticClass[]) scores[k] += w * votes[s][k];
      }

      const ranked = (Object.keys(scores) as SemanticClass[]).sort((a, b) => scores[b] - scores[a]);
      const top = ranked[0]!;
      const runnerUp = ranked[1]!;
      const minWeight = effectiveMinWeight();
      // Two bars, not one: enough evidence, and enough more than the next class.
      // Without the margin a 0.46/0.45 split would be reported as a decision.
      const accepted = scores[top] >= minWeight && scores[top] - scores[runnerUp] >= margin;

      return {
        at: now().toISOString(),
        seq: 0, // assigned by the core (§3.3 rule 4)
        scores: { ...scores },
        winner: accepted ? top : 'UNKNOWN',
        confidence: scores[top],
        effectiveMinWeight: minWeight,
        signalsAvailable: available,
        sourceDelta: delta,
        ...(cue ? { matchedPhrase: cue.phrase, transferHint: cue.transferHint } : {}),
        accepted,
      };
    },

    rampSensitivity() {
      // §6.7: at most three steps, and never below the non-hold baseline. On a
      // twenty-minute hold an unbounded ramp would run about 150 times.
      rampStep = Math.min(MAX_RAMP_STEPS, rampStep + 1);
      return { step: rampStep, effectiveMinWeight: effectiveMinWeight() };
    },

    setHoldMode(hold: boolean): void {
      if (hold === onHold) return;
      onHold = hold;
      rampStep = 0; // a new hold starts at the elevated bar
    },

    noteAgentSpoke(atMs: number): void {
      agentSpokeAtMs = atMs;
    },

    endTurn(): void {
      const words = utterance.trim().split(/\s+/).filter(Boolean).length;
      if (words > 0) turnLengths.push(words);
      utterance = '';
    },

    reset(): void {
      utterance = '';
      agentSpokeAtMs = null;
      turnLengths.length = 0;
      rampStep = 0;
      onHold = false;
    },
  };
}

/** 0 for turns all one length (a script), approaching 1 as they vary (§6.2). */
export function varianceScore(lengths: readonly number[]): number {
  if (lengths.length < 3) return 0;
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  if (mean === 0) return 0;
  const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length);
  return Math.min(1, sd / mean / 0.6);
}
