/**
 * Renders every audio asset the Day-0 experiments need, from text.
 *
 * No microphone required. SSOT §10.2 already renders all harness speech from a
 * chosen TTS offline, for reasons that apply here too: it is deterministic, so a
 * re-run produces identical audio and a regression is attributable; it is free;
 * and it contributes zero latency, so §4.2's figures measure the system rather
 * than the rig.
 *
 * ONE BOUNDARY, and it belongs in the write-up rather than in a footnote:
 * synthesized speech is cleaner than a representative spelling a number down a
 * phone line. E-AUTH run on TTS gives an OPTIMISTIC reading of A-24. That is the
 * right reading for Day 0 — the question today is whether the mechanism works at
 * all and whether the comparison ever fails — but §6.6 requires 20-30 genuine
 * human turns in the calibration set by WEEK 2, and that is where the pessimistic
 * reading comes from. Record it as a stated boundary, the way §1.5 and §10.8 do.
 *
 * Requires:  pip install edge-tts    and    winget install --id Gyan.FFmpeg -e
 * Run:       node scripts/make-audio.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO = path.join(ROOT, 'audio');
const TMP = path.join(ROOT, 'audio', '.tmp');

/**
 * Rewrites an absolute path relative to where node was actually launched, so a
 * command printed for the user to copy resolves in their shell — whether they
 * ran this from hh-day0/ or from the repository root.
 */
const forDisplay = (abs) => {
  const rel = path.relative(process.cwd(), abs);
  const out = rel && !rel.startsWith('..') ? rel : abs;
  return out.split(path.sep).join('/');
};

/**
 * Voice for the "representative". Day 0 needs only one.
 * Week 1 needs three distinct ones for §10.2 / §6.6 — good candidates:
 *   IVR system  : en-US-AriaNeural     (bright, announcement-like)
 *   Rep #1      : en-US-GuyNeural
 *   Rep #2      : en-GB-SoniaNeural    (different accent AND gender — party
 *                                       detection is easier to calibrate when
 *                                       the two are not near neighbours)
 * List them all with:  edge-tts --list-voices
 */
const VOICE = process.env.TTS_VOICE || 'en-US-GuyNeural';
const GAP_SECONDS = 2;

/**
 * Speaking rate. Default -25% because at the natural rate the voice runs digits
 * together, and a slurred digit reads as a CAPTURE failure in E-AUTH — you would
 * spend an hour blaming ADR-020 for a rendering problem.
 *
 * Slowing down is also more faithful, not less: a representative reading an
 * authorization number aloud slows down and separates the digits. That is what
 * the pace is for.
 *
 * Note the `--rate=-25%` form below. `--rate -25%` fails, because argparse reads
 * the leading minus as the start of another flag.
 */
const RATE = process.env.TTS_RATE || '-25%';

/** `node scripts/make-audio.mjs --sample` renders one number across several
 *  voices and rates so you can pick by ear, instead of re-rendering all 30. */
const SAMPLE_MODE = process.argv.includes('--sample');

const SAMPLE_VOICES = [
  'en-US-GuyNeural',
  'en-US-AndrewNeural',
  'en-US-ChristopherNeural',
  'en-US-AriaNeural',
];
const SAMPLE_RATES = ['-15%', '-25%', '-35%'];

// ---------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------

/**
 * E2 — one passage, streamed twice at two sample rates and compared.
 * Deliberately loaded with the content §7.2 puts in keyterms: a spelled letter,
 * digit strings, a date, a CPT code and an ICD code. A passage of ordinary prose
 * would transcribe identically at both rates and prove nothing — the question is
 * whether 8 kHz telephony bandwidth loses the things this system actually needs.
 */
const E2_TEXT = `Good afternoon, this is provider services. I have the member identification number,
it's M as in mike, four four two, zero nine one seven. The date of birth is March fourteenth,
nineteen sixty-eight. The procedure code is nine six four one three, and the diagnosis code is
C fifty point nine one one. Can you confirm whether prior authorization is required for that service?`;

/**
 * E3 — one short question, streamed twenty times.
 * Short and unambiguous so the endpointer closes the turn cleanly; a trailing
 * question mark gives the adaptive endpointing something to latch onto.
 */
const E3_TEXT = `Can you tell me the status of the prior authorization request?`;

// ---------------------------------------------------------------------------
// Tool wrappers
// ---------------------------------------------------------------------------

function have(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', shell: process.platform === 'win32' });
    return true;
  } catch {
    return false;
  }
}

function preflight() {
  const missing = [];
  if (!have('ffmpeg', ['-version'])) missing.push(['ffmpeg', 'winget install --id Gyan.FFmpeg -e']);
  if (!have('edge-tts', ['--help'])) missing.push(['edge-tts', 'pip install edge-tts']);

  if (missing.length) {
    console.error('\n  Missing tools:\n');
    for (const [tool, how] of missing) console.error(`    ${tool.padEnd(10)} ->  ${how}`);
    console.error(
      `\n  After installing, open a NEW terminal so the updated PATH is picked up.\n`,
    );
    process.exit(1);
  }
}

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
}

/** edge-tts reads from a file rather than --text, which avoids all shell quoting. */
function speak(text, outMp3, { voice = VOICE, rate = RATE } = {}) {
  const txtPath = path.join(TMP, 'line.txt');
  fs.writeFileSync(txtPath, text.replace(/\s+/g, ' ').trim(), 'utf8');
  run('edge-tts', ['--voice', voice, `--rate=${rate}`, '--file', txtPath, '--write-media', outMp3]);
}

const toMulaw8k = (input, output) =>
  run('ffmpeg', ['-y', '-i', input, '-ar', '8000', '-ac', '1', '-f', 'mulaw', output]);

const toPcm24k = (input, output) =>
  run('ffmpeg', ['-y', '-i', input, '-ar', '24000', '-ac', '1', '-f', 's16le', output]);

// ---------------------------------------------------------------------------

preflight();
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(AUDIO, { recursive: true });

// --- Sample mode -----------------------------------------------------------

if (SAMPLE_MODE) {
  const truthForSample = JSON.parse(fs.readFileSync(path.join(ROOT, 'ground-truth.json'), 'utf8'));

  // Two cases, because they stress different things. The spelled one is the
  // hardest — four NATO words before the digits even start. The plain one is
  // what the other fifteen sound like, and judging only the hard case can send
  // you to a rate that makes the easy ones sound laboured.
  const cases = [
    { tag: 'spelled', ...truthForSample.spelled[2] },
    { tag: 'plain', ...truthForSample.spoken[1] },
  ];

  // Narrowing: setting TTS_VOICE or TTS_RATE samples only that one, so a follow-up
  // like "give me Andrew at -20%" is one command rather than twelve renders.
  const voices = process.env.TTS_VOICE ? [process.env.TTS_VOICE] : SAMPLE_VOICES;
  const rates = process.env.TTS_RATE ? [process.env.TTS_RATE] : SAMPLE_RATES;

  const outDir = path.join(AUDIO, 'samples');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n  Sampling ${voices.length} voice(s) x ${rates.length} rate(s) x ${cases.length} cases\n`);

  for (const voice of voices) {
    for (const rate of rates) {
      for (const c of cases) {
        const stem =
          `${voice.replace('en-US-', '').replace('en-GB-', '').replace('Neural', '')}` +
          `_${rate.replace('%', 'pct')}_${c.tag}`;
        const mp3 = path.join(outDir, `${stem}.mp3`);
        try {
          speak(c.say, mp3, { voice, rate });
          console.log(`  ${stem.padEnd(30)} ${c.value}`);
        } catch {
          console.log(`  ${stem.padEnd(30)} -- voice unavailable, skipped`);
        }
      }
    }
  }

  console.log(`
  Open ${forDisplay(outDir)} and listen. Judge one thing only: can you write
  down every character without replaying it? That is exactly what the agent has
  to do.

  Then render everything with your pick:
    TTS_VOICE=en-US-AndrewNeural TTS_RATE=-30% node ${forDisplay(path.join(ROOT, 'scripts', 'make-audio.mjs'))}

  On Windows cmd.exe the env-var prefix does not work — use:
    set TTS_VOICE=en-US-AndrewNeural && set TTS_RATE=-30% && node ${forDisplay(path.join(ROOT, 'scripts', 'make-audio.mjs'))}
`);
  process.exit(0);
}

console.log(`\n  voice: ${VOICE}   rate: ${RATE}\n`);

// --- E2 --------------------------------------------------------------------

process.stdout.write('  E2  rendering passage ... ');
speak(E2_TEXT, path.join(TMP, 'e2.mp3'));
toMulaw8k(path.join(TMP, 'e2.mp3'), path.join(AUDIO, 'test8k.ul'));
toPcm24k(path.join(TMP, 'e2.mp3'), path.join(AUDIO, 'test24k.raw'));
console.log('audio/test8k.ul + audio/test24k.raw');

// --- E3 --------------------------------------------------------------------

process.stdout.write('  E3  rendering question ... ');
speak(E3_TEXT, path.join(TMP, 'turn.mp3'));
toMulaw8k(path.join(TMP, 'turn.mp3'), path.join(AUDIO, 'turn.ul'));
console.log('audio/turn.ul');

// --- E-AUTH ----------------------------------------------------------------

const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'ground-truth.json'), 'utf8'));
const entries = [...truth.spoken, ...truth.spelled];

console.log(`\n  E-AUTH  rendering ${entries.length} numbers with ${GAP_SECONDS}s gaps`);

const parts = [];
for (let i = 0; i < entries.length; i++) {
  const { value, say } = entries[i];
  const mp3 = path.join(TMP, `auth-${String(i).padStart(2, '0')}.mp3`);
  const wav = path.join(TMP, `auth-${String(i).padStart(2, '0')}.wav`);

  speak(say, mp3);
  // apad appends the gap to the clip itself, so the concat below needs no
  // interleaved silence files and stays a single flat list.
  run('ffmpeg', ['-y', '-i', mp3, '-ar', '8000', '-ac', '1', '-af', `apad=pad_dur=${GAP_SECONDS}`, wav]);

  parts.push(wav);
  process.stdout.write(`\r          ${i + 1}/${entries.length}  ${value.padEnd(14)}`);
}
console.log('');

// ffmpeg's concat demuxer takes a list file with forward slashes on every platform.
const listPath = path.join(TMP, 'concat.txt');
fs.writeFileSync(listPath, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'), 'utf8');

run('ffmpeg', [
  '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
  '-ar', '8000', '-ac', '1', '-f', 'mulaw',
  path.join(AUDIO, 'auth-numbers.ul'),
]);

// --- Summary ---------------------------------------------------------------

const sizeOf = (f) => {
  const p = path.join(AUDIO, f);
  if (!fs.existsSync(p)) return 'MISSING';
  const bytes = fs.statSync(p).size;
  // μ-law 8 kHz is 8000 bytes per second; PCM16 24 kHz is 48000.
  const secs = f.endsWith('.raw') ? bytes / 48000 : bytes / 8000;
  return `${(bytes / 1024).toFixed(0)} KB  (${secs.toFixed(1)}s)`;
};

console.log(`\n  --- rendered ---`);
for (const f of ['test8k.ul', 'test24k.raw', 'turn.ul', 'auth-numbers.ul']) {
  console.log(`  ${forDisplay(path.join(AUDIO, f)).padEnd(34)} ${sizeOf(f)}`);
}

console.log(`
  Listen to any of them before spending session minutes on a bad render:
    ffmpeg -f mulaw -ar 8000 -ac 1 -i ${forDisplay(path.join(AUDIO, 'auth-numbers.ul'))} ${forDisplay(path.join(AUDIO, 'auth-numbers.wav'))}

  Check two things in that file: every number is audible and unrushed, and the
  gaps are really there. A run where the voice slurred a digit will look like a
  capture failure in E-AUTH, and you would spend an hour blaming ADR-020 for it.
`);
