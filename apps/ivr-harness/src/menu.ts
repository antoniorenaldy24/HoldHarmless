/**
 * The IVR menu and its navigator — §10.5 "multi-level menus", "speech
 * navigation", "timeout and repeat".
 *
 * Pure: no audio, no timers. The navigator is told what happened (a digit, a
 * spoken choice, a timeout) and answers with what to play next. Everything
 * timing-related lives in the session that drives it, so the menu logic is
 * testable without a clock.
 */

import type { LineId } from './lines.js';

export type MenuLevel = {
  id: string;
  prompt: LineId;
  /** digit -> next level id, or 'representative' to leave the menu. */
  options: Readonly<Record<string, string>>;
  /**
   * Words that select an option in speech mode, besides the digit's name. The
   * menu names each option before its digit, so a caller may say either.
   */
  keywords?: Readonly<Record<string, readonly string[]>>;
};

export const REPRESENTATIVE = 'representative';

/**
 * Three levels, the depth §21 1.10 names. Only one path reaches a person, as
 * in a real plan's menu: main -> 3 (prior authorization) -> 1 (new request)
 * -> 1 (outpatient). Every other choice is announced as unavailable and the
 * level repeats — the harness does not model eligibility or claims.
 */
export const MENU: readonly MenuLevel[] = [
  {
    id: 'main',
    prompt: 'ivr_main_menu',
    options: { '3': 'priorauth' },
    keywords: { '1': ['eligibility', 'benefits'], '2': ['claims', 'claim'], '3': ['prior authorization', 'authorization', 'prior auth'] },
  },
  {
    id: 'priorauth',
    prompt: 'ivr_priorauth_menu',
    options: { '1': 'service' },
    keywords: { '1': ['new', 'submit', 'new request'], '2': ['status', 'existing'] },
  },
  {
    id: 'service',
    prompt: 'ivr_service_menu',
    options: { '1': REPRESENTATIVE },
    keywords: { '1': ['outpatient', 'procedure', 'imaging'], '2': ['inpatient', 'admission'], '3': ['pharmacy'] },
  },
];

export const NO_INPUT_TIMEOUT_MS = 6000;
/** Repeats of one level before the IVR gives up (§5.7's IVR limit is 3 re-prompts). */
export const MAX_REPEATS = 3;

export type MenuAction =
  /**
   * firstTry: whether the level just LEFT was left on the first input given at
   * it. Meaningful only when `level` differs from the level the input was at.
   */
  | { kind: 'play'; lines: LineId[]; level: string; firstTry: boolean }
  | { kind: 'representative'; lines: LineId[]; path: string[]; firstTry: boolean }
  | { kind: 'goodbye'; lines: LineId[] };

const DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

/**
 * What digit a spoken reply selects at this level, or null.
 *
 * Accepts a digit ("3"), its name ("three"), or an option's keyword ("prior
 * authorization"). Ambiguity — two different options named in one reply — is
 * null rather than a guess: a menu that picks one is teaching the agent that
 * rambling works.
 */
export function parseSpokenChoice(text: string, level: MenuLevel): string | null {
  const words = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const hits = new Set<string>();
  for (const w of words.trim().split(' ')) {
    if (/^\d$/.test(w)) hits.add(w);
    const d = DIGIT_WORDS[w];
    if (d) hits.add(d);
  }
  for (const [digit, keys] of Object.entries(level.keywords ?? {})) {
    if (keys.some((k) => words.includes(` ${k} `))) hits.add(digit);
  }
  return hits.size === 1 ? [...hits][0]! : null;
}

export class MenuNavigator {
  private levelIndex = 0;
  private repeats = 0;
  private attemptsAtLevel = 0;
  private readonly path: string[] = [];

  constructor(private readonly menu: readonly MenuLevel[] = MENU) {
    if (menu.length === 0) throw new Error('empty menu');
  }

  get level(): MenuLevel {
    return this.menu[this.levelIndex]!;
  }

  start(): MenuAction {
    return { kind: 'play', lines: [this.level.prompt], level: this.level.id, firstTry: true };
  }

  /** A DTMF digit, or a spoken choice already parsed to one. */
  choose(digit: string): MenuAction {
    this.attemptsAtLevel++;
    const firstTry = this.attemptsAtLevel === 1;
    const next = this.level.options[digit];
    if (next === undefined) return this.repeat(['ivr_invalid']);

    this.path.push(digit);
    if (next === REPRESENTATIVE) return { kind: 'representative', lines: ['ivr_connecting'], path: [...this.path], firstTry };

    const index = this.menu.findIndex((l) => l.id === next);
    if (index === -1) throw new Error(`menu level "${next}" does not exist`);
    this.levelIndex = index;
    this.repeats = 0;
    this.attemptsAtLevel = 0;
    return { kind: 'play', lines: [this.level.prompt], level: this.level.id, firstTry };
  }

  /** Speech mode. Unparseable speech is treated like an invalid digit. */
  say(text: string): MenuAction {
    const digit = parseSpokenChoice(text, this.level);
    if (digit === null) {
      this.attemptsAtLevel++;
      return this.repeat(['ivr_invalid']);
    }
    return this.choose(digit);
  }

  timeout(): MenuAction {
    return this.repeat(['ivr_no_input']);
  }

  private repeat(preface: LineId[]): MenuAction {
    this.repeats++;
    if (this.repeats > MAX_REPEATS) return { kind: 'goodbye', lines: ['ivr_goodbye_no_input'] };
    return { kind: 'play', lines: [...preface, this.level.prompt], level: this.level.id, firstTry: false };
  }
}
