/**
 * E0 — Session fields and endpoint  (~20 min, run this FIRST)
 *
 * Closes: the endpoint claim in SSOT §7.1, A-18, and ENABLE_INTERRUPTION_DELAY in §13.
 *
 * It is the cheapest experiment with the widest blast radius: every other
 * experiment assumes the endpoint answers and that session.update accepts the
 * fields ADR-006, ADR-010 and ADR-011 depend on.
 *
 * What it does:
 *   1. Tries each candidate endpoint until one opens.
 *   2. Sends the initial session.update carrying the IMMUTABLE fields
 *      (output.voice, output.format, input.format) — these must be right here
 *      or never (§7.1 item 2 and 3).
 *   3. Probes one mutable field at a time and records whether the answer was
 *      session.updated or session.error, and with which code.
 *   4. Probes the two fields ADR-009 forbids, deliberately, to confirm the API
 *      accepts them — so the decision to never set them stays a decision rather
 *      than an accident.
 *
 * Run:  node e0.mjs
 */

import { withSession, send, listen, sleep } from './lib/session.mjs';

const ENDPOINTS = [
  process.env.ASSEMBLYAI_WS_URL || 'wss://agents.assemblyai.com/v1/ws',
  'wss://api.assemblyai.com/v1/voice',
  'wss://streaming.assemblyai.com/v3/ws',
];

/**
 * Each probe touches exactly ONE field. Probing several at once makes a
 * session.error unattributable — you learn that something was rejected, not what.
 */
const PROBES = [
  // The ADR-006 / ADR-010 / ADR-011 levers — the ones the design depends on.
  ['system_prompt', { system_prompt: 'You are a test agent. Reply in one short sentence.' }],
  ['transcription_mode.max_accuracy', { input: { transcription_mode: 'max_accuracy' } }],
  ['transcription_mode.min_latency', { input: { transcription_mode: 'min_latency' } }],
  ['transcription_mode.balanced', { input: { transcription_mode: 'balanced' } }],
  ['keyterms', { input: { keyterms: ['prior authorization', 'CPT', 'ICD-10', 'NPI', 'member ID'] } }],
  ['transcription_prompt', { input: { transcription_prompt: 'Medical prior authorization call.' } }],
  ['turn_detection.interrupt_response', { input: { turn_detection: { interrupt_response: true } } }],
  ['turn_detection.interruption_delay', { input: { turn_detection: { interruption_delay: 700 } } }],
  ['turn_detection.vad_threshold', { input: { turn_detection: { vad_threshold: 0.5 } } }],
  ['output.volume', { output: { volume: 80 } }],
  ['tools', {
    tools: [{
      type: 'function',
      name: 'send_dtmf',
      description: 'Press digits on the telephone keypad to navigate an IVR menu.',
      parameters: {
        type: 'object',
        properties: {
          digits: { type: 'string', pattern: '^[0-9*#]{1,4}$', description: 'Digits for a single menu level.', examples: ['2'] },
          reason: { type: 'string', description: 'The menu option chosen, for the audit log.' },
        },
        required: ['digits', 'reason'],
      },
    }],
  }],

  // ADR-009 forbids these two. Probed anyway: the decision to never set them is
  // only meaningful if we know they would have been accepted.
  ['turn_detection.min_silence (ADR-009 forbids)', { input: { turn_detection: { min_silence: 400 } } }],
  ['turn_detection.max_silence (ADR-009 forbids)', { input: { turn_detection: { max_silence: 1200 } } }],

  // Immutable fields, probed AFTER session.ready to confirm they are rejected.
  // A session.error with code immutable_field here is the positive result that
  // confirms ADR-006's mutability table.
  ['output.voice AFTER ready (expect immutable_field)', { output: { voice: 'anna' } }],
  ['greeting AFTER ready (expect immutable_field)', { greeting: 'Hello.' }],
];

await withSession('e0', async (ws, log, env, url) => {
  const results = [];
  let pending = null;
  let sessionId = null;

  listen(ws, log, (m) => {
    if (m.type === 'session.ready') {
      sessionId = m.session_id ?? m.session?.id ?? null;
      console.log(`  session.ready  session_id=${sessionId}`);
    }
    if (pending && (m.type === 'session.updated' || m.type === 'session.error')) {
      pending.answers.push({ type: m.type, code: m.code ?? null, message: m.message ?? null });
    }
  });

  // --- Initial configuration: the immutable fields must be correct here ------
  console.log(`\n  initial session.update  (voice="${env.voice}", ${env.encoding} @ ${env.sampleRate})`);
  send(ws, log, {
    type: 'session.update',
    session: {
      system_prompt: 'You are a test agent. Reply briefly.',
      input: { format: { encoding: env.encoding, sample_rate: env.sampleRate } },
      output: { voice: env.voice, format: { encoding: env.encoding, sample_rate: env.sampleRate } },
    },
  });
  await sleep(3000);

  // --- One probe at a time ---------------------------------------------------
  for (const [name, patch] of PROBES) {
    pending = { name, answers: [] };
    process.stdout.write(`  probe ${name.padEnd(46)}`);
    send(ws, log, { type: 'session.update', session: patch });
    await sleep(2200);

    const errors = pending.answers.filter((a) => a.type === 'session.error');
    const verdict = errors.length
      ? `REJECTED (${errors.map((e) => e.code).join(', ')})`
      : pending.answers.some((a) => a.type === 'session.updated')
        ? 'ACCEPTED'
        : 'NO ANSWER';

    console.log(verdict);
    results.push({ probe: name, verdict, answers: pending.answers });
    log.rec('probe_result', { probe: name, verdict, answers: pending.answers });
    pending = null;
  }

  // --- Summary ---------------------------------------------------------------
  console.log(`\n  --- write these back into the SSOT ---`);
  console.log(`  §7.1  endpoint            : ${url}`);
  console.log(`  §7.1  voice accepted      : ${env.voice}`);
  console.log(`  §7.1  audio encoding      : ${env.encoding} @ ${env.sampleRate}`);

  const delay = results.find((r) => r.probe.startsWith('turn_detection.interruption_delay'));
  console.log(`  §13   ENABLE_INTERRUPTION_DELAY = ${delay?.verdict === 'ACCEPTED' ? 'true' : 'false'}   (A-18)`);

  const immutables = results.filter((r) => r.probe.includes('AFTER ready'));
  for (const r of immutables) {
    const ok = r.verdict.startsWith('REJECTED');
    console.log(`  ADR-006 ${r.probe.split(' ')[0].padEnd(16)}: ${ok ? 'confirmed immutable' : 'NOT immutable — ADR-006 needs correcting'}`);
  }

  log.rec('e0_summary', { endpoint: url, voice: env.voice, encoding: env.encoding, results });
}, { endpoints: ENDPOINTS });
