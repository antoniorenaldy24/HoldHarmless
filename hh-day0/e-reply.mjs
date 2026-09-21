/**
 * E-REPLY — agent-initiated turns  (~30 min)
 *
 * Closes: A-25, and the message name ADR-022 marks as unconfirmed.
 *
 * FINDING FROM THE DOCS, to be confirmed empirically here:
 *   The client-to-server message is `reply.create`, carrying an optional
 *   `instructions` string. That is exactly the one-shot-instruction primitive
 *   ADR-022 needs, so `AgentSession.createReply(cause, oneShotInstructions?)`
 *   maps to it directly.
 *
 * Why this matters more than its size suggests: if no such mechanism existed,
 * every recovery action in §5.7 would be a list of intentions with no surface,
 * and the failure mode §19.1 ranks as fatal — an agent that simply stops acting,
 * not on hold, not failed, just silent — would be guaranteed rather than prevented.
 *
 * Three measurements:
 *   1. reply.create with no instructions        -> time to first reply.audio byte
 *   2. reply.create with one-shot instructions  -> does the content obey them?
 *   3. reply.create while the "gate" is closed  -> zero bytes must reach the sink
 *
 * Measurement 3 needs no real transport. The gate in ADR-007 is a local decision
 * made before frames are handed to the transport, so a boolean plus a counting
 * sink reproduces it exactly. What is under test is that the API cannot bypass a
 * decision made on our side of the wire.
 *
 * Fallback if reply.create is rejected: stream a short burst of silence to trip
 * the endpointer into closing the turn. Cruder, and it MUST be recorded as a
 * decision in ADR-022 rather than left as an implementation detail.
 *
 * Run:  node e-reply.mjs
 */

import { withSession, send, listen, waitFor, sleep, report, fromRoot, forDisplay } from './lib/session.mjs';
import { makeReplyRecorder } from './lib/audio.mjs';
import path from 'node:path';

const CANDIDATES = ['reply.create', 'response.create', 'agent.reply'];

await withSession('e-reply', async (ws, log, env) => {
  // --- The local gate under test --------------------------------------------
  let gateOpen = true;
  let bytesReachingSink = 0; // stands in for the far end
  let bytesDiscardedByGate = 0;

  let firstAudioAt = null;
  let replyStartedAt = null;
  let agentText = '';
  let lastAudioAt = 0;

  /**
   * Waits until the pipeline is genuinely idle before the next measurement.
   *
   * `reply.done` is NOT sufficient on its own. A reply.create sent while an
   * earlier reply is still streaming is queued, not rejected and not merged — the
   * server finishes the first reply, then immediately starts the second. If the
   * next t0 is stamped before the earlier reply's audio has drained, the first
   * frame it sees belongs to the PREVIOUS turn and the measured latency is a
   * fiction. That is exactly the error §16.1 forbids: a number that cannot fail.
   */
  async function settle(quietMs = 700, maxWaitMs = 12000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (Date.now() - lastAudioAt >= quietMs) return;
      await sleep(100);
    }
  }
  const recorder = makeReplyRecorder(fromRoot('audio', 'e-reply-out.raw'));

  listen(ws, log, (m) => {
    switch (m.type) {
      case 'reply.started':
        replyStartedAt = Date.now();
        break;

      case 'reply.audio': {
        const buf = Buffer.from(m.data ?? '', 'base64');
        lastAudioAt = Date.now();
        // This is the gate from ADR-007, in miniature.
        if (gateOpen) {
          if (firstAudioAt === null) firstAudioAt = Date.now();
          bytesReachingSink += buf.length;
          recorder.push(m.data);
        } else {
          bytesDiscardedByGate += buf.length;
        }
        break;
      }

      case 'transcript.agent':
      case 'transcript.agent.delta':
        if (m.text) agentText += m.text;
        break;
    }
  });

  // --- Initial configuration -------------------------------------------------
  send(ws, log, {
    type: 'session.update',
    session: {
      system_prompt:
        'You are an assistant calling a health insurance payer. Keep every reply to one short sentence.',
      input: { format: { encoding: env.encoding, sample_rate: env.sampleRate } },
      output: { voice: env.voice, format: { encoding: env.encoding, sample_rate: env.sampleRate } },
    },
  });
  await sleep(2500);

  // --- Step 1: find the message name ----------------------------------------
  console.log('\n  --- finding the reply-creation message name ---');
  let verb = null;

  for (const candidate of CANDIDATES) {
    firstAudioAt = null;
    replyStartedAt = null;
    process.stdout.write(`  ${candidate.padEnd(18)}`);

    send(ws, log, { type: candidate });
    const answer = await Promise.race([
      waitFor(ws, (m) => m.type === 'reply.started', 6000),
      waitFor(ws, (m) => m.type === 'session.error', 6000),
    ]);

    if (answer?.type === 'reply.started') {
      console.log('ACCEPTED — agent produced a turn');
      verb = candidate;
      log.rec('reply_verb_found', { verb: candidate });
      await waitFor(ws, (x) => x.type === 'reply.done', 15000);
      await settle();
      break;
    }
    console.log(answer?.type === 'session.error' ? `rejected (${answer.code})` : 'no answer');
    await sleep(1000);
  }

  if (!verb) {
    console.log(
      `\n  NONE of ${CANDIDATES.join(', ')} produced a turn.\n` +
        `  Read logs/e0.jsonl and logs/e-reply.jsonl — the server-to-client message\n` +
        `  list usually implies its client-side pair. If there is genuinely no such\n` +
        `  mechanism, §5.7 loses its surface and the silence-burst fallback becomes a\n` +
        `  recorded decision in ADR-022, not an improvisation.\n`,
    );
    log.rec('e_reply_verdict', { found: false, candidates: CANDIDATES });
    return;
  }

  // --- Step 2: latency, with and without instructions -----------------------
  console.log(`\n  --- measuring ${verb} ---`);
  const plain = [];
  const instructed = [];

  for (let i = 0; i < 5; i++) {
    await settle();
    firstAudioAt = null;
    agentText = '';
    const t0 = Date.now();
    send(ws, log, { type: verb });
    await waitFor(ws, (m) => m.type === 'reply.done', 12000);
    if (firstAudioAt) plain.push(firstAudioAt - t0);
  }

  for (let i = 0; i < 5; i++) {
    await settle();
    firstAudioAt = null;
    agentText = '';
    const t0 = Date.now();
    send(ws, log, {
      type: verb,
      instructions: 'Ask politely whether the representative is still on the line.',
    });
    await waitFor(ws, (m) => m.type === 'reply.done', 12000);
    if (firstAudioAt) instructed.push(firstAudioAt - t0);
    log.rec('instructed_reply_text', { text: agentText });
    console.log(`    instructed #${i + 1}: "${agentText.trim().slice(0, 90)}"`);
  }

  const plainStats = report('initiated_reply_latency_ms (no instructions)', plain);
  const instructedStats = report('initiated_reply_latency_ms (one-shot)   ', instructed);

  // --- Step 3: the gate condition (ADR-022 condition 1) ---------------------
  console.log('\n  --- gate closed: zero milliseconds must reach the far end ---');
  await settle();
  bytesReachingSink = 0;
  bytesDiscardedByGate = 0;
  gateOpen = false;

  send(ws, log, { type: verb, instructions: 'Say a full sentence about the weather.' });
  await waitFor(ws, (m) => m.type === 'reply.done', 8000);
  await sleep(800);

  const leaked = bytesReachingSink;
  const bytesPerMs = (env.encoding === 'audio/pcmu' ? 1 : 2) * (env.sampleRate / 1000);
  console.log(`    discarded by gate : ${bytesDiscardedByGate} bytes (${(bytesDiscardedByGate / bytesPerMs).toFixed(0)} ms)`);
  console.log(`    reached far end   : ${leaked} bytes`);
  console.log(`    A-25 gate condition: ${leaked === 0 ? 'PASS' : 'FAIL'}`);
  gateOpen = true;

  const written = recorder.write();
  if (written) {
    console.log(`\n  agent audio written: ${forDisplay(written)}`);
    console.log(`  listen with: ffmpeg -f mulaw -ar 8000 -ac 1 -i ${forDisplay(written)} ${forDisplay(fromRoot('audio', 'e-reply-out.wav'))}`);
  }

  const pass =
    plainStats.median !== undefined && plainStats.median < 1500 &&
    instructedStats.median !== undefined && instructedStats.median < 1500 &&
    leaked === 0;

  console.log(`\n  --- write back into the SSOT ---`);
  console.log(`  ADR-022  createReply maps to : { "type": "${verb}", "instructions"?: string }`);
  console.log(`  §16.3    initiated_reply_latency_ms median: ${plainStats.median} ms`);
  console.log(`  §22      A-25: ${pass ? 'PASS' : 'FAIL'}  (needs reply < 1500 ms and zero leakage)`);

  log.rec('e_reply_verdict', { found: true, verb, plainStats, instructedStats, leaked, pass });
});
