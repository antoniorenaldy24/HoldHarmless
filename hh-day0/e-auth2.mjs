/**
 * E-AUTH v2 — capture and comparison, one number per turn
 *
 * Closes: A-24, ranked FATAL in §19.1 because the entire approval path rests on it.
 *
 * WHY v1 DID NOT MEASURE THIS
 *
 * v1 streamed all thirty numbers as one continuous six-minute file while the
 * prompt forbade the agent from speaking. The log showed what that produced:
 * eleven turn boundaries in 353 seconds, the first sixty-three seconds treated
 * as ONE turn, and eight tool.call messages arriving in a 1.2-second burst once
 * that turn finally ended. Then the agent started talking anyway — 331 of 353
 * seconds of reply audio — and stopped attending to new numbers.
 *
 * Every value it did capture was byte-exact, so ADR-020's claim was never in
 * question. What was wrong was the rig: a representative does not read thirty
 * authorization numbers in a row, and in a real call the agent's own reply is
 * what closes each turn. Forbidding speech removed the very mechanism that
 * segments the conversation.
 *
 * WHAT CHANGED
 *
 *   1. One number per turn, streamed and scored individually. No ambiguity about
 *      which capture belongs to which number, so scoring is no longer positional
 *      guesswork over a batch.
 *   2. The agent is asked to acknowledge in two or three words. That is not
 *      politeness — the acknowledgement IS the turn boundary, and §5.6 has the
 *      agent speaking in EXCHANGE anyway, so this is also closer to the real
 *      position than v1 was.
 *   3. Each clip carries its own trailing silence, which is what the endpointer
 *      closes on.
 *
 * Run:  node e-auth2.mjs           # 10-number pilot
 *       node e-auth2.mjs --full    # all 30, to close A-24 formally
 */

import fs from 'node:fs';
import { withSession, send, listen, waitFor, sleep, fromRoot, forDisplay } from './lib/session.mjs';
import { frameFile, streamFrames, streamSilence } from './lib/audio.mjs';

const GROUND_TRUTH = fromRoot('ground-truth.json');
const CLIP_DIR = fromRoot('audio', 'numbers');
const FULL = process.argv.includes('--full');

const truth = JSON.parse(fs.readFileSync(GROUND_TRUTH, 'utf8'));
const all = [
  ...truth.spoken.map((e, i) => ({ ...e, idx: i, kind: 'spoken' })),
  ...truth.spelled.map((e, i) => ({ ...e, idx: truth.spoken.length + i, kind: 'spelled' })),
];

// The pilot takes five of each rather than the first ten, so a clean result is
// not a clean result on the easy half only.
const selected = FULL
  ? all
  : [...all.filter((e) => e.kind === 'spoken').slice(0, 5), ...all.filter((e) => e.kind === 'spelled').slice(0, 5)];

for (const e of selected) {
  const clip = `${CLIP_DIR}\\auth-${String(e.idx).padStart(2, '0')}.ul`.replace(/\\/g, '/');
  e.clip = clip;
  if (!fs.existsSync(clip)) {
    console.error(`\n  Missing ${forDisplay(clip)}\n  Render with: node ${forDisplay(fromRoot('scripts', 'make-audio.mjs'))}\n`);
    process.exit(1);
  }
}

const CAPTURE_AUTH_NUMBER = {
  type: 'function',
  name: 'capture_auth_number',
  description:
    'Call the moment the representative states the authorization number, before reading anything back. Capture it exactly as spoken, including letters, spelled-out letters, and separators.',
  parameters: {
    type: 'object',
    properties: {
      value: {
        type: 'string',
        minLength: 3,
        description:
          "The authorization number exactly as the representative said it. If they spelled a letter — 'A as in alpha' — write just the letter. If they said 'dash', write a hyphen.",
        examples: ['A472-91', 'PA0084417', 'AUTH-2291-C'],
      },
      spoken_form: {
        type: 'string',
        description: 'Optional: how they said it, if it differed from the value. Diagnostics only.',
        examples: ['A as in alpha, four seven two, dash, nine one'],
      },
    },
    required: ['value'],
  },
};

await withSession(FULL ? 'e-auth2-full' : 'e-auth2-pilot', async (ws, log, env) => {
  let turnCaptures = [];
  let pending = [];
  let lastAudioAt = 0;

  async function settle(quietMs = 600, maxWaitMs = 10000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (Date.now() - lastAudioAt >= quietMs) return;
      await sleep(100);
    }
  }

  listen(ws, log, (m) => {
    switch (m.type) {
      case 'reply.audio':
        lastAudioAt = Date.now();
        break;

      case 'tool.call': {
        const args = typeof m.arguments === 'string' ? JSON.parse(m.arguments) : m.arguments;
        if (m.name === 'capture_auth_number') turnCaptures.push(args?.value);
        // §8.8: accumulate, flush on reply.done. v1 proved a tool-only turn still
        // produces reply.done, so no timeout fallback is needed here.
        pending.push({
          type: 'tool.result',
          call_id: m.call_id,
          result: JSON.stringify({ ok: true, stored: args?.value }),
          is_error: false,
        });
        break;
      }

      case 'reply.done':
        if (m.status === 'interrupted') {
          log.rec('tool_results_discarded', { count: pending.length });
          pending = [];
          break;
        }
        for (const r of pending) send(ws, log, r);
        if (pending.length) log.rec('tool_results_flushed', { count: pending.length });
        pending = [];
        break;
    }
  });

  send(ws, log, {
    type: 'session.update',
    session: {
      system_prompt:
        'You are an assistant on a phone call with a health insurance representative. ' +
        'When they state an authorization number, immediately call capture_auth_number with it exactly as they said it. ' +
        'Then say only a brief acknowledgement of two or three words, such as "Got it, thank you." ' +
        'Never read the number back. Never say anything else.',
      tools: [CAPTURE_AUTH_NUMBER],
      input: {
        format: { encoding: env.encoding, sample_rate: env.sampleRate },
        transcription_mode: 'max_accuracy',   // ADR-010
        keyterms: ['authorization number', 'prior authorization', 'reference number'],
      },
      output: { voice: env.voice, format: { encoding: env.encoding, sample_rate: env.sampleRate } },
    },
  });
  await sleep(2500);

  console.log(`\n  ${selected.length} numbers, one per turn\n`);

  const rows = [];
  for (const e of selected) {
    await settle();
    turnCaptures = [];

    const frames = frameFile(e.clip, env.encoding, env.sampleRate);
    await streamFrames(ws, log, frames);
    await streamSilence(ws, log, env.encoding, env.sampleRate, 1000);

    await waitFor(ws, (m) => m.type === 'reply.done', 15000);
    await sleep(400);

    const got = turnCaptures[0] ?? null;
    const match = got === e.value;
    // The diagnostic that separates the two failure classes. A value differing
    // only by case or separators means the COMPARISON failed and ADR-020 is
    // wrong. Different characters mean CAPTURE failed and ADR-020 stands.
    const norm = (v) => (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cls = got === null ? 'no_capture' : match ? 'exact' : norm(got) === norm(e.value) ? 'FORMATTING' : 'capture';

    rows.push({ value: e.value, got, kind: e.kind, class: cls, extraCaptures: turnCaptures.length - 1 });
    const flag = match ? 'ok  ' : cls === 'FORMATTING' ? '**  ' : '  X ';
    console.log(
      `  ${flag} ${e.kind.padEnd(7)} want ${e.value.padEnd(13)} got ${String(got ?? '(none)').padEnd(13)} ${cls}` +
        (turnCaptures.length > 1 ? `  (+${turnCaptures.length - 1} extra calls)` : ''),
    );
    log.rec('number_scored', rows[rows.length - 1]);
  }

  // --- Scoring ---------------------------------------------------------------

  const exact = rows.filter((r) => r.class === 'exact').length;
  const formatting = rows.filter((r) => r.class === 'FORMATTING').length;
  const noCapture = rows.filter((r) => r.class === 'no_capture').length;
  const captureErr = rows.filter((r) => r.class === 'capture').length;
  const rate = exact / rows.length;

  console.log(`\n  exact               : ${exact}/${rows.length}  (${(rate * 100).toFixed(1)}%)`);
  console.log(`    spoken            : ${rows.filter((r) => r.kind === 'spoken' && r.class === 'exact').length}/${rows.filter((r) => r.kind === 'spoken').length}`);
  console.log(`    spelled           : ${rows.filter((r) => r.kind === 'spelled' && r.class === 'exact').length}/${rows.filter((r) => r.kind === 'spelled').length}`);
  console.log(`  capture errors      : ${captureErr}`);
  console.log(`  no capture at all   : ${noCapture}`);
  console.log(`  COMPARISON failures : ${formatting}   <- must be zero, or ADR-020 is wrong`);

  const pass = rate >= 0.95 && formatting === 0;
  console.log(`\n  --- write back into the SSOT ---`);
  console.log(`  §22  A-24 ${FULL ? '' : '(pilot, not formal closure) '}: ${pass ? 'PASS' : 'FAIL'}`);

  if (!FULL && pass) {
    console.log(`  Pilot clean. Close A-24 formally with:  node ${forDisplay(fromRoot('e-auth2.mjs'))} --full`);
  }

  fs.writeFileSync(
    fromRoot('results', FULL ? 'e-auth2-full.json' : 'e-auth2-pilot.json'),
    JSON.stringify({ rows, exact, rate, formatting, noCapture, captureErr, pass }, null, 2),
  );
  log.rec('e_auth2_summary', { full: FULL, exact, rate, formatting, noCapture, captureErr, pass, rows });
});
