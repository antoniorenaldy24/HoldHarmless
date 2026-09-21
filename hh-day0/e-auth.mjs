/**
 * E-AUTH — capture and comparison  (~90 min, the longest)
 *
 * Closes: A-24, ranked FATAL in §19.1 because the entire approval path rests on it.
 *
 * ADR-020's claim is that capturing the authorization number as a structured tool
 * parameter removes the need to normalize it anywhere. The read-back reads a
 * stored value, and the final comparison is between two copies of that stored
 * value. If that holds, no canonicalization function is needed for spoken digits,
 * "as in" phrases, separators, case, or "dash" versus "-".
 *
 * WHAT IS ACTUALLY BEING MEASURED — and this is the subtle part:
 *
 *   Not whether the transcript is perfect. Whether the value that lands in
 *   capture_auth_number.value matches what you spoke, >= 95% of the time.
 *
 *   And every failure must be traceable to CAPTURE, never to COMPARISON. If the
 *   comparison is what fails, ADR-020 is wrong and you need to know today —
 *   because §8.2 makes a mismatch deliberately non-retryable, so a broken
 *   comparison would convert every successful approval into a forced escalation
 *   with a red violation on the panel.
 *
 * This also verifies §8.8 empirically: tool.result is accumulated as tool.call
 * arrives and flushed in the reply.done handler, never sent immediately. Sending
 * early leaves a result attached to a turn that has died.
 *
 * PREPARATION:
 *   node scripts/make-audio.mjs
 *
 * That renders all 30 numbers from ground-truth.json — fifteen spoken plainly,
 * fifteen spelled "A as in alpha" style, each inside a natural carrier phrase,
 * with two-second gaps. No microphone needed.
 *
 * Boundary to record with the result: synthesized speech is cleaner than a
 * representative spelling a number down a phone line, so this is an OPTIMISTIC
 * reading of A-24. The pessimistic one arrives in week 2, when §6.6 puts genuine
 * human turns into the calibration set.
 *
 * Run:  node e-auth.mjs
 */

import fs from 'node:fs';
import { withSession, send, listen, sleep, fromRoot, forDisplay } from './lib/session.mjs';
import { frameFile, streamFrames } from './lib/audio.mjs';

const AUDIO_FILE = fromRoot('audio', 'auth-numbers.ul');
const GROUND_TRUTH = fromRoot('ground-truth.json');

// --- Ground truth ----------------------------------------------------------

const truth = JSON.parse(fs.readFileSync(GROUND_TRUTH, 'utf8'));
const spokenCount = truth.spoken.length;
const expected = [...truth.spoken, ...truth.spelled].map((e) => e.value);

if (!fs.existsSync(AUDIO_FILE)) {
  console.error(
    `\n  Missing ${forDisplay(AUDIO_FILE)}\n` +
      `  Render it from ${forDisplay(GROUND_TRUTH)} — no microphone needed:\n` +
      `    node ${forDisplay(fromRoot('scripts', 'make-audio.mjs'))}\n`,
  );
  process.exit(1);
}

// --- The tool under test, verbatim from SSOT §8.1 --------------------------

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

await withSession('e-auth', async (ws, log, env) => {
  const captures = [];
  let pendingResults = []; // §8.8: accumulate, flush on reply.done
  let flushTimer = null;
  let flushedOnTimeout = 0;
  let flushedOnReplyDone = 0;

  /**
   * §8.8 says tool.result is flushed in the reply.done handler. That is correct
   * for a turn where the agent also speaks. This experiment's prompt forbids
   * speech — the agent is told to call the tool and say nothing — so it is an
   * open question whether a tool-only turn produces reply.done at all.
   *
   * If it does not, results would never flush, the agent would block waiting for
   * them, and E-AUTH would report one capture instead of thirty: a false FAIL
   * that looks exactly like a capture problem. This fallback flushes anyway after
   * a timeout and counts which path each flush took, so the answer to that open
   * question is itself a result rather than a lost afternoon.
   */
  const flush = (why) => {
    if (pendingResults.length === 0) return;
    for (const r of pendingResults) send(ws, log, r);
    log.rec('tool_results_flushed', { count: pendingResults.length, why });
    if (why === 'reply.done') flushedOnReplyDone += pendingResults.length;
    else flushedOnTimeout += pendingResults.length;
    pendingResults = [];
  };

  const armFlushTimer = () => {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flush('timeout_no_reply_done'), 1500);
  };

  listen(ws, log, (m) => {
    switch (m.type) {
      case 'tool.call': {
        const args = typeof m.arguments === 'string' ? JSON.parse(m.arguments) : m.arguments;
        if (m.name === 'capture_auth_number') {
          captures.push({ at: Date.now(), value: args?.value, spokenForm: args?.spoken_form, callId: m.call_id });
          console.log(`  captured #${String(captures.length).padStart(2)}: "${args?.value}"`);
        }
        // §8.8 step 1: accumulate. NOT sent here.
        pendingResults.push({
          type: 'tool.result',
          call_id: m.call_id,
          result: JSON.stringify({ ok: true, stored: args?.value }),
          is_error: false,
        });
        log.rec('tool_result_queued', { call_id: m.call_id, name: m.name });
        armFlushTimer();
        break;
      }

      case 'reply.done': {
        // §8.8 step 3: on an interrupted turn, discard the results but keep their
        // side effects. The capture above already happened and stays.
        if (m.status === 'interrupted') {
          clearTimeout(flushTimer);
          log.rec('tool_results_discarded', { count: pendingResults.length, reason: 'reply interrupted' });
          pendingResults = [];
          break;
        }
        // §8.8 step 2 and 4: flush one result per call_id.
        clearTimeout(flushTimer);
        flush('reply.done');
        break;
      }
    }
  });

  send(ws, log, {
    type: 'session.update',
    session: {
      system_prompt:
        'You are on a phone call with a health insurance representative who is reading you authorization numbers. ' +
        'The moment they state an authorization number, call capture_auth_number with it exactly as they said it. ' +
        'Do not wait, do not read it back, and do not say anything at all. Only call the tool.',
      tools: [CAPTURE_AUTH_NUMBER],
      input: {
        format: { encoding: env.encoding, sample_rate: env.sampleRate },
        // ADR-010: max_accuracy is the lever that stops the turn ending mid-spelling.
        transcription_mode: 'max_accuracy',
        keyterms: ['authorization number', 'prior authorization', 'reference number'],
      },
      output: { voice: env.voice, format: { encoding: env.encoding, sample_rate: env.sampleRate } },
    },
  });
  await sleep(2500);

  const frames = frameFile(AUDIO_FILE, env.encoding, env.sampleRate);
  const durationS = (frames.length * 20) / 1000;
  console.log(`\n  streaming ${durationS.toFixed(0)} s of audio, expecting ${expected.length} captures\n`);

  await streamFrames(ws, log, frames, {
    onFrame: (i, n) => {
      if (i % 500 === 0) process.stdout.write(`\r  ... ${((i / n) * 100).toFixed(0)}%   `);
    },
  });
  process.stdout.write('\r                    \r');
  await sleep(4000); // let the last capture land

  // --- Scoring -------------------------------------------------------------
  //
  // Positional comparison: capture N against expected N. When the counts differ,
  // alignment is ambiguous and that is itself the finding — a missed or doubled
  // capture, not a comparison problem.

  console.log('\n  --- scoring ---');
  const rows = [];
  const n = Math.min(captures.length, expected.length);
  let exact = 0;

  for (let i = 0; i < n; i++) {
    const want = expected[i];
    const got = captures[i].value ?? '';
    const match = got === want;
    if (match) exact++;

    // The diagnostic that separates the two failure classes: if the values differ
    // only by case or separators, the comparison is the problem and ADR-020 is
    // wrong. If the characters themselves differ, capture is the problem and
    // ADR-020 stands.
    const loose = got.toUpperCase().replace(/[^A-Z0-9]/g, '') === want.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cls = match ? 'exact' : loose ? 'FORMATTING' : 'capture';

    rows.push({ i: i + 1, want, got, match, class: cls, kind: i < spokenCount ? 'spoken' : 'spelled' });
    if (!match) console.log(`  #${String(i + 1).padStart(2)} ${rows[i].kind.padEnd(7)} want "${want}"  got "${got}"  -> ${cls}`);
  }

  const missing = expected.length - captures.length;
  const rate = n ? exact / expected.length : 0;
  const formattingFailures = rows.filter((r) => r.class === 'FORMATTING').length;
  const spokenExact = rows.filter((r) => r.kind === 'spoken' && r.match).length;
  const spelledExact = rows.filter((r) => r.kind === 'spelled' && r.match).length;

  console.log(`\n  expected            : ${expected.length}`);
  console.log(`  captured            : ${captures.length}${missing > 0 ? `  (${missing} missed)` : missing < 0 ? `  (${-missing} extra)` : ''}`);
  console.log(`  exact matches       : ${exact}  (${(rate * 100).toFixed(1)}%)`);
  console.log(`    of spoken (${spokenCount})   : ${spokenExact}`);
  console.log(`    of spelled (${expected.length - spokenCount})  : ${spelledExact}`);
  console.log(`  formatting failures : ${formattingFailures}`);
  console.log(`
  tool.result flush path (§8.8):`);
  console.log(`    on reply.done     : ${flushedOnReplyDone}`);
  console.log(`    on timeout        : ${flushedOnTimeout}${flushedOnTimeout > 0 ? '   <- a tool-only turn does NOT produce reply.done' : ''}`);

  const pass = rate >= 0.95 && formattingFailures === 0;

  console.log(`\n  --- write back into the SSOT ---`);
  console.log(`  §22  A-24: ${pass ? 'PASS' : 'FAIL'}  (needs >= 95% exact AND zero comparison failures)`);

  if (formattingFailures > 0) {
    console.log(
      `\n  ${formattingFailures} capture(s) matched only after stripping case and separators.\n` +
        `  That is the failure ADR-020 claims cannot happen: the comparison, not the\n` +
        `  capture, is what broke. Since §8.2 makes a mismatch non-retryable, every one\n` +
        `  of those would become a forced escalation on a call that actually succeeded.\n` +
        `  ADR-020 needs revisiting before any production code is written.\n`,
    );
  } else if (!pass) {
    console.log(
      `\n  Below 95%, but every failure is a CAPTURE failure — ADR-020's core claim\n` +
        `  survives. The levers are ADR-010 (max_accuracy, already on), ADR-011\n` +
        `  (interruption_delay), and the tool description's examples, which is what\n` +
        `  drives entity-aware waiting.\n`,
    );
  }

  fs.writeFileSync(fromRoot('results', 'e-auth-rows.json'), JSON.stringify({ rows, exact, rate, formattingFailures }, null, 2));
  console.log(`  per-number detail written to ${forDisplay(fromRoot('results', 'e-auth-rows.json'))}`);

  log.rec('e_auth_summary', { expected: expected.length, captured: captures.length, exact, rate, formattingFailures, pass, rows });
});
