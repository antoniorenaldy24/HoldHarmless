/**
 * Does the classifier hold its calibration figures on this audio? — §6.1, §6.6,
 * module 4.1's second acceptance criterion.
 *
 * Every threshold in `packages/classifier/src/acoustic.ts` was measured on
 * RENDERED audio. Its own header says so, and §6.6 names the risk that leaves:
 * "`HUMAN_REP` on stage is a live person whose acoustics are absent from the
 * calibration set." The failure is concrete — if a human voice at 8 kHz measures
 * closer to hold music than to a rendered line, the acoustic layer reports
 * `PERIODIC` while the representative is talking, `holdSuspected` is set, the
 * gate closes, and the agent goes mute in the middle of a conversation.
 *
 * This script is what decides that question, on whatever audio it is given.
 *
 *   pnpm mic-check --assets                  the rendered rep1 lines
 *   pnpm mic-check --sweep                   regenerate §6.7's margin table
 *   pnpm mic-check --file <path>             a recording (docs/recording-script.md)
 *   pnpm mic-check --device "<name>"         one live turn from the microphone
 *
 * WHAT EACH MODE PROVES, AND WHAT IT DOES NOT.
 *
 * `--assets` proves the PATH is neutral: the same bytes that produced the
 * recorded thresholds, pushed through `micTurn` and the same windows, must still
 * produce them. That is a real check and it needs no recording — and until the
 * recordings exist it is the only part of criterion 2 that can be answered.
 *
 * `--file` and `--device` are what answer the rest, and they cannot be faked:
 * the audio has to come from a person. `--file` applies the same loudness
 * normalization the rendered assets get (§10.2), so a recording is compared
 * like for like; `--device` does not, because loudnorm's lookahead would dwarf
 * the latency this path exists to measure (microphone.ts), so a live figure is
 * reported with its level alongside.
 *
 * THE BAR. A human turn must never be classified `PERIODIC`. Not "rarely" —
 * once is a gate closing on a live conversation. The signal values are printed
 * next to the ranges acoustic.ts recorded so a near miss is visible before it
 * becomes a miss.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BYTES_PER_FRAME, FRAME_MS, muLaw } from '@holdharmless/audio';
import { createSignalWindows } from '@holdharmless/audio';
import { ACOUSTIC_MARGIN, SILENCE_RMS, createAcousticClassifier } from '@holdharmless/classifier';
import { ASSET_DIR, ScriptedMicrophone, SPEECH_RMS, frameRms, micTurn } from '@holdharmless/ivr-harness';
import type { AcousticClass } from '@holdharmless/events';

/** The table in acoustic.ts's header, as data, so a drift is a diff. */
const RECORDED = {
  'hold music': { pauseRatio: [0.0, 0.0], spectralFlatness: [0.0015, 0.0015], autocorrelation: [0.6, 0.6] },
  'representative lines (rendered)': { pauseRatio: [0.4, 0.46], spectralFlatness: [0.008, 0.043], autocorrelation: [0.02, 0.05] },
} as const;

type Args = { assets: boolean; sweep: boolean; file?: string; device?: string; seconds: number };

const need = (v: string | undefined, flag: string): string => {
  if (v === undefined) throw new Error(`${flag} needs a value`);
  return v;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { assets: false, sweep: false, seconds: 12 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--assets') out.assets = true;
    else if (a === '--sweep') out.sweep = true;
    else if (a === '--file') out.file = need(argv[++i], '--file');
    else if (a === '--device') out.device = need(argv[++i], '--device');
    else if (a === '--seconds') out.seconds = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.assets && !out.sweep && !out.file && !out.device) throw new Error('one of --assets, --sweep, --file, --device is required');
  return out;
}

function framesOf(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i + BYTES_PER_FRAME <= bytes.length; i += BYTES_PER_FRAME) out.push(bytes.slice(i, i + BYTES_PER_FRAME));
  return out;
}

/**
 * Any input file to μ-law 8 kHz mono, loudness-normalized exactly as §10.2
 * normalizes a rendered asset. The normalization is the point: without it, a
 * recording made at a different microphone gain would be compared against
 * thresholds measured on normalized audio, and every difference found would be
 * the gain rather than the voice.
 */
function decodeFile(file: string): Uint8Array[] {
  if (file.endsWith('.ul')) return framesOf(new Uint8Array(fs.readFileSync(file)));
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-af', 'loudnorm=I=-19:TP=-2:LRA=11', '-ar', '8000', '-ac', '1', '-f', 'mulaw', '-'],
    { maxBuffer: 1 << 28 },
  );
  if (r.status !== 0) throw new Error(`ffmpeg could not decode ${file}: ${r.stderr.toString().trim()}`);
  return framesOf(new Uint8Array(r.stdout));
}

function repAssetFrames(): { label: string; frames: Uint8Array[] }[] {
  const dir = path.join(ASSET_DIR, 'rep1');
  if (!fs.existsSync(dir)) throw new Error(`no rendered assets at ${dir} — run \`pnpm render-assets\` first`);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ul'))
    .map((f) => ({ label: f.replace(/\.ul$/, ''), frames: framesOf(new Uint8Array(fs.readFileSync(path.join(dir, f)))) }));
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

type Report = {
  label: string;
  frames: number;
  speechFrames: number;
  meanSpeechRms: number;
  /** Signal values at every observation, so a range can be shown, not a point. */
  ranges: Record<string, [number, number]>;
  winners: Record<string, number>;
  /** Observations whose winner was PERIODIC while the frame had speech in it. */
  periodicOnSpeech: number;
};

/**
 * Runs one clip through the classifier and the same windows the classifier
 * reads, and counts how often each class won.
 *
 * Observations are attributed to speech or to silence by the RMS of the frame
 * that triggered them, because the question is not "does silence measure like
 * silence" — it does — but "does a HUMAN TALKING ever measure as hold audio".
 */
function measure(label: string, frames: readonly Uint8Array[]): Report {
  const classifier = createAcousticClassifier();
  const windows = createSignalWindows();
  const ranges: Record<string, [number, number]> = {};
  const winners: Record<string, number> = {};
  let speechFrames = 0;
  let rmsSum = 0;
  let periodicOnSpeech = 0;

  frames.forEach((frame, i) => {
    const atMs = i * FRAME_MS;
    const pcm = muLaw.decode(frame);
    const rms = frameRms(frame);
    const isSpeech = rms >= SPEECH_RMS;
    if (isSpeech) {
      speechFrames++;
      rmsSum += rms;
    }
    windows.push(pcm, atMs);
    const obs = classifier.push(pcm, atMs);
    if (!obs) return;

    const values: Record<string, number> = {
      rms: windows.rms(),
      pauseRatio: windows.pauseRatio(),
      spectralFlatness: windows.spectralFlatness(),
      autocorrelation: windows.autocorrelationPeak(),
    };
    // Only observations taken while there IS speech describe speech. A pause
    // ratio measured over trailing silence is a fact about the silence.
    if (isSpeech) {
      // Only signals the classifier HAD. A window below its MIN_FILL is absent
      // from `signalsAvailable` and carried no weight in this observation, so
      // printing its value would put a number in the report that nothing was
      // decided from.
      for (const [k, v] of Object.entries(values).filter(([name]) => obs.signalsAvailable.includes(name))) {
        const r = ranges[k];
        ranges[k] = r ? [Math.min(r[0], v), Math.max(r[1], v)] : [v, v];
      }
      if (obs.winner === 'PERIODIC') periodicOnSpeech++;
    }
    const key = obs.accepted ? obs.winner : 'UNKNOWN';
    winners[key] = (winners[key] ?? 0) + 1;
  });

  return { label, frames: frames.length, speechFrames, meanSpeechRms: speechFrames > 0 ? rmsSum / speechFrames : 0, ranges, winners, periodicOnSpeech };
}

const f3 = (n: number) => n.toFixed(4).padStart(8);

function printReport(r: Report): void {
  const total = Object.values(r.winners).reduce((a, b) => a + b, 0) || 1;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  console.log(`\n  ${r.label}`);
  console.log(`    ${r.frames} frames (${((r.frames * FRAME_MS) / 1000).toFixed(1)} s), ${r.speechFrames} with speech, mean speech RMS ${Math.round(r.meanSpeechRms)}`);
  for (const name of ['pauseRatio', 'spectralFlatness', 'autocorrelation'] as const) {
    const range = r.ranges[name];
    if (!range) continue;
    const rendered = RECORDED['representative lines (rendered)'][name];
    const music = RECORDED['hold music'][name];
    // "Nearer" is the whole question: the recorded numbers are far apart, and a
    // human voice has to sit on the speech side of the gap.
    const midpoint = (rendered[0] + music[0]) / 2;
    const speechSide = rendered[0] > music[0] ? range[0] > midpoint : range[1] < midpoint;
    console.log(
      `    ${name.padEnd(17)} ${f3(range[0])} – ${f3(range[1])}   rendered ${f3(rendered[0])}–${f3(rendered[1])}   music ${f3(music[0])}   ${speechSide ? 'speech side' : '** MUSIC SIDE **'}`,
    );
  }
  const order: (AcousticClass | 'UNKNOWN')[] = ['SPEECH_LIKE', 'PERIODIC', 'SILENCE', 'UNKNOWN'];
  console.log(`    winners: ${order.map((k) => `${k} ${pct(r.winners[k] ?? 0)}`).join('   ')}`);
  console.log(`    PERIODIC while speaking: ${r.periodicOnSpeech}   ${r.periodicOnSpeech === 0 ? 'PASS' : '** FAIL — this is the gate closing mid-conversation **'}`);
}

// ---------------------------------------------------------------------------

async function liveTurn(device: string, seconds: number): Promise<Uint8Array[]> {
  const { FfmpegMicrophone } = await import('@holdharmless/ivr-harness');
  const mic = new FfmpegMicrophone({ device });
  console.log(`opening "${device}" — speak when it says GO, then stop and stay quiet`);
  await mic.open();
  console.log(`   device open in ${Math.round(mic.startupLatencyMs ?? 0)} ms\n   GO`);
  const turn = micTurn({ source: mic, emit: () => {}, maxMs: seconds * 1000 });
  const result = await turn.done;
  await mic.close();
  console.log(`   turn ended by ${result.endedBy}; ${result.frames.length} frames`);
  if (result.frameDelaysMs.length > 0) {
    const sorted = [...result.frameDelaysMs].sort((a, b) => a - b);
    console.log(`   frame delay: median ${Math.round(sorted[Math.floor(sorted.length / 2)]!)} ms, max ${Math.round(sorted[sorted.length - 1]!)} ms`);
  }
  if (result.frames.length === 0) throw new Error('nothing was recorded — is the microphone muted?');
  return result.frames;
}

/**
 * What the classifier is measured on, and why it is NOT the turn's frames.
 *
 * The first version of this script pushed each clip through `micTurn` and
 * measured what came out. That was wrong, and wrong in the direction that
 * invents failures: `micTurn` drops everything before onset (microphone.ts says
 * why), so the clip's own leading silence disappeared, the 2 s pause-ratio
 * window filled with nothing but voiced speech, the ratio fell to 0.000 — the
 * hold-music value — and a clean line was reported as PERIODIC. The measurement
 * had created the condition it then reported.
 *
 * The classifier is fed from what the CORE receives, continuously, silence
 * included. So the clip is measured whole. `micTurn` is used here for the turn's
 * OWN figures — how it ended, its level, how many frames it forwarded — and
 * those are reported separately.
 *
 * One consequence worth stating for whoever wires the classifier into the core:
 * silence on the line has to be PUSHED as silence frames. `createSignalWindows`
 * keeps its window by timestamp, so an absence of frames is not a pause — it is
 * fewer samples over which the same ratio is computed. A feed that goes quiet
 * when the far end goes quiet would starve the pause-ratio signal of the one
 * thing that defines it.
 */
async function turnFigures(frames: readonly Uint8Array[]): Promise<string> {
  const mic = new ScriptedMicrophone([]);
  const out: Uint8Array[] = [];
  const turn = micTurn({ source: mic, emit: (f) => out.push(f), silenceMs: 700 });
  const handlers = (mic as unknown as { handlers: ((f: { frame: Uint8Array; capturedAtMs: number; delayMs: number }) => void)[] }).handlers;
  frames.forEach((frame, i) => {
    for (const h of handlers) h({ frame, capturedAtMs: i * FRAME_MS, delayMs: 0 });
  });
  turn.stop();
  const r = await turn.done;
  return `turn gate: ${out.length}/${frames.length} frames forwarded, ended by ${r.endedBy}, speech RMS ${Math.round(r.speechRms)}`;
}

// ---------------------------------------------------------------------------
// --sweep: §6.7's margin table, regenerated
// ---------------------------------------------------------------------------

/**
 * Regenerates the table in §6.7 — every value of `ACOUSTIC_MARGIN` against
 * every criterion this layer has at once.
 *
 * It exists because the first version of that table was produced by a throwaway
 * script, which made it a remembered measurement rather than a reproducible one.
 * The two tests in `packages/classifier/test/acoustic.test.ts` pin the EDGES —
 * that the chosen margin keeps hold onset under 1.5 s and that one step up does
 * not, and that the margin more than halves the false closures — and this
 * regenerates the whole curve the choice was made from.
 *
 * The audio is the classifier tests' own generators, reproduced here rather than
 * imported because they live in a test file. Any divergence would make a figure
 * here and a figure there mean different things, so the speech generator is
 * copied verbatim, comments and all.
 */
async function sweepMargin(): Promise<void> {
  const { createAcousticClassifier, EMIT_INTERVAL_MS } = await import('@holdharmless/classifier');
  const { holdMusicPcm } = await import('@holdharmless/ivr-harness');
  const { SAMPLE_RATE } = await import('@holdharmless/audio');

  /** Bursts of correlated noise separated by pauses — acoustic.test.ts's. */
  const syntheticSpeech = (seconds: number): Int16Array => {
    const out: number[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const uniform = (lo: number, hi: number) => lo + ((rnd() + 1) / 2) * (hi - lo);
    let prev = 0;
    while (out.length < seconds * SAMPLE_RATE) {
      const burst = Math.round(SAMPLE_RATE * uniform(0.18, 0.55));
      for (let i = 0; i < burst; i++) {
        prev = 0.6 * rnd() + 0.4 * prev;
        out.push(Math.round(prev * 9000));
      }
      const pause = Math.round(SAMPLE_RATE * uniform(0.1, 0.35));
      for (let i = 0; i < pause; i++) out.push(0);
    }
    return Int16Array.from(out.slice(0, seconds * SAMPLE_RATE));
  };

  type Obs = { winner: string };
  const feed = (
    c: ReturnType<typeof createAcousticClassifier>,
    source: Int16Array,
    seconds: number,
    opts: { startMs?: number } = {},
  ): Obs[] => {
    const out: Obs[] = [];
    const frames = Math.round((seconds * SAMPLE_RATE) / 160);
    for (let f = 0; f < frames; f++) {
      const frame = new Int16Array(160);
      for (let j = 0; j < 160; j++) frame[j] = source[(f * 160 + j) % source.length]!;
      const o = c.push(frame, (opts.startMs ?? 0) + f * 20);
      if (o) out.push(o);
    }
    return out;
  };

  const MUSIC = holdMusicPcm();
  const SPEECH30 = syntheticSpeech(30);
  const SPEECH25 = syntheticSpeech(25);
  const assets = repAssetFrames();

  const onsetMs = (margin: number): number => {
    const c = createAcousticClassifier({ margin });
    feed(c, SPEECH30, 30);
    const i = feed(c, MUSIC, 4, { startMs: 30_000 }).findIndex((o) => o.winner === 'PERIODIC');
    return i < 0 ? Infinity : (i + 1) * EMIT_INTERVAL_MS;
  };

  const lastWinner = (margin: number, src: Int16Array): string =>
    feed(createAcousticClassifier({ margin }), src, 25).at(-1)!.winner;

  const mixed = Int16Array.from(SPEECH25, (v, i) => v + Math.round(MUSIC[i % MUSIC.length]! * 0.2));

  const falseCloses = (margin: number): { lines: number; obs: number } => {
    let lines = 0;
    let obs = 0;
    for (const { frames } of assets) {
      const c = createAcousticClassifier({ margin });
      let hits = 0;
      frames.forEach((frame, i) => {
        const o = c.push(muLaw.decode(frame), i * FRAME_MS);
        if (o?.winner === 'PERIODIC' && frameRms(frame) >= SPEECH_RMS) hits++;
      });
      if (hits > 0) lines++;
      obs += hits;
    }
    return { lines, obs };
  };

  console.log(`\n--sweep: §6.7's table, on ${assets.length} rendered rep1 lines and the classifier tests' own audio.`);
  console.log('The chosen value is the largest one that costs nothing: see ACOUSTIC_MARGIN in acoustic.ts.\n');
  console.log('  margin   mutes the agent        hold onset   music      speech       speech over music');
  for (const margin of [0, 0.02, 0.04, 0.05, 0.06, 0.08, 0.1, 0.15, 0.2]) {
    const fc = falseCloses(margin);
    const on = onsetMs(margin);
    const mark = margin === ACOUSTIC_MARGIN ? ' <- ACOUSTIC_MARGIN' : on > 1500 ? '  (past the 1.5 s bar)' : '';
    console.log(
      `  ${margin.toFixed(2)}     ${String(fc.lines).padStart(2)}/${assets.length} lines, ${String(fc.obs).padStart(2)} obs   ` +
        `${(on === Infinity ? 'never' : `${on} ms`).padStart(8)}   ${lastWinner(margin, MUSIC).padEnd(10)} ` +
        `${lastWinner(margin, SPEECH25).padEnd(12)} ${lastWinner(margin, mixed)}${mark}`,
    );
  }
  console.log('\n"mutes the agent" = observations classified PERIODIC while the frame contained speech.');
  console.log('§6.5 sets holdSuspected on ONE of those, and ADR-007 closes the gate on holdSuspected.');
}

if (parseArgs(process.argv.slice(2)).sweep) {
  await sweepMargin();
  process.exit(process.exitCode ?? 0);
}

const args = parseArgs(process.argv.slice(2));
const reports: Report[] = [];
const turnNotes: string[] = [];

console.log(`speech threshold ${SPEECH_RMS} RMS; classifier silence floor ${SILENCE_RMS} RMS`);

if (args.assets) {
  console.log('\n--assets: the rendered rep1 lines, pushed through the live path.');
  console.log('This answers only whether the PATH moved the figures. Human acoustics need --file or --device (§6.6).');
  for (const { label, frames } of repAssetFrames()) {
    reports.push(measure(label, frames));
    turnNotes.push(`${label}: ${await turnFigures(frames)}`);
  }
}

if (args.file) {
  console.log(`\n--file ${args.file}: loudness-normalized as §10.2 normalizes an asset (§10.2's own chain).`);
  const fileFrames = decodeFile(args.file);
  reports.push(measure(path.basename(args.file), fileFrames));
  turnNotes.push(`${path.basename(args.file)}: ${await turnFigures(fileFrames)}`);
}

if (args.device) {
  console.log('\n--device: one live turn. NOT loudness-normalized — see microphone.ts.');
  reports.push(measure(`live: ${args.device}`, await liveTurn(args.device, args.seconds)));
}

for (const r of reports) printReport(r);
if (turnNotes.length > 0) {
  console.log('\nthe turn gate, on the same clips:');
  for (const n of turnNotes) console.log(`  ${n}`);
}

const failed = reports.filter((r) => r.periodicOnSpeech > 0);
const speechless = reports.filter((r) => r.speechFrames === 0);
console.log('');
if (speechless.length > 0) {
  console.log(`INCONCLUSIVE: ${speechless.length} clip(s) had no frame above the speech threshold: ${speechless.map((r) => r.label).join(', ')}`);
}
if (failed.length > 0) {
  console.log(`FAIL: ${failed.length} clip(s) were classified PERIODIC while speech was present: ${failed.map((r) => r.label).join(', ')}`);
  process.exitCode = 1;
} else if (reports.length > speechless.length) {
  console.log(`PASS: no clip was classified PERIODIC while speech was present (${reports.length - speechless.length} clip(s)).`);
}
