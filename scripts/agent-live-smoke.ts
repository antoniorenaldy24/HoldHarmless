/**
 * Live smoke for packages/agent against the real API (§21 2.4). Spends credit —
 * about a minute of session time, plus the grace window of the one socket it
 * deliberately drops. Run deliberately, not in CI.
 *
 *   1. connect with the full §7.1 configuration
 *   2. reconfigure (session.updated)
 *   3. createReply with one-shot instructions -> an agent turn and audio
 *   4. the three ADR-022 refusals (local; no request reaches the API)
 *   5. a forced disconnect -> recovery as §15 and A-8 describe it
 *   6. createReply on the recovered session -> another turn
 *   7. end() -> session.ended
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { GateIntent } from '@holdharmless/events';
import { AgentSession, ReplyRefused, type AgentEvent, type ConnectionState } from '@holdharmless/agent';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* shell env */ }
const KEY = process.env['ASSEMBLYAI_API_KEY']?.trim();
if (!KEY) { console.error('ASSEMBLYAI_API_KEY is empty (.env)'); process.exit(1); }

const guard: { gateIntent: GateIntent; holdSuspected: boolean } = { gateIntent: 'open', holdSuspected: false };
// A holder: assigned inside the socket factory, which narrowing cannot see.
const sock: { latest: WebSocket | null } = { latest: null };
const events: AgentEvent[] = [];
const connection: ConnectionState[] = [];
const turns: string[] = [];
let audioBytes = 0;

const session = new AgentSession({
  url: (process.env['ASSEMBLYAI_WS_URL'] ?? 'wss://agents.assemblyai.com/v1/ws').trim(),
  apiKey: KEY,
  socket: (url, headers) => (sock.latest = new WebSocket(url, { headers })),
  guard: () => guard,
  enableInterruptionDelay: process.env['ENABLE_INTERRUPTION_DELAY'] !== 'false',
});
session.onEvent((e) => events.push(e));
session.onConnection((c) => connection.push(c));
session.onTurn((speaker, text) => { if (speaker === 'agent') turns.push(text); });
session.onReplyAudio((b) => { audioBytes += b.length; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (what: string, pred: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (!pred()) { if (Date.now() > until) throw new Error(`timed out: ${what}`); await sleep(20); }
};
const check = (ok: boolean, label: string) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) process.exitCode = 1; };

async function replyOnce(instructions: string): Promise<{ text: string; firstAudioMs: number }> {
  const before = turns.length;
  const bytesBefore = audioBytes;
  const t0 = performance.now();
  let first = -1;
  const poll = setInterval(() => { if (first < 0 && audioBytes > bytesBefore) first = performance.now() - t0; }, 5);
  await session.createReply('silence_recovery', instructions);
  await waitFor('agent turn', () => turns.length > before, 20000);
  clearInterval(poll);
  return { text: turns[turns.length - 1]!, firstAudioMs: first };
}

try {
  console.log('1-2. connect and reconfigure');
  await session.connect({
    systemPrompt: 'You are a test agent in a live smoke test. Follow each instruction exactly, in one short sentence.',
    tools: [],
    transcriptionMode: 'balanced',
    keyterms: ['prior authorization'],
    interruptResponse: false,
    interruptionDelayMs: 700,
    voice: 'michael',
    inputFormat: 'audio/pcmu',
    outputFormat: 'audio/pcmu',
  });
  check(/^sess_[0-9a-f]{32}$/.test(session.sessionId() ?? ''), `session id ${session.sessionId()?.slice(0, 9)}…`);
  await session.update({ transcriptionMode: 'max_accuracy' });
  check(true, 'session.updated for a mutable field');

  console.log('3. createReply with one-shot instructions');
  const r1 = await replyOnce('Say exactly: the live smoke test is running.');
  check(/smoke test/i.test(r1.text), `agent turn: "${r1.text}"`);
  check(r1.firstAudioMs > 0, `first reply audio after ${r1.firstAudioMs.toFixed(0)} ms (${audioBytes} bytes so far)`);
  check(events.some((e) => e.t === 'reply.requested' && e.cause === 'silence_recovery'), 'reply.requested logged with its cause');

  console.log('4. ADR-022 refusals (nothing is sent)');
  // A speech reply needs an open gate; 'dtmf_only' forbids speech but not a
  // dtmf reply (ADR-022's first condition, refined 2026-09-23).
  for (const [state, reason] of [[{ gateIntent: 'closed', holdSuspected: false }, 'gate_forbids_product'], [{ gateIntent: 'dtmf_only', holdSuspected: false }, 'gate_forbids_product'], [{ gateIntent: 'open', holdSuspected: true }, 'hold_suspected']] as const) {
    Object.assign(guard, state);
    const e = await session.createReply('silence_recovery').catch((x: unknown) => x);
    check(e instanceof ReplyRefused && e.reason === reason, `${state.gateIntent}/${state.holdSuspected ? 'suspected' : 'clear'} -> ${e instanceof ReplyRefused ? e.reason : 'SENT'}`);
  }
  Object.assign(guard, { gateIntent: 'open', holdSuspected: false });

  console.log('5. forced disconnect');
  const before = session.sessionId();
  const t0 = Date.now();
  sock.latest!.terminate();
  await waitFor('recovery', () => connection.includes('restored') || connection.includes('context_lost') || connection.includes('failed'), 30000);
  const outcome = connection.at(-1);
  const ev = events.find((e) => e.t === 'session.replaced' || e.t === 'session.resumed');
  check(outcome === 'restored' || outcome === 'context_lost', `recovered as '${outcome}' in ${Date.now() - t0} ms; ${ev ? JSON.stringify({ ...ev, previousSessionId: undefined, sessionId: undefined }) : 'no event'}`);
  check(session.sessionId() !== undefined, `session ${before?.slice(0, 9)}… -> ${session.sessionId()?.slice(0, 9)}…`);

  console.log('6. createReply after recovery');
  const r2 = await replyOnce('Say exactly: recovered and still talking.');
  check(/recovered/i.test(r2.text), `agent turn: "${r2.text}"`);
} catch (e) {
  console.error(`  ERROR ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  console.log('7. end');
  await session.end();
  check(sock.latest?.readyState === WebSocket.CLOSED || sock.latest?.readyState === WebSocket.CLOSING, 'session.end sent and socket closed');
}
