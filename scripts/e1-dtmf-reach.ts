/**
 * E1 — DTMF timing sweep. Closes A-1 (§20 week 1, §21 1.11).
 *
 *   "Generate tones, decode with Goertzel across the transport under TELEPHONY,
 *    at 100/50 ms and then downward. Record the lowest timing still at 20/20.
 *    If 20/20 is unreachable at any timing, set IVR_NAV_MODE=speech."
 *
 * The path is the real one: tones from the audio package, paced at the frame
 * cadence by the same Pacer the harness uses, through LoopbackTransport and the
 * TELEPHONY delay line, into the far end's playout queue, and decoded from what
 * the far end's SPEAKER emits — comfort silence included where the queue
 * underflows (§4.4), because that is what a listener hears.
 *
 * Stricter than the letter of E1 in one way: each timing is run TRIALS times,
 * and passes only if every trial is 20/20. One lucky run of 20 is not evidence
 * of a timing that works; jitter is random.
 *
 *   pnpm e1              full sweep, writes results/e1-dtmf.json
 *   pnpm e1 --quick      100/50 only
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_RATE, chunkToFrames, createGoertzelDetector, dtmf, MULAW_SILENCE } from '@holdharmless/audio';
import { PROFILES, raiseTimerResolution, type NetworkProfile } from '@holdharmless/transport';
import { LoopbackEndpoint, LoopbackTransport, type FarEndSession } from '@holdharmless/transport-loopback';
import { Pacer } from '@holdharmless/ivr-harness';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 20 digits: every key the agent can send, plus four immediate repeats. A
 * repeat is the hard case for the gap — too short a gap and "55" decodes as "5".
 */
const DIGITS = '0123456789*#55443300';
/**
 * Each trial starts the tone stream at a different offset within a 20 ms frame.
 * The first sweep ran three trials all starting on a frame boundary and got
 * IDENTICAL scores in every cell (17/17/17 at 70/20): the outcome was set by
 * where tones fell against the frame and window grid, not by jitter, so the
 * three trials were one observation repeated. Offsets make them independent.
 */
const OFFSETS_MS = [0, 4, 8, 12, 16];
const TRIALS = OFFSETS_MS.length;
const TONES = [100, 80, 70, 60, 50, 40];
const GAPS = [50, 40, 30, 20];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longest common subsequence: digits decoded in the right order. */
function lcs(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}

type Trial = { decoded: string; correct: number; inserted: number; underflows: number };
type Cell = { profile: string; toneMs: number; gapMs: number; trials: Trial[]; pass: boolean };

async function runProfile(name: 'TELEPHONY' | 'DEGRADED', timings: [number, number][]): Promise<Cell[]> {
  const profile: NetworkProfile = PROFILES[name];
  const endpoint = await LoopbackEndpoint.listen({ port: 0, profile });
  // A holder rather than a `let`: assigned inside a callback, which the
  // compiler's narrowing cannot see.
  const link: { far: FarEndSession | null } = { far: null };
  let detector = createGoertzelDetector();
  let decoded = '';
  endpoint.onSession((s) => {
    link.far = s;
    s.onSpeaker((frame) => {
      decoded += detector.push(frame) ?? '';
    });
  });

  const core = new LoopbackTransport();
  await core.dial(endpoint.url(), profile);
  core.applyGate('dtmf_only');
  const pacer = new Pacer((frame) => core.sendAudio(frame, 'dtmf'));
  while (!link.far) await sleep(5);
  const far = link.far;

  const cells: Cell[] = [];
  for (const [toneMs, gapMs] of timings) {
    const trials: Trial[] = [];
    for (let t = 0; t < TRIALS; t++) {
      detector = createGoertzelDetector();
      decoded = '';
      const before = far.underflowCount();
      // 200 ms of lead silence plus the trial's sub-frame offset, then the
      // digits, then 200 ms of tail — as one byte stream, re-cut into frames.
      const lead = new Uint8Array(4 * SAMPLE_RATE / 20 + (OFFSETS_MS[t]! * SAMPLE_RATE) / 1000).fill(MULAW_SILENCE);
      const tones = dtmf.generate(DIGITS, toneMs, gapMs);
      const tail = new Uint8Array(4 * SAMPLE_RATE / 20).fill(MULAW_SILENCE);
      const bytes = new Uint8Array(lead.length + tones.length * tones[0]!.length + tail.length);
      bytes.set(lead, 0);
      tones.forEach((f, k) => bytes.set(f, lead.length + k * f.length));
      bytes.set(tail, bytes.length - tail.length);
      await pacer.play(chunkToFrames(bytes));
      // Let the delay line and the playout queue drain what is in flight.
      await sleep(profile.oneWayDelayMs + profile.jitterMs + 250);
      const correct = lcs(DIGITS, decoded);
      trials.push({ decoded, correct, inserted: decoded.length - correct, underflows: far.underflowCount() - before });
    }
    const pass = trials.every((t) => t.correct === DIGITS.length && t.inserted === 0);
    cells.push({ profile: name, toneMs, gapMs, trials, pass });
    const scores = trials.map((t) => `${t.correct}/${DIGITS.length}${t.inserted ? ` +${t.inserted}` : ''}`).join('  ');
    const uf = trials.map((t) => t.underflows).join('/');
    console.log(`  ${name.padEnd(9)} ${String(toneMs).padStart(3)}/${String(gapMs).padEnd(3)} ms   ${scores.padEnd(24)} underflow ticks ${uf.padEnd(9)} ${pass ? 'PASS' : 'fail'}`);
  }

  await core.hangup();
  await endpoint.close();
  return cells;
}

const timer = raiseTimerResolution();
console.log(`timer resolution: ${timer.detail}`);
console.log(`digits per trial: ${DIGITS} (${DIGITS.length}); trials per timing: ${TRIALS}\n`);

const quick = process.argv.includes('--quick');
const grid: [number, number][] = quick ? [[100, 50]] : TONES.flatMap((t) => GAPS.map((g) => [t, g] as [number, number]));

const telephony = await runProfile('TELEPHONY', grid);
const passing = telephony.filter((c) => c.pass);
const baseline = telephony.find((c) => c.toneMs === 100 && c.gapMs === 50)!;
// "Lowest timing" = shortest time per digit (tone + gap) that still passes.
const lowest = [...passing].sort((a, b) => a.toneMs + a.gapMs - (b.toneMs + b.gapMs) || a.toneMs - b.toneMs)[0];

console.log('\nDEGRADED (robustness only — not the E1 criterion):');
const degraded = await runProfile('DEGRADED', [[100, 50], ...(lowest && !quick ? [[lowest.toneMs, lowest.gapMs] as [number, number]] : [])]);

const summary = {
  experiment: 'E1',
  ranAt: new Date().toISOString(),
  host: { platform: process.platform, release: os.release(), node: process.version, timerResolution: timer.detail },
  digits: DIGITS,
  trialsPerTiming: TRIALS,
  trialOffsetsMs: OFFSETS_MS,
  criterion: 'every trial decodes all 20 digits, in order, with no insertions',
  baseline: { toneMs: 100, gapMs: 50, pass: baseline.pass },
  lowestPassing: lowest ? { toneMs: lowest.toneMs, gapMs: lowest.gapMs, msPerDigit: lowest.toneMs + lowest.gapMs } : null,
  navModeDecision: baseline.pass ? 'dtmf' : passing.length > 0 ? 'dtmf (baseline failed; see lowestPassing)' : 'speech',
  cells: [...telephony, ...degraded],
};

if (!quick) {
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'results/e1-dtmf.json'), JSON.stringify(summary, null, 2) + '\n');
}
console.log(`\nbaseline 100/50: ${baseline.pass ? 'PASS' : 'FAIL'}; lowest passing: ${lowest ? `${lowest.toneMs}/${lowest.gapMs} ms` : 'none'}; IVR_NAV_MODE -> ${summary.navModeDecision}`);
process.exit(baseline.pass ? 0 : 1);
