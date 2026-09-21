/**
 * E3 — latency baseline  (~2 h, RUN THIS ON THE HOST THE DEMO WILL RUN FROM)
 *
 * Closes: the API term in §4.2, and the Day-0 half of A-33.
 *
 * ADR-003 makes the host's distance to AssemblyAI a declared, measured parameter.
 * A latency figure measured on one continent and presented from another is a
 * number that collapses under a follow-up question — so if you demo from a
 * different machine than this one, this measurement is void and must be repeated.
 *
 * SCOPE, stated plainly: on Day 0 there is no harness, so this measures the API
 * segment only — last input.audio frame sent, to first reply.audio byte received.
 * The full perceived_response_ms in §4.2 adds the loopback delay, the jitter
 * buffer and the playout queue, and is measured in week 1.
 *
 * The decision this produces today: if the API segment alone is already above
 * ~1500 ms at the median, the full figure cannot land under the 2500 ms A-33
 * ceiling, and you move the demo to a closer host — knowing it in week zero
 * rather than in week four.
 *
 * Run:  node e3.mjs
 */

import fs from 'node:fs';
import { withSession, send, listen, waitFor, sleep, report, percentile, fromRoot, forDisplay } from './lib/session.mjs';
import { frameFile, streamFrames, streamSilence, silenceFrame, FRAME_MS } from './lib/audio.mjs';

const TURNS = 20;
const PROMPT_FILE = fromRoot('audio', 'turn.ul'); // one short spoken question, μ-law 8 kHz

await withSession('e3', async (ws, log, env) => {
  const toFirstAudio = [];   // last input frame sent -> first reply.audio byte
  const toReplyStarted = []; // last input frame sent -> reply.started
  let lastFrameSentAt = null;
  let firstAudioAt = null;
  let replyStartedAt = null;
  let lastAudioAt = 0;

  /**
   * Waits until the previous reply has finished streaming before the next turn
   * begins. reply.done alone is not enough: audio can still be in flight behind
   * it, and the next turn's firstAudioAt would then latch onto the old tail and
   * report a latency that belongs to a turn that already ended.
   */
  async function settle(quietMs = 700, maxWaitMs = 12000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (Date.now() - lastAudioAt >= quietMs) return;
      await sleep(100);
    }
  }

  listen(ws, log, (m) => {
    if (m.type === 'reply.started' && replyStartedAt === null) replyStartedAt = Date.now();
    if (m.type === 'reply.audio') {
      lastAudioAt = Date.now();
      if (firstAudioAt === null) firstAudioAt = Date.now();
    }
  });

  send(ws, log, {
    type: 'session.update',
    session: {
      system_prompt:
        'You are a assistant on a phone call. Answer every question in exactly one short sentence.',
      input: {
        format: { encoding: env.encoding, sample_rate: env.sampleRate },
        transcription_mode: 'balanced',
      },
      output: { voice: env.voice, format: { encoding: env.encoding, sample_rate: env.sampleRate } },
    },
  });
  await sleep(2500);

  const haveRecording = fs.existsSync(PROMPT_FILE);
  const frames = haveRecording
    ? frameFile(PROMPT_FILE, env.encoding, env.sampleRate)
    : Array(Math.round(1200 / FRAME_MS)).fill(silenceFrame(env.encoding, env.sampleRate));

  if (!haveRecording) {
    console.log(
      `\n  NOTE: ${forDisplay(PROMPT_FILE)} not found — streaming silence instead.\n` +
        `  That still measures the round trip, but the endpointer has nothing to close\n` +
        `  a turn on, so the numbers will be noisier. Render the question first:\n` +
        `    node ${forDisplay(fromRoot('scripts', 'make-audio.mjs'))}\n`,
    );
  }

  console.log(`\n  ${TURNS} turns, ${frames.length} frames each, 20 ms cadence\n`);

  for (let turn = 1; turn <= TURNS; turn++) {
    await settle();
    firstAudioAt = null;
    replyStartedAt = null;

    await streamFrames(ws, log, frames);
    lastFrameSentAt = Date.now();

    // Silence tail: this is what tells the endpointer the turn is over. It is part
    // of the measurement, not overhead — a real caller stops talking too.
    await streamSilence(ws, log, env.encoding, env.sampleRate, 800);

    const done = await waitFor(ws, (m) => m.type === 'reply.done', 12000);

    if (firstAudioAt) {
      const ms = firstAudioAt - lastFrameSentAt;
      toFirstAudio.push(ms);
      if (replyStartedAt) toReplyStarted.push(replyStartedAt - lastFrameSentAt);
      console.log(`  turn ${String(turn).padStart(2)}: ${String(ms).padStart(5)} ms to first audio byte`);
      log.rec('turn_measured', { turn, toFirstAudioMs: ms, toReplyStartedMs: replyStartedAt ? replyStartedAt - lastFrameSentAt : null });
    } else {
      console.log(`  turn ${String(turn).padStart(2)}: no audio returned${done ? '' : ' (timed out)'}`);
      log.rec('turn_no_audio', { turn, replyDone: done });
    }
  }

  console.log('\n  --- results, API segment only ---');
  const audioStats = report('last input frame -> first reply.audio ', toFirstAudio);
  const startStats = report('last input frame -> reply.started     ', toReplyStarted);

  const median = audioStats.median;
  console.log(`\n  --- write back into the SSOT ---`);
  console.log(`  §4.2  API segment median : ${median} ms   p90: ${audioStats.p90} ms`);
  console.log(`  §4.2  reported separately from the loopback and playout terms, per ADR-003`);
  console.log(`  §22   A-33 (Day-0 half)  : ${median === null ? 'NO DATA' : median < 1500 ? 'on track' : 'AT RISK — consider a closer host'}`);

  if (median !== null && median >= 1500) {
    console.log(
      `\n  The API segment alone is ${median} ms. §4.2 adds ~50 ms of loopback delay,\n` +
        `  40-60 ms of jitter buffer, up to 200 ms of playout queue, and 300-800 ms of\n` +
        `  endpointing on top. A-33's ceiling is a p90 of 2500 ms — this will not fit.\n` +
        `  ADR-003's second configuration (a cloud host near the API region) is the\n` +
        `  answer, and you now know that in week zero.\n`,
    );
  }

  log.rec('e3_summary', {
    turns: TURNS,
    usedRecording: haveRecording,
    toFirstAudio: audioStats,
    toReplyStarted: startStats,
    raw: toFirstAudio,
    p50: percentile(toFirstAudio, 50),
    p90: percentile(toFirstAudio, 90),
  });
});
