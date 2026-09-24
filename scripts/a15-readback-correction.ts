/**
 * A-15 — a correction during read-back is captured as a mismatch. Module 3.5.
 *
 *   "20 read-backs interrupted at the third character. confirm_readback(matched:
 *    false) in 20/20; ZERO wrong numbers recorded."
 *
 * This is the failure READBACK exists for. A-24 showed that capture is exact
 * when recognition is clean; what READBACK protects against is recognition that
 * was already wrong before the model saw it (ADR-020). The representative hears
 * a number that is not theirs and cuts in — mid-number, not politely at the end
 * — and the system has to treat that interruption as a correction rather than
 * as noise.
 *
 * SHAPE OF ONE TRIAL
 *   1. The agent is told a number was captured and is asked to read it back.
 *   2. While it is still reading, after roughly the third character, the
 *      representative's correction is played over it ("no, that's ... ").
 *   3. The trial passes when the model calls confirm_readback(matched: false)
 *      carrying the CORRECTED value, and fails if it calls matched: true, calls
 *      nothing, or records the original number.
 *
 * Cost: one session and twenty turns, roughly ten minutes. Run deliberately.
 *
 *   pnpm a15               20 trials
 *   pnpm a15 --count=5     a shorter run
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
const COUNT = Number(arg('count') ?? 20);
const AUDIO_DIR = path.join(ROOT, 'logs', 'a15-audio');
/** Roughly where the third character lands in the agent's read-back. */
const INTERRUPT_AFTER_MS = Number(arg('interrupt') ?? 1800);
/**
 * ADR-020's first lever. The first run lost two values to one recognizer error:
 * the spoken digit "four" transcribed as the word "for", so "E four seven six"
 * became "E for 76" and a digit vanished before the model ever saw it. That is
 * an ASR failure of exactly A-24's kind, and `transcription_prompt` is the
 * documented lever for it. Both configurations are kept so the comparison is
 * reproducible, and both are reported.
 */
const WITH_PROMPT = process.argv.includes('--prompt');
const TRANSCRIPTION_PROMPT =
  'A health plan representative is correcting an alphanumeric prior authorization number, spoken letter by letter and digit by digit. ' +
  'Transcribe every spoken digit as a digit — "four" is 4, never the word "for" — and do not group digits into larger numbers.';

const NATO: Record<string, string> = {
  A: 'alpha', B: 'bravo', C: 'charlie', D: 'delta', E: 'echo', F: 'foxtrot', G: 'golf', H: 'hotel',
  K: 'kilo', L: 'lima', M: 'mike', N: 'november', P: 'papa', Q: 'quebec', R: 'romeo', S: 'sierra',
  T: 'tango', V: 'victor', W: 'whiskey', X: 'x-ray', Z: 'zulu',
};
const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** The number the system believes it captured, and the one the representative actually has. */
type Trial = { believed: string; actual: string };

function trials(count: number): Trial[] {
  let seed = 20260925;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const letters = Object.keys(NATO);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const digits = (n: number) => Array.from({ length: n }, () => String(Math.floor(rnd() * 10))).join('');

  const out: Trial[] = [];
  while (out.length < count) {
    const believed = `${pick(letters)}${digits(3)}-${digits(2)}`;
    // The correction differs in ONE character, as a real mis-recognition does:
    // a wholly different number would be an easier case than the real one.
    const at = 1 + Math.floor(rnd() * 3);
    const digitsOnly = believed.replace('-', '');
    const changed = String((Number(digitsOnly[at]) + 1 + Math.floor(rnd() * 8)) % 10);
    const actual = `${believed.slice(0, at)}${changed}${believed.slice(at + 1)}`;
    if (actual !== believed && !out.some((t) => t.believed === believed)) out.push({ believed, actual });
  }
  return out;
}

function spokenCorrection(actual: string): string {
  const parts: string[] = [];
  for (const token of actual.match(/[A-Z]|\d+|-/g) ?? []) {
    if (token === '-') parts.push('dash');
    else if (/\d/.test(token)) for (let i = 0; i < token.length; i += 2) parts.push(token.slice(i, i + 2).split('').map((d) => DIGIT_WORDS[Number(d)]!).join(' '));
    else parts.push(NATO[token] ? `${token} as in ${NATO[token]}` : token);
  }
  // Cutting in, the way somebody corrects a wrong number: no preamble.
  return `No, sorry, that's not it. It's ${parts.join(', ')}.`;
}

function render(text: string, file: string): Uint8Array[] {
  if (!fs.existsSync(file)) {
    const mp3 = `${file}.mp3`;
    const { voice, rate } = ROLE_VOICES.rep1;
    execFileSync('edge-tts', ['--voice', voice, `--rate=${rate}`, '--text', text, '--write-media', mp3], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3, '-af', 'loudnorm=I=-19:TP=-2:LRA=11', '-ar', '8000', '-ac', '1', '-f', 'mulaw', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    fs.rmSync(mp3, { force: true });
  }
  return chunkToFrames(new Uint8Array(fs.readFileSync(file)));
}

const CONFIRM_READBACK: ToolDefinition = {
  name: 'confirm_readback',
  description: 'Call after reading the authorization number back. Set matched to true only if the representative explicitly confirmed it. If they corrected you, set matched to false and put their corrected version in corrected_value.',
  parameters: {
    type: 'object',
    properties: {
      matched: { type: 'boolean', description: 'True only on an explicit confirmation. Silence is not confirmation.' },
      corrected_value: { type: 'string', description: 'Required when matched is false and the representative gave a different number.' },
    },
    required: ['matched'],
  },
};

const SYSTEM_PROMPT =
  'You are on a telephone call with a health insurance representative, reading an authorization number back to them. ' +
  'Read exactly the number you are given, character by character, and ask them to confirm it. ' +
  'If they confirm, call confirm_readback with matched true. ' +
  'If they correct you at any point, stop immediately, treat the correction as authoritative, and call confirm_readback ' +
  'with matched false and their corrected value in corrected_value. A correction always outranks what you believed you heard.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Result = { believed: string; actual: string; matched: boolean | null; corrected: string | null; pass: boolean; separatorOnly: boolean; heard: string };

const results: Result[] = [];
const set = trials(COUNT);
fs.mkdirSync(AUDIO_DIR, { recursive: true });
const corrections = new Map(set.map((t) => [t.actual, render(spokenCorrection(t.actual), path.join(AUDIO_DIR, `${t.actual.replace(/[^A-Za-z0-9]/g, '_')}.ul`))]));
console.log(`audio ready for ${corrections.size} corrections\n`);

const call: { matched: boolean | null; corrected: string | null } = { matched: null, corrected: null };
const heard: string[] = [];
/** ADR-022 refuses createReply while a reply is outstanding, so the rig waits. */
const reply = { outstanding: false };

const session = new AgentSession({
  url: (process.env['ASSEMBLYAI_WS_URL'] ?? 'wss://agents.assemblyai.com/v1/ws').trim(),
  apiKey: KEY,
  socket: (url, headers) => new WebSocket(url, { headers }),
  guard: () => ({ gateIntent: 'open', holdSuspected: false }),
  enableInterruptionDelay: true,
});
session.onToolCall((id, name, args) => {
  if (name !== 'confirm_readback') return;
  const a = args as { matched?: unknown; corrected_value?: unknown };
  call.matched = a.matched === true;
  call.corrected = typeof a.corrected_value === 'string' ? a.corrected_value : null;
  session.queueToolResult(id, { ok: true });
});
session.onTurn((speaker, text) => { if (speaker === 'far_end') heard.push(text); });
session.onReplyStarted(() => { reply.outstanding = true; });
session.onReplyDone(() => { reply.outstanding = false; });

try {
  await session.connect({
    systemPrompt: SYSTEM_PROMPT,
    tools: [CONFIRM_READBACK],
    transcriptionMode: 'max_accuracy',
    keyterms: ['authorization number', 'as in', 'dash'],
    ...(WITH_PROMPT ? { transcriptionPrompt: TRANSCRIPTION_PROMPT } : {}),
    // READBACK's whole point: a correction arrives as an interruption (§7.5).
    interruptResponse: true,
    interruptionDelayMs: 800,
    voice: 'michael',
    inputFormat: 'audio/pcmu',
    outputFormat: 'audio/pcmu',
  });

  for (const [index, trial] of set.entries()) {
    call.matched = null;
    call.corrected = null;
    heard.length = 0;

    // The previous turn's acknowledgement may still be playing, and ADR-022
    // refuses a reply on top of a reply. Wait for the line to be clear, keeping
    // silence flowing so the endpointer can close the turn.
    const clear = Date.now() + 10000;
    while (reply.outstanding && Date.now() < clear) {
      session.sendAudio(new Uint8Array(BYTES_PER_FRAME).fill(0xff));
      await sleep(FRAME_MS);
    }

    // Ask for the read-back, then interrupt it mid-number.
    await session.createReply(
      'silence_recovery',
      `Read this authorization number back to the representative, character by character, and ask them to confirm it: ${trial.believed}. Read exactly that value.`,
    );
    await sleep(INTERRUPT_AFTER_MS);
    for (const frame of corrections.get(trial.actual)!) {
      session.sendAudio(frame);
      await sleep(FRAME_MS);
    }
    for (let i = 0; i < 40; i++) {
      session.sendAudio(new Uint8Array(BYTES_PER_FRAME).fill(0xff));
      await sleep(FRAME_MS);
    }
    const until = Date.now() + 8000;
    while (call.matched === null && Date.now() < until) {
      // Keep the stream running: the endpointer notices a pause in audio that
      // arrives, not in audio that stops. A wait loop that sends nothing leaves
      // the turn open and the tool call never comes.
      session.sendAudio(new Uint8Array(BYTES_PER_FRAME).fill(0xff));
      await sleep(FRAME_MS);
    }

    // Two tiers, because the first run showed the model returning "Q94085" for
    // a correction of "Q940-85": the separator is dropped even though the
    // transcript carried it. ADR-020 forbids normalizing that away, so a
    // separator-only difference is NOT a pass — but it is a different finding
    // from a wrong number, and reporting them as one number would hide it.
    const strip = (v: string | null) => (v === null ? null : v.replace(/[^A-Za-z0-9]/g, '').toUpperCase());
    const pass = call.matched === false && call.corrected === trial.actual;
    const separatorOnly = !pass && call.matched === false && strip(call.corrected) === strip(trial.actual);
    results.push({ ...trial, matched: call.matched, corrected: call.corrected, pass, separatorOnly, heard: heard.join(' ') });
    console.log(
      `  ${String(index + 1).padStart(2)}/${set.length} ${pass ? 'ok  ' : separatorOnly ? 'SEP ' : 'MISS'} believed ${trial.believed.padEnd(9)} actual ${trial.actual.padEnd(9)} ` +
        `matched=${String(call.matched).padEnd(5)} corrected=${String(call.corrected).padEnd(9)}${pass ? '' : ` | heard: ${heard.join(' ').slice(0, 70)}`}`,
    );
  }
} finally {
  await session.end();
  const passed = results.filter((r) => r.pass).length;
  const sep = results.filter((r) => r.separatorOnly).length;
  // A wrong number is one the far end never said. A separator dropped from a
  // number they did say is counted on its own line: ADR-020 still rejects it,
  // but folding the two together would hide which failure this is.
  const wrongRecorded = results.filter((r) => r.matched === true || (r.corrected !== null && !r.pass && !r.separatorOnly)).length;
  console.log(`\nA-15: confirm_readback(matched:false) carrying the corrected value exactly in ${passed}/${results.length}; correct but with the separator dropped in ${sep}; wrong numbers accepted: ${wrongRecorded}`);
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, WITH_PROMPT ? 'results/a15-readback-prompt.json' : 'results/a15-readback.json'),
    JSON.stringify({ experiment: 'A-15', transcriptionPrompt: WITH_PROMPT, ranAt: new Date().toISOString(), interruptAfterMs: INTERRUPT_AFTER_MS, passed, separatorOnly: sep, wrongRecorded, results }, null, 2) + '\n',
  );
}
