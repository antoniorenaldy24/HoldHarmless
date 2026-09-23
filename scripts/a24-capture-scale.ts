/**
 * A-24 at scale — module 3.3, closing the assumption Day 0 left at 93.3%.
 *
 * Day 0 (E-AUTH) measured 28 of 30 exact against a 95% bar. Both misses were
 * ASR INSERTIONS upstream of the model: the tool faithfully recorded a
 * transcript that was already wrong, and the model→tool path was 30/30. ADR-020
 * therefore names two levers, and this experiment applies them:
 *
 *   1. `input.transcription_prompt` — mutable per position (ADR-006), and its
 *      purpose is exactly this: bias the recognizer toward a domain.
 *   2. A `pattern` on `capture_auth_number.value` — the API derives its
 *      entity-aware waiting from a tool parameter's description, examples AND
 *      pattern; §8.1 supplies the first two and omits the third.
 *
 * PAIRED, ON ONE SET OF RECORDINGS. Both arms hear the identical audio files,
 * so a difference is the levers and not the rendering. Day 0's numbers cannot
 * be compared directly with these: its rig put a comma between every digit,
 * which caused one of its two failures ("three, three, nine" heard as "331",
 * "9"), and this rig groups digits instead.
 *
 * Cost: one turn per number per arm — 90 turns at the defaults, roughly fifteen
 * minutes of session time. Run deliberately.
 *
 *   pnpm a24                    all three arms, 30 numbers
 *   pnpm a24 --count=10         a shorter run
 *   pnpm a24 --arm=pattern      one arm only
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { BYTES_PER_FRAME, FRAME_MS, chunkToFrames } from '@holdharmless/audio';
import { AgentSession, type ToolDefinition } from '@holdharmless/agent';
import { ROLE_VOICES } from '@holdharmless/ivr-harness';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* shell env */ }
const KEY = process.env['ASSEMBLYAI_API_KEY']?.trim();
if (!KEY) { console.error('ASSEMBLYAI_API_KEY is empty (.env)'); process.exit(1); }

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const COUNT = Number(arg('count') ?? 30);
/**
 * ONE LEVER PER ARM. The first run put both levers in a single "tuned" arm and
 * could not say which of them did what — a basic error, and it mattered: the
 * pattern turned out to SUPPRESS the tool call (16 of 30 captures never
 * happened), which a combined arm would have blamed on the prompt.
 */
type Arm = 'baseline' | 'prompt' | 'pattern';
const ARMS = (arg('arm') ? [arg('arm')!] : ['baseline', 'prompt', 'pattern']) as Arm[];
const AUDIO_DIR = path.join(ROOT, 'logs', 'a24-audio');

// ---------------------------------------------------------------------------
// The numbers, and how a representative says them
// ---------------------------------------------------------------------------

const NATO: Record<string, string> = {
  A: 'alpha', B: 'bravo', C: 'charlie', D: 'delta', E: 'echo', F: 'foxtrot', G: 'golf', H: 'hotel',
  J: 'juliet', K: 'kilo', L: 'lima', M: 'mike', N: 'november', P: 'papa', Q: 'quebec', R: 'romeo',
  S: 'sierra', T: 'tango', V: 'victor', W: 'whiskey', X: 'x-ray', Y: 'yankee', Z: 'zulu',
};
const LETTERS = Object.keys(NATO);
const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** Deterministic, so a re-run renders the same audio and compares like with like. */
function numbers(count: number): string[] {
  let seed = 20260924;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const digits = (n: number) => Array.from({ length: n }, () => String(Math.floor(rnd() * 10))).join('');

  const out: string[] = [];
  while (out.length < count) {
    // Shapes a payer actually issues. The first run of this experiment invented
    // an "AUTH-12345-X" shape, whose literal prefix is not something anyone
    // says: spelled out it produced "Hotel, L", and said as a word it was
    // transcribed "off". Seven and then thirteen failures came from that shape
    // alone — the rig, not the system.
    const shape = out.length % 3;
    const value =
      shape === 0 ? `${pick(LETTERS)}${digits(3)}-${digits(2)}`
      : shape === 1 ? `PA${digits(7)}`
      : `${pick(LETTERS)}${pick(LETTERS)}${digits(4)}`;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * Spoken form, as a representative would actually say it.
 *
 * TWO RIG FAULTS FIXED HERE, both found by running the experiment and reading
 * the failures instead of the score. The first run scored 25/30 and 24/29, and
 * SEVEN of its ten failures were this function's fault:
 *
 *  1. Every letter is spelled with a NATO word, and the VALUES no longer carry
 *     a pronounceable prefix. Run 1 spelled the literal "AUTH" as "A as in
 *     alpha, U as in U, ..." and produced "AUTHL" and "--"; run 2 said it as
 *     the word "auth" and the recognizer heard "off". The shape itself was the
 *     problem, and it was invented by this script.
 *  2. A letter only gets the NATO treatment where the table has a word for it.
 *     "U as in U" is not a disambiguation.
 *
 * Digits stay grouped in pairs: Day 0's comma-per-digit rendering fixed
 * slurring and introduced grouping ambiguity (ADR-020).
 */
function spoken(value: string): string {
  const parts: string[] = [];
  const digitGroups = (run: string) => {
    for (let i = 0; i < run.length; i += 2) {
      parts.push(run.slice(i, i + 2).split('').map((d) => DIGIT_WORDS[Number(d)]!).join(' '));
    }
  };
  for (const token of value.match(/[A-Z]+|\d+|-/g) ?? []) {
    if (token === '-') parts.push('dash');
    else if (/\d/.test(token)) digitGroups(token);
    else if (token.length === 1) parts.push(NATO[token] ? `${token} as in ${NATO[token]}` : token);
    else parts.push(token.split('').map((c) => (NATO[c] ? `${c} as in ${NATO[c]}` : c)).join(', '));
  }
  return `Okay, your authorization number is ${parts.join(', ')}.`;
}

function renderAudio(values: string[]): Map<string, Uint8Array[]> {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const { voice, rate } = ROLE_VOICES.rep1;
  const frames = new Map<string, Uint8Array[]>();
  let rendered = 0;
  for (const value of values) {
    const file = path.join(AUDIO_DIR, `${value.replace(/[^A-Za-z0-9]/g, '_')}.ul`);
    if (!fs.existsSync(file)) {
      const mp3 = `${file}.mp3`;
      execFileSync('edge-tts', ['--voice', voice, `--rate=${rate}`, '--text', spoken(value), '--write-media', mp3], { stdio: ['ignore', 'ignore', 'pipe'] });
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3, '-af', 'loudnorm=I=-19:TP=-2:LRA=11', '-ar', '8000', '-ac', '1', '-f', 'mulaw', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      fs.rmSync(mp3, { force: true });
      rendered++;
    }
    frames.set(value, chunkToFrames(new Uint8Array(fs.readFileSync(file))));
  }
  console.log(`audio: ${rendered} rendered, ${values.length - rendered} cached in ${path.relative(process.cwd(), AUDIO_DIR)}`);
  return frames;
}

// ---------------------------------------------------------------------------

const CAPTURE_TOOL = (withPattern: boolean): ToolDefinition => ({
  name: 'capture_auth_number',
  description: 'Call the moment the representative states the authorization number, before reading anything back. Capture it exactly as spoken, including letters, spelled-out letters, and separators.',
  parameters: {
    type: 'object',
    properties: {
      value: {
        type: 'string',
        minLength: 3,
        description: "The authorization number exactly as the representative said it. If they spelled a letter — 'A as in alpha' — write just the letter. If they said 'dash', write a hyphen.",
        examples: ['A472-91', 'PA0084417', 'AUTH-2291-C'],
        // Lever 2: entity-aware waiting is derived from description, examples
        // AND pattern; §8.1 omits the pattern today.
        ...(withPattern ? { pattern: '^[A-Z0-9-]{3,20}$' } : {}),
      },
      spoken_form: { type: 'string', description: 'Optional: how they said it, if it differed from the value.' },
    },
    required: ['value'],
  },
});

const SYSTEM_PROMPT =
  'You are on a telephone call with a health insurance representative. When they state an authorization number, ' +
  'immediately call capture_auth_number with it exactly as they said it. Then say only a brief acknowledgement of ' +
  'two or three words, such as "Got it, thank you." Never read the number back. Never say anything else.';

/** Lever 1: tell the recognizer what kind of thing it is about to hear. */
const TRANSCRIPTION_PROMPT =
  'A health plan representative is reading an alphanumeric prior authorization number aloud, letter by letter and ' +
  'digit by digit, using phrases like "A as in alpha" and "dash". Transcribe each digit exactly as spoken and do ' +
  'not group digits into larger numbers.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Trial = { value: string; captured: string | null; transcript: string; exact: boolean };

async function runArm(arm: Arm, values: string[], audio: Map<string, Uint8Array[]>): Promise<Trial[]> {
  const withPattern = arm === 'pattern';
  const withPrompt = arm === 'prompt';
  const captured: { value: string | null } = { value: null };
  const transcript: string[] = [];
  const session = new AgentSession({
    url: (process.env['ASSEMBLYAI_WS_URL'] ?? 'wss://agents.assemblyai.com/v1/ws').trim(),
    apiKey: KEY!,
    socket: (url, headers) => new WebSocket(url, { headers }),
    guard: () => ({ gateIntent: 'open', holdSuspected: false }),
    enableInterruptionDelay: false,
  });
  session.onToolCall((id, _name, args) => {
    const value = (args as { value?: unknown }).value;
    captured.value = typeof value === 'string' ? value : null;
    session.queueToolResult(id, { ok: true });
  });
  session.onTurn((speaker, text) => { if (speaker === 'far_end') transcript.push(text); });

  const trials: Trial[] = [];
  try {
    await session.connect({
      systemPrompt: SYSTEM_PROMPT,
      tools: [CAPTURE_TOOL(withPattern)],
      transcriptionMode: 'max_accuracy',
      keyterms: ['authorization number', 'prior authorization', 'as in', 'dash'],
      interruptResponse: false,
      voice: 'michael',
      inputFormat: 'audio/pcmu',
      outputFormat: 'audio/pcmu',
      ...(withPrompt ? { transcriptionPrompt: TRANSCRIPTION_PROMPT } : {}),
    });

    for (const [index, value] of values.entries()) {
      captured.value = null;
      transcript.length = 0;
      const frames = audio.get(value)!;
      for (const frame of frames) {
        session.sendAudio(frame);
        await sleep(FRAME_MS);
      }
      // Silence, so the endpointer closes the turn, then time for the tool call.
      for (let i = 0; i < 40; i++) {
        session.sendAudio(new Uint8Array(BYTES_PER_FRAME).fill(0xff));
        await sleep(FRAME_MS);
      }
      const until = Date.now() + 8000;
      while (captured.value === null && Date.now() < until) await sleep(50);

      const trial: Trial = { value, captured: captured.value, transcript: transcript.join(' '), exact: captured.value === value };
      trials.push(trial);
      console.log(`  ${arm.padEnd(8)} ${String(index + 1).padStart(2)}/${values.length}  ${trial.exact ? 'ok  ' : 'MISS'} spoken ${value.padEnd(12)} captured ${String(trial.captured).padEnd(12)}${trial.exact ? '' : ` | heard: ${trial.transcript.slice(0, 90)}`}`);
    }
  } finally {
    await session.end();
  }
  return trials;
}

// ---------------------------------------------------------------------------

const values = numbers(COUNT);
const audio = renderAudio(values);
const results: Record<string, Trial[]> = {};

const OUT = path.join(ROOT, 'results/a24-capture.json');
/** Written after every arm: a run cut short still leaves what it measured. */
const save = () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const body = { experiment: 'A-24 at scale', ranAt: new Date().toISOString(), count: COUNT, levers: { transcriptionPrompt: TRANSCRIPTION_PROMPT, pattern: '^[A-Z0-9-]{3,20}$' }, results };
  fs.writeFileSync(OUT, JSON.stringify(body, null, 2) + '\n');
};

for (const arm of ARMS) {
  console.log(`\n${arm}:`);
  results[arm] = await runArm(arm, values, audio);
  save();
}

console.log('\nA-24 at scale');
for (const [arm, trials] of Object.entries(results)) {
  const exact = trials.filter((t) => t.exact).length;
  const noCapture = trials.filter((t) => t.captured === null).length;
  console.log(`  ${arm.padEnd(8)} ${exact}/${trials.length} exact (${((exact / trials.length) * 100).toFixed(1)}%), ${noCapture} with no tool call`);
}
const base = results['baseline'];
for (const arm of ['prompt', 'pattern'] as const) {
  const arm_ = results[arm];
  if (!base || !arm_) continue;
  const at = (rs: Trial[], v: string) => rs.find((t) => t.value === v)!;
  const fixed = values.filter((v) => !at(base, v).exact && at(arm_, v).exact);
  const broken = values.filter((v) => at(base, v).exact && !at(arm_, v).exact);
  console.log(`  paired against baseline: ${arm} fixed ${fixed.length}, broke ${broken.length}`);
}

save();
console.log(`\nresults/a24-capture.json written`);
