/**
 * `pnpm render-assets` — renders every harness line to μ-law 8 kHz (§10.2).
 *
 * Offline, at build time; never at runtime. Each line is spoken by its role's
 * voice (lines.ts ROLE_VOICES) with edge-tts, then converted by ffmpeg to raw
 * μ-law, mono, 8000 Hz — the format on the wire, so the harness plays files
 * byte for byte with no conversion in the audio path.
 *
 * Incremental: manifest.json records what each file was rendered from, and a
 * line is re-rendered only when its text, voice, rate or RENDER_VERSION changed.
 * The hold music is generated (hold-music.ts), not synthesized.
 *
 *   pnpm render-assets            render what is missing or stale
 *   pnpm render-assets --force    render everything
 *   pnpm render-assets --check    render nothing; exit 1 unless every asset is current
 *
 * Requires edge-tts (pip install edge-tts) and ffmpeg (winget install --id Gyan.FFmpeg -e).
 * The renderer is not part of the runtime and may be swapped freely (§10.2).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ASSET_DIR,
  HOLD_MUSIC_FILE,
  LINES,
  LINE_IDS,
  MANIFEST,
  ROLE_VOICES,
  checkAssets,
  holdMusicKey,
  holdMusicMulaw,
  lineFile,
  renderKey,
  type LineId,
  type Manifest,
} from '@holdharmless/ivr-harness';

const args = new Set(process.argv.slice(2));

if (args.has('--check')) {
  const problems = checkAssets();
  if (problems.length === 0) {
    console.log(`all ${LINE_IDS.length} lines and the hold music are rendered and current`);
    process.exit(0);
  }
  console.error(problems.join('\n'));
  process.exit(1);
}

function run(cmd: string, argv: string[]): void {
  execFileSync(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function preflight(): void {
  const missing: string[] = [];
  for (const [cmd, install] of [['edge-tts', 'pip install edge-tts'], ['ffmpeg', 'winget install --id Gyan.FFmpeg -e']] as const) {
    try {
      run(cmd, cmd === 'ffmpeg' ? ['-version'] : ['--help']);
    } catch {
      missing.push(`${cmd} not found — ${install}`);
    }
  }
  if (missing.length > 0) {
    console.error(missing.join('\n'));
    process.exit(1);
  }
}

const manifestPath = path.join(ASSET_DIR, MANIFEST);
const previous: Manifest | null = fs.existsSync(manifestPath) ? (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest) : null;
const manifest: Manifest = { lines: {}, holdMusic: { file: HOLD_MUSIC_FILE, key: '', bytes: 0 } };

const current = (id: LineId): boolean => {
  const old = previous?.lines[id];
  if (!old || args.has('--force') || old.key !== renderKey(id)) return false;
  const file = path.join(ASSET_DIR, old.file);
  return fs.existsSync(file) && fs.statSync(file).size === old.bytes && old.bytes > 0;
};

const toRender = LINE_IDS.filter((id) => !current(id));
if (toRender.length > 0) preflight();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-render-'));
let rendered = 0;
for (const id of LINE_IDS) {
  const file = lineFile(id);
  if (!toRender.includes(id)) {
    manifest.lines[id] = previous!.lines[id]!;
    continue;
  }
  const { role, text } = LINES[id];
  const { voice, rate } = ROLE_VOICES[role];
  const mp3 = path.join(tmp, `${id}.mp3`);
  const out = path.join(ASSET_DIR, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  // `--rate=-15%`, not `--rate -15%`: argparse reads a leading minus as a flag.
  run('edge-tts', ['--voice', voice, `--rate=${rate}`, '--text', text, '--write-media', mp3]);
  // loudnorm (EBU R128) before the downsample, so the three voices arrive at one
  // level (about 3.6 dB apart as rendered, about 1 dB after). The acoustic
  // layer's RMS signal (§6.1) should measure the audio, not which role is speaking.
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3, '-af', 'loudnorm=I=-19:TP=-2:LRA=11', '-ar', '8000', '-ac', '1', '-f', 'mulaw', out]);

  const bytes = fs.statSync(out).size;
  if (bytes === 0) throw new Error(`${id}: ffmpeg produced an empty file`);
  manifest.lines[id] = { file, key: renderKey(id), bytes };
  rendered++;
  console.log(`  ${id.padEnd(26)} ${role.padEnd(5)} ${(bytes / 8000).toFixed(1).padStart(5)} s`);
}
fs.rmSync(tmp, { recursive: true, force: true });

const music = holdMusicMulaw();
fs.mkdirSync(path.dirname(path.join(ASSET_DIR, HOLD_MUSIC_FILE)), { recursive: true });
fs.writeFileSync(path.join(ASSET_DIR, HOLD_MUSIC_FILE), music);
manifest.holdMusic = { file: HOLD_MUSIC_FILE, key: holdMusicKey(), bytes: music.length };

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const problems = checkAssets();
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`${rendered} rendered, ${LINE_IDS.length - rendered} unchanged; hold music ${(music.length / 8000).toFixed(0)} s. All current.`);
