/**
 * E2 — μ-law pass-through  (~45 min)
 *
 * Closes: A-2, and the AUDIO_ENCODING decision in §13.
 *
 * The whole local transport is faithful only because no resampling happens
 * anywhere (§4.1): the harness emits μ-law 8 kHz, the bridge passes it through
 * unchanged, and AssemblyAI receives exactly what a telephony platform would
 * deliver. If the API will not take audio/pcmu at 8 kHz in both directions, that
 * claim collapses and the 24 kHz path behind AUDIO_ENCODING becomes the build.
 *
 * NOTE FROM THE DOCS: the documented default is PCM16 at 24 kHz, and audio moves
 * as base64 inside JSON rather than as binary frames. Whether audio/pcmu @ 8000
 * is accepted on input.format and output.format is precisely what is unproven,
 * which is why this experiment exists.
 *
 * Two runs, same source recording:
 *   A. audio/pcmu @ 8000   -> transcript A
 *   B. audio/pcm   @ 24000 -> transcript B
 * Then compare. B is the reference; A only has to be comparable, not identical.
 *
 * Prepare the two files first:
 *   node scripts/make-audio.mjs
 *
 * Run:  node e2.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { withSession, send, listen, waitFor, sleep, fromRoot, forDisplay } from './lib/session.mjs';
import { frameFile, streamFrames, streamSilence, makeReplyRecorder } from './lib/audio.mjs';

const RUNS = [
  { label: 'A  μ-law 8 kHz ', file: fromRoot('audio', 'test8k.ul'), encoding: 'audio/pcmu', sampleRate: 8000 },
  { label: 'B  PCM16 24 kHz', file: fromRoot('audio', 'test24k.raw'), encoding: 'audio/pcm', sampleRate: 24000 },
];

for (const run of RUNS) {
  if (!fs.existsSync(run.file)) {
    console.error(
      `\n  Missing ${forDisplay(run.file)}\n` +
        `  Render it — no microphone needed:\n` +
        `    node ${forDisplay(fromRoot('scripts', 'make-audio.mjs'))}\n`,
    );
    process.exit(1);
  }
}

const transcripts = {};

for (const run of RUNS) {
  await withSession(`e2-${run.encoding.replace('/', '-')}-${run.sampleRate}`, async (ws, log, env) => {
    let userTranscript = '';
    let agentText = '';
    let formatRejected = null;
    const outPath = fromRoot('audio', `e2-reply-${run.sampleRate}.raw`);
    const recorder = makeReplyRecorder(outPath);

    listen(ws, log, (m) => {
      switch (m.type) {
        case 'session.error':
          if (String(m.code ?? '').includes('format') || String(m.message ?? '').toLowerCase().includes('format')) {
            formatRejected = { code: m.code, message: m.message };
          }
          break;
        case 'transcript.user':
          if (m.text) userTranscript += (userTranscript ? ' ' : '') + m.text;
          break;
        case 'transcript.agent':
          if (m.text) agentText += m.text;
          break;
        case 'reply.audio':
          if (m.data) recorder.push(m.data);
          break;
      }
    });

    console.log(`\n  run ${run.label}  ${run.encoding} @ ${run.sampleRate}`);

    send(ws, log, {
      type: 'session.update',
      session: {
        system_prompt: 'Repeat back what you heard, then stop. One sentence only.',
        input: { format: { encoding: run.encoding, sample_rate: run.sampleRate } },
        output: { voice: env.voice, format: { encoding: run.encoding, sample_rate: run.sampleRate } },
      },
    });

    const ready = await waitFor(ws, (m) => m.type === 'session.ready' || m.type === 'session.error', 6000);
    log.rec('after_initial_update', ready);

    if (formatRejected) {
      console.log(`    FORMAT REJECTED: ${formatRejected.code} — ${formatRejected.message}`);
      log.rec('e2_format_rejected', { run, formatRejected });
      return;
    }

    const frames = frameFile(run.file, run.encoding, run.sampleRate);
    console.log(`    streaming ${frames.length} frames (${((frames.length * 20) / 1000).toFixed(1)} s) at 20 ms cadence`);

    await streamFrames(ws, log, frames);
    // A short silence tail lets the endpointer close the turn naturally, rather
    // than leaving it open and attributing the pause to the network.
    await streamSilence(ws, log, run.encoding, run.sampleRate, 1500);

    await waitFor(ws, (m) => m.type === 'reply.done', 15000);
    await sleep(1000);

    transcripts[run.label] = userTranscript.trim();

    console.log(`    user transcript : "${userTranscript.trim()}"`);
    console.log(`    agent said      : "${agentText.trim().slice(0, 120)}"`);

    const written = recorder.write();
    if (written) {
      const decode =
        run.encoding === 'audio/pcmu'
          ? `ffmpeg -f mulaw -ar 8000 -ac 1 -i ${forDisplay(written)} ${forDisplay(fromRoot('audio', 'e2-reply-8k.wav'))}`
          : `ffmpeg -f s16le -ar 24000 -ac 1 -i ${forDisplay(written)} ${forDisplay(fromRoot('audio', 'e2-reply-24k.wav'))}`;
      console.log(`    reply audio     : ${forDisplay(written)}  (${recorder.byteLength()} bytes)`);
      console.log(`    listen with     : ${decode}`);
    } else {
      console.log(`    reply audio     : NONE RECEIVED — output.format may have been rejected`);
    }

    log.rec('e2_run_result', { run, userTranscript, agentText, replyBytes: recorder.byteLength() });
  });
}

// ---------------------------------------------------------------------------

console.log('\n=== E2 comparison ===');
for (const [label, text] of Object.entries(transcripts)) {
  console.log(`  ${label}: "${text}"`);
}

console.log(`
  --- judge it yourself, then write back into the SSOT ---

  A-2 passes when BOTH hold:
    1. The μ-law transcript is comparable to the 24 kHz reference. Not identical
       — 8 kHz telephony audio genuinely carries less — but the same words.
    2. The returned audio plays back clear and is NOT pitch-shifted. A chipmunk
       voice means output.format stayed at its 24 kHz default while you decoded
       it as 8 kHz, which is the §7.1 item-2 mistake and is better seen now.

  If the μ-law run was rejected outright, set AUDIO_ENCODING=audio/pcm and
  AUDIO_SAMPLE_RATE=24000 in .env, and record in §13 that the 24 kHz path is
  live — plus a resampling stage in packages/audio, which §4.1 currently says
  does not exist anywhere.
`);
