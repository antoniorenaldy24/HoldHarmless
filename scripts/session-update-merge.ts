/**
 * Does `session.update` MERGE into the live session, or REPLACE it? — §7.1.
 *
 * WHY THIS EXISTS. ADR-010 varies `transcription_mode` by position, so a real
 * call updates the session mid-conversation, several times. Measuring A-13
 * inside one session (alternating the mode per turn) produced a result that
 * had nothing to do with either mode: the FIRST turn captured, and then every
 * turn after the first update failed to call the tool at all — eleven in a row,
 * across both modes, on audio that captured 100% when the mode was set at
 * connect. The obvious suspect is that an update carrying only
 * `input.transcription_mode` replaces the session and takes `tools` with it.
 *
 * If that is what happens, ADR-010 as written disarms every tool on the call
 * the first time the phase changes, and nothing in the transcript says so.
 *
 * SHAPE. One session, three phases, two numbers each:
 *   1. tools set at connect                        — expect captures
 *   2. update with ONLY transcription_mode         — the question
 *   3. update with tools AND transcription_mode    — expect captures again
 *
 * Phase 3 is what makes the run conclusive: if capture returns exactly when the
 * tools are resent, the loss was the update's doing and not the session drifting.
 *
 * The raw `session.updated` payload is logged, because the server's own echo
 * answers the question better than behaviour does.
 *
 * Cost: one session, six turns, about three minutes.
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

const AUDIO_DIR = path.join(ROOT, 'logs', 'a24-audio');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reuses A-24's rendered audio so nothing about the speech is new here. */
const VALUES = ['C965-96', 'PA4921679', 'QA5393', 'Q109-64', 'HH4154', 'CJ7762', 'L196-06', 'PA8791010', 'LM0522'];
function frames(value: string): Uint8Array[] {
  const file = path.join(AUDIO_DIR, `${value.replace(/[^A-Za-z0-9]/g, '_')}.ul`);
  if (!fs.existsSync(file)) {
    const spoken = `Okay, your authorization number is ${value}.`;
    const mp3 = `${file}.mp3`;
    const { voice, rate } = ROLE_VOICES.rep1;
    execFileSync('edge-tts', ['--voice', voice, `--rate=${rate}`, '--text', spoken, '--write-media', mp3], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3, '-af', 'loudnorm=I=-19:TP=-2:LRA=11', '-ar', '8000', '-ac', '1', '-f', 'mulaw', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    fs.rmSync(mp3, { force: true });
  }
  return chunkToFrames(new Uint8Array(fs.readFileSync(file)));
}

const CAPTURE_TOOL: ToolDefinition = {
  name: 'capture_auth_number',
  description: 'Record the authorization number the representative just gave. Call this as soon as you have heard it.',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string', description: 'The number exactly as given, e.g. "A472-91".' } },
    required: ['value'],
  },
};

const updates: unknown[] = [];
const captured: { value: string | null } = { value: null };
/** Phase 4 needs to know whether the agent is mid-reply. */
const reply = { outstanding: false };

const session = new AgentSession({
  url: (process.env['ASSEMBLYAI_WS_URL'] ?? 'wss://agents.assemblyai.com/v1/ws').trim(),
  apiKey: KEY,
  socket: (url, headers) => {
    const ws = new WebSocket(url, { headers });
    // The session adds its own listener; this one only watches.
    ws.on('message', (data: unknown) => {
      try {
        const m = JSON.parse(String(data)) as Record<string, unknown>;
        // `session.ready` carries a resume_token — a session credential. It is
        // short-lived and useless after the call, but this file is committed,
        // and credentials do not belong in a repository even when spent.
        if (m['type'] === 'session.updated' || m['type'] === 'session.ready') updates.push({ ...m, resume_token: undefined });
      } catch { /* not JSON */ }
    });
    return ws;
  },
  guard: () => ({ gateIntent: 'open', holdSuspected: false }),
});
session.onReplyStarted(() => { reply.outstanding = true; });
session.onReplyDone(() => { reply.outstanding = false; });
session.onToolCall((id, name, args) => {
  if (name !== 'capture_auth_number') return;
  const v = (args as { value?: unknown }).value;
  captured.value = typeof v === 'string' ? v : null;
  session.queueToolResult(id, { ok: true });
});

async function speak(value: string): Promise<string | null> {
  captured.value = null;
  for (const f of frames(value)) { session.sendAudio(f); await sleep(FRAME_MS); }
  for (let i = 0; i < 40; i++) { session.sendAudio(new Uint8Array(BYTES_PER_FRAME).fill(0xff)); await sleep(FRAME_MS); }
  const until = Date.now() + 9000;
  while (captured.value === null && Date.now() < until) {
    // Keep sending silence: the endpointer needs audio to notice the pause.
    session.sendAudio(new Uint8Array(BYTES_PER_FRAME).fill(0xff));
    await sleep(FRAME_MS);
  }
  return captured.value;
}

const phases: { name: string; before?: () => Promise<void>; values: string[]; got: (string | null)[] }[] = [
  { name: '1 tools set at connect', values: VALUES.slice(0, 2), got: [] },
  { name: '2 update: mode only', before: () => session.update({ transcriptionMode: 'balanced' }), values: VALUES.slice(2, 4), got: [] },
  { name: '3 update: mode AND tools', before: () => session.update({ transcriptionMode: 'max_accuracy', tools: [CAPTURE_TOOL] }), values: VALUES.slice(4, 6), got: [] },
];

try {
  await session.connect({
    systemPrompt: 'You are on a telephone call with a health insurance representative. When they give you an authorization number, call capture_auth_number with it immediately. Keep replies to one short sentence.',
    tools: [CAPTURE_TOOL],
    transcriptionMode: 'max_accuracy',
    keyterms: [],
    interruptResponse: false,
    voice: 'michael',
    inputFormat: 'audio/pcmu',
    outputFormat: 'audio/pcmu',
  });

  for (const phase of phases) {
    if (phase.before) { await phase.before(); console.log(`\n-- ${phase.name}: session.update acknowledged`); }
    else console.log(`\n-- ${phase.name}`);
    for (const v of phase.values) {
      const got = await speak(v);
      phase.got.push(got);
      console.log(`   spoken ${v.padEnd(10)} captured ${String(got).padEnd(10)} ${got === v ? 'ok' : got === null ? 'NO TOOL CALL' : 'wrong value'}`);
    }
  }
  // PHASE 4 — the same update, but sent WHILE the agent is still speaking.
  // This is the one thing the interleaved A-13 arm did that this probe did not,
  // and that arm lost every capture after its first update. If a mid-reply
  // update is harmless, the interleaved failure has some other cause and the
  // arm stays unusable either way; if it is not, the call loop has a rule:
  // never update the session while a reply is outstanding.
  console.log('\n-- 4 update sent while a reply is outstanding');
  const phase4: (string | null)[] = [];
  for (const v of VALUES.slice(6, 9)) {
    let sent = false;
    for (let i = 0; i < 60 && !sent; i++) {
      if (reply.outstanding) { await session.update({ transcriptionMode: i % 2 === 0 ? 'balanced' : 'max_accuracy' }); sent = true; }
      session.sendAudio(new Uint8Array(BYTES_PER_FRAME).fill(0xff));
      await sleep(FRAME_MS);
    }
    const got = await speak(v);
    phase4.push(got);
    console.log(`   update ${sent ? 'sent mid-reply' : 'NOT sent (no reply was outstanding)'} | spoken ${v.padEnd(10)} captured ${String(got).padEnd(10)} ${got === v ? 'ok' : got === null ? 'NO TOOL CALL' : 'wrong value'}`);
  }
  phases.push({ name: '4 update mid-reply', values: VALUES.slice(6, 9), got: phase4 });
} finally {
  await session.end();
  console.log('\nsession.ready / session.updated payloads from the server:');
  for (const u of updates) console.log(`  ${JSON.stringify(u)}`);
  const line = phases.map((p) => `${p.name}: ${p.got.filter((g, i) => g === p.values[i]).length}/${p.values.length}`).join(' | ');
  console.log(`\n${line}`);
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, 'results/session-update-merge.json'),
    JSON.stringify({ probe: 'session.update merge or replace', ranAt: new Date().toISOString(), phases, updates }, null, 2) + '\n',
  );
}
