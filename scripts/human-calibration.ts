/**
 * The owner's recordings against the classifier — §6.6, modules 2.6 and 4.1.
 *
 *   pnpm human-calibration [--dir rekaman]
 *
 * Every acoustic threshold in this system was measured on edge-tts. §6.6 named
 * the risk that leaves — "`HUMAN_REP` on stage is a live person whose acoustics
 * are absent from the calibration set" — and two decisions are waiting on the
 * answer: §6.7's pause-ratio ramp, and A-27's bar. Both were argued on rendered
 * audio "until §6.6's recordings exist". They exist now. This script answers the
 * questions those decisions were left open for, on a human voice:
 *
 *   1. Does human speech ever read PERIODIC while the person is talking?
 *      (Module 4.1's criterion 2. A single yes is the gate closing mid-sentence.)
 *   2. Where does human speech sit on pause ratio, against rendered speech and
 *      against hold music? (What §6.7's ramp is supposed to separate.)
 *   3. §6.7's two options, re-run on human audio: how many clips mute the agent,
 *      and how fast is hold music caught after a HUMAN conversation?
 *   4. How long is a human turn? (A-27: the cost is structurally two of them.)
 *
 * Decoded through the SAME ffmpeg chain as the rendered assets (§10.2: loudnorm,
 * 8 kHz, μ-law), so a difference is the voice and not the encoding.
 *
 * LIMITATIONS, stated here so they travel with every number: one speaker; MP3
 * rather than WAV (lossy, though the 8 kHz μ-law path that follows loses far
 * more than MP3 at 44.1 kHz does); read from a script, so disfluency is lower
 * than a working representative's; no second voice (Block E not recorded).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BYTES_PER_FRAME, FRAME_MS, createSignalWindows, muLaw } from '@holdharmless/audio';
import { ACOUSTIC_MARGIN, EMIT_INTERVAL_MS, PAUSE_RAMP, createAcousticClassifier } from '@holdharmless/classifier';
import { ASSET_DIR, SPEECH_RMS, frameRms, holdMusicMulaw } from '@holdharmless/ivr-harness';

const dirArg = process.argv.indexOf('--dir');
const DIR = path.resolve(dirArg >= 0 ? process.argv[dirArg + 1]! : 'rekaman');

/** §6.7's alternative: the ramp moved into the gap rendered audio showed. */
const GAP_RAMP: readonly [number, number] = [0.01, 0.05];

const framesOf = (bytes: Uint8Array): Uint8Array[] => {
  const out: Uint8Array[] = [];
  for (let i = 0; i + BYTES_PER_FRAME <= bytes.length; i += BYTES_PER_FRAME) out.push(bytes.slice(i, i + BYTES_PER_FRAME));
  return out;
};

/** §10.2's chain, verbatim, so recordings and rendered assets are compared like for like. */
function decode(file: string): Uint8Array[] {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-af', 'loudnorm=I=-19:TP=-2:LRA=11', '-ar', '8000', '-ac', '1', '-f', 'mulaw', '-'],
    { maxBuffer: 1 << 28 },
  );
  if (r.status !== 0) throw new Error(`ffmpeg could not decode ${file}: ${r.stderr.toString().trim()}`);
  return framesOf(new Uint8Array(r.stdout));
}

type Clip = { name: string; block: string; frames: Uint8Array[] };

function loadClips(): Clip[] {
  if (!fs.existsSync(DIR)) throw new Error(`no recordings at ${DIR}`);
  return fs
    .readdirSync(DIR)
    .filter((f) => /\.(mp3|wav|m4a|flac|ogg)$/i.test(f))
    .sort()
    .map((f) => ({ name: f.replace(/\.[^.]+$/, ''), block: f[0]!.toUpperCase(), frames: decode(path.join(DIR, f)) }));
}

// ---------------------------------------------------------------------------

/** Accepted PERIODIC observations taken while the frame had speech in it. */
function periodicOnSpeech(frames: readonly Uint8Array[], pauseRamp: readonly [number, number]): number {
  const c = createAcousticClassifier({ pauseRamp, margin: ACOUSTIC_MARGIN });
  let hits = 0;
  frames.forEach((frame, i) => {
    const o = c.push(muLaw.decode(frame), i * FRAME_MS);
    if (o?.winner === 'PERIODIC' && frameRms(frame) >= SPEECH_RMS) hits++;
  });
  return hits;
}

/**
 * Pause ratio over the classifier's own 2 s window, at its own 250 ms cadence,
 * once the window is half full (its MIN_FILL). `speechOnly` keeps just the
 * windows whose current frame contains speech — right for a voice, wrong for
 * hold music, which is measured whole.
 */
function pauseRatios(frames: readonly Uint8Array[], speechOnly = true): number[] {
  const w = createSignalWindows();
  const out: number[] = [];
  const every = EMIT_INTERVAL_MS / FRAME_MS;
  frames.forEach((frame, i) => {
    w.push(muLaw.decode(frame), i * FRAME_MS);
    if (i * FRAME_MS < 1000 || (i + 1) % every !== 0) return;
    if (!speechOnly || frameRms(frame) >= SPEECH_RMS) out.push(w.pauseRatio());
  });
  return out;
}

/** From the first frame with speech to the last: the turn, without the room either side. */
function speechSpanMs(frames: readonly Uint8Array[]): number | null {
  let first = -1;
  let last = -1;
  frames.forEach((f, i) => {
    if (frameRms(f) >= SPEECH_RMS) {
      if (first < 0) first = i;
      last = i;
    }
  });
  return first < 0 ? null : (last - first + 1) * FRAME_MS;
}

/** Hold music after a HUMAN conversation: how long until the first PERIODIC. */
function holdOnsetMs(conversation: readonly Uint8Array[], music: readonly Uint8Array[], pauseRamp: readonly [number, number]): number {
  const c = createAcousticClassifier({ pauseRamp, margin: ACOUSTIC_MARGIN });
  conversation.forEach((f, i) => c.push(muLaw.decode(f), i * FRAME_MS));
  const start = conversation.length * FRAME_MS;
  let observations = 0;
  for (let i = 0; i < 4000 / FRAME_MS; i++) {
    const o = c.push(muLaw.decode(music[i % music.length]!), start + i * FRAME_MS);
    if (!o) continue;
    observations++;
    if (o.winner === 'PERIODIC') return observations * EMIT_INTERVAL_MS;
  }
  return Infinity;
}

const q = (xs: readonly number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
};
const f3 = (n: number) => n.toFixed(3);

// ---------------------------------------------------------------------------

const clips = loadClips();
const blocks = [...new Set(clips.map((c) => c.block))];
console.log(`${clips.length} recordings from ${DIR}: ${blocks.map((b) => `${b} ${clips.filter((c) => c.block === b).length}`).join(', ')}`);
console.log(`decoded through §10.2's chain; speech threshold ${SPEECH_RMS} RMS; margin ${ACOUSTIC_MARGIN}\n`);

// --- 1. Does human speech ever read PERIODIC? ------------------------------
console.log('1. HUMAN SPEECH CLASSIFIED PERIODIC WHILE TALKING (module 4.1, criterion 2)');
console.log(`   at the ramp in force, ${PAUSE_RAMP.join('-')}:`);
const muted: Record<string, string[]> = {};
let mutedObs = 0;
for (const clip of clips) {
  const n = periodicOnSpeech(clip.frames, PAUSE_RAMP);
  mutedObs += n;
  if (n > 0) (muted[clip.block] ??= []).push(`${clip.name}(${n})`);
}
for (const b of blocks) {
  const total = clips.filter((c) => c.block === b).length;
  const bad = muted[b] ?? [];
  console.log(`   block ${b}: ${String(bad.length).padStart(2)}/${total} clips mute the agent${bad.length ? `  — ${bad.join(' ')}` : ''}`);
}
const mutedClips = Object.values(muted).flat().length;
console.log(`   total: ${mutedClips}/${clips.length} clips, ${mutedObs} observations\n`);

// --- 2. Where human speech sits on pause ratio ----------------------------
console.log('2. PAUSE RATIO OVER THE 2 s WINDOW, ON SPEECH FRAMES');
const human = clips.flatMap((c) => pauseRatios(c.frames));
const rendered: number[] = [];
for (const role of ['ivr', 'rep1', 'rep2']) {
  const d = path.join(ASSET_DIR, role);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.ul'))) {
    rendered.push(...pauseRatios(framesOf(new Uint8Array(fs.readFileSync(path.join(d, f))))));
  }
}
const music = framesOf(holdMusicMulaw());
const musicRatios = pauseRatios([...music, ...music, ...music], false);
const row = (label: string, xs: number[]) =>
  console.log(`   ${label.padEnd(18)} n=${String(xs.length).padStart(4)}  min ${f3(q(xs, 0))}  p05 ${f3(q(xs, 0.05))}  median ${f3(q(xs, 0.5))}  p95 ${f3(q(xs, 0.95))}`);
row('human (you)', human);
row('rendered (edge-tts)', rendered);
row('hold music', musicRatios);
for (const bound of [0.3, 0.1, 0.05, 0.02]) {
  const h = human.filter((x) => x < bound).length;
  console.log(`   human windows below ${bound.toFixed(2)}: ${String(h).padStart(4)}/${human.length}  (${((h / human.length) * 100).toFixed(1)}%)`);
}
console.log('');

// --- 3. §6.7's options, on human audio -------------------------------------
console.log('3. §6.7 RE-RUN ON HUMAN AUDIO');
const longTakes = ['A20', 'A21', 'A22']
  .map((n) => clips.find((c) => c.name === n))
  .filter((c): c is Clip => c !== undefined);
const conversation = (longTakes.length > 0 ? longTakes : clips.filter((c) => c.block === 'A')).flatMap((c) => c.frames);
console.log(`   hold onset measured after ${((conversation.length * FRAME_MS) / 1000).toFixed(1)} s of your own speech (${longTakes.map((c) => c.name).join('+') || 'block A'}), then hold music`);
for (const [label, ramp] of [['in force', PAUSE_RAMP], ['gap', GAP_RAMP]] as const) {
  let mc = 0;
  let mo = 0;
  for (const clip of clips) {
    const n = periodicOnSpeech(clip.frames, ramp);
    mo += n;
    if (n > 0) mc++;
  }
  const onset = holdOnsetMs(conversation, music, ramp);
  console.log(
    `   ramp ${ramp.join('-').padEnd(10)} (${label.padEnd(8)})  mutes the agent: ${String(mc).padStart(2)}/${clips.length} clips, ${String(mo).padStart(3)} obs   ` +
      `hold onset: ${onset === Infinity ? 'NEVER within 4 s' : `${onset} ms`}${onset > 1500 ? '  (past the 1.5 s bar)' : ''}`,
  );
}
console.log('');

// --- 4. How long is a human turn? ------------------------------------------
console.log('4. HUMAN TURN LENGTH (A-27: the cost is structurally two turns)');
const turns = clips
  .filter((c) => c.block === 'A')
  .map((c) => ({ name: c.name, ms: speechSpanMs(c.frames) }))
  .filter((t): t is { name: string; ms: number } => t.ms !== null);
const ms = turns.map((t) => t.ms);
console.log(`   block A, speech span only: n=${ms.length}  min ${q(ms, 0)} ms  p25 ${q(ms, 0.25)}  median ${q(ms, 0.5)}  p75 ${q(ms, 0.75)}  max ${q(ms, 1)}`);
const shortest = [...turns].sort((a, b) => a.ms - b.ms).slice(0, 3);
console.log(`   shortest: ${shortest.map((t) => `${t.name} ${t.ms} ms`).join(', ')}`);
console.log(`   two turns: at minimum ${q(ms, 0) * 2} ms, at median ${q(ms, 0.5) * 2} ms — against A-27's bar of 1500 ms`);
console.log('   (rendered, for comparison: minimum 1872 ms, median 3696 ms)\n');

// --- 5. Is there a ramp that satisfies BOTH criteria? -----------------------
// §6.7 was put to the owner as two points. Two points cannot show whether a
// third exists that costs nothing, so the ramp is swept, against both
// populations and both kinds of conversation a hold can follow.
console.log('5. §6.7 RAMP SWEPT — mutes on BOTH voices, hold onset after BOTH kinds of conversation');
const renderedLines: Uint8Array[][] = [];
const rep1Dir = path.join(ASSET_DIR, 'rep1');
if (fs.existsSync(rep1Dir)) {
  for (const f of fs.readdirSync(rep1Dir).filter((x) => x.endsWith('.ul'))) {
    renderedLines.push(framesOf(new Uint8Array(fs.readFileSync(path.join(rep1Dir, f)))));
  }
}
const renderedConversation = renderedLines.flat();
console.log(`   human: ${clips.length} clips; rendered: ${renderedLines.length} rep1 lines; bar: 0 mutes and onset <= 1500 ms`);
console.log('   ramp         human mutes   rendered mutes   onset after you   onset after edge-tts');
const RAMPS: (readonly [number, number])[] = [
  [0.01, 0.05], [0.02, 0.06], [0.02, 0.08], [0.03, 0.08], [0.03, 0.10],
  [0.05, 0.10], [0.05, 0.15], [0.05, 0.20], [0.10, 0.30],
];
for (const ramp of RAMPS) {
  const hm = clips.filter((c) => periodicOnSpeech(c.frames, ramp) > 0).length;
  const rm = renderedLines.filter((l) => periodicOnSpeech(l, ramp) > 0).length;
  const oh = holdOnsetMs(conversation, music, ramp);
  const or = renderedConversation.length > 0 ? holdOnsetMs(renderedConversation, music, ramp) : NaN;
  const ok = hm === 0 && rm === 0 && oh <= 1500 && or <= 1500;
  const fmt = (n: number) => (n === Infinity ? 'never' : Number.isNaN(n) ? '—' : `${n} ms`);
  console.log(
    `   ${ramp.join('-').padEnd(11)}  ${String(hm).padStart(2)}/${clips.length}         ${String(rm).padStart(2)}/${renderedLines.length}            ` +
      `${fmt(oh).padStart(8)}          ${fmt(or).padStart(8)}${ramp[0] === PAUSE_RAMP[0] && ramp[1] === PAUSE_RAMP[1] ? '   <- in force' : ''}${ok ? '   <- BOTH' : ''}`,
  );
}
console.log('');

console.log('LIMITS: MP3, not WAV; read from a script. Block E is the second representative s lines;');
console.log('        whether it is a genuinely different VOICE is not something this script can tell.');
if (mutedClips > 0) process.exitCode = 1;
