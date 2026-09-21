/**
 * A-8 probe — what `session.resume` actually does. Spends credit (about two
 * minutes of session time); run deliberately, not in CI.
 *
 * Day 0 never exercised resume, so §15 describes it from documentation: send
 * `session.resume` with the stored `session_id` within 30 s, and context is
 * preserved. This probe checks each clause against the live API:
 *
 *   A. Within the window: open a session, have the agent note a code word,
 *      drop the socket WITHOUT session.end, reconnect after ~2 s, resume, ask
 *      for the code word. Records the message shape that works, the server's
 *      reply to it, whether configuration carried over, and whether context did.
 *   B. Beyond the window: drop, wait 35 s, try to resume. Records the refusal.
 *
 * Every inbound message is logged verbatim to logs/a8-resume.jsonl before it is
 * interpreted, and every socket that reached session.ready is ended with
 * session.end in a finally block (§15 cost note).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* shell env */ }
const KEY = process.env['ASSEMBLYAI_API_KEY']?.trim();
if (!KEY) { console.error('ASSEMBLYAI_API_KEY is empty (.env)'); process.exit(1); }
const URL_ = (process.env['ASSEMBLYAI_WS_URL'] ?? 'wss://agents.assemblyai.com/v1/ws').trim();

fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
const logFile = path.join(ROOT, 'logs', 'a8-resume.jsonl');
const log = (tag: string, data: unknown) =>
  fs.appendFileSync(logFile, JSON.stringify({ t: Date.now(), tag, data }) + '\n');

type Msg = Record<string, unknown> & { type: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Conn {
  readonly msgs: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg | null) => void }[] = [];
  constructor(readonly ws: WebSocket, readonly label: string) {
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as Msg;
      log(`${label}:recv`, m.type === 'reply.audio' ? { type: m.type, bytes: String(m['data'] ?? '').length } : m);
      this.msgs.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
    });
    ws.on('close', (code, reason) => log(`${label}:close`, { code, reason: String(reason) }));
  }
  static open(label: string): Promise<Conn> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(URL_, { headers: { Authorization: `Bearer ${KEY}` } });
      ws.once('open', () => resolve(new Conn(ws, label)));
      ws.once('error', reject);
    });
  }
  send(m: Msg) { log(`${this.label}:send`, m); this.ws.send(JSON.stringify(m)); }
  wait(pred: (m: Msg) => boolean, ms: number): Promise<Msg | null> {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); resolve(null); } }, ms);
    });
  }
  /** The agent's reply text, from deltas and/or the rare final (§7.6). */
  async replyText(ms: number): Promise<string> {
    const from = this.msgs.length;
    const done = await this.wait((m) => m.type === 'reply.done' && this.msgs.indexOf(m) >= from, ms);
    const slice = this.msgs.slice(from);
    const final = slice.find((m) => m.type === 'transcript.agent');
    const deltas = slice.filter((m) => m.type === 'transcript.agent.delta').map((m) => String(m['delta'])).join('');
    return `${final ? String(final['text']) : deltas}${done ? '' : ' [no reply.done]'}`;
  }
  async end() {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'session.end' });
    await this.wait((m) => m.type === 'session.ended', 3000);
    this.ws.close();
  }
}

const CONFIG = {
  system_prompt: 'You are a test agent in a protocol probe. Follow each instruction exactly and reply in one short sentence.',
  input: { format: { encoding: 'audio/pcmu', sample_rate: 8000 }, transcription_mode: 'balanced' },
  output: { voice: 'michael', format: { encoding: 'audio/pcmu', sample_rate: 8000 } },
};

async function openSession(label: string): Promise<{ c: Conn; sessionId: string; resumeToken: string | undefined }> {
  const c = await Conn.open(label);
  c.send({ type: 'session.update', session: CONFIG });
  const ready = await c.wait((m) => m.type === 'session.ready', 8000);
  if (!ready) throw new Error(`${label}: no session.ready`);
  const token = ready['resume_token'];
  return { c, sessionId: String(ready['session_id']), resumeToken: typeof token === 'string' ? token : undefined };
}

/** How part A drops the socket: 'terminate' (TCP reset) or 'close' (WebSocket close frame, no session.end). */
const DROP = (process.argv.find((a) => a.startsWith('--drop='))?.slice(7) ?? 'terminate') as 'terminate' | 'close';
const SKIP_B = process.argv.includes('--skip-b');
const WITH_TOKEN = !process.argv.includes('--no-token');
const findings: Record<string, unknown> = { drop: DROP, withToken: WITH_TOKEN };
const open: Conn[] = [];

try {
  // ------------------------------------------------------------------ A
  console.log('A. resume inside the window');
  const a = await openSession('A1');
  open.push(a.c);
  a.c.send({ type: 'reply.create', instructions: 'The code word is BLUE SEVEN. Say only: noted, blue seven.' });
  findings['A_before'] = await a.c.replyText(15000);
  console.log(`  before drop, agent said: ${findings['A_before']}`);

  if (DROP === 'close') a.c.ws.close(1000); else a.c.ws.terminate(); // a drop, not an end
  const droppedAt = Date.now();
  await sleep(2000);

  const r = await Conn.open('A2');
  open.push(r);
  // session.ready carries a resume_token that the documentation read for this
  // probe does not mention; the first runs, without it, got session_not_found
  // at 2.8 s after both a TCP reset and a clean close.
  r.send({ type: 'session.resume', session_id: a.sessionId, ...(WITH_TOKEN && a.resumeToken ? { resume_token: a.resumeToken } : {}) });
  const first = await r.wait((m) => ['session.ready', 'session.resumed', 'session.error', 'session.updated'].includes(m.type), 8000);
  findings['A_gapMs'] = Date.now() - droppedAt;
  findings['A_resumeReply'] = first;
  console.log(`  resume after ${findings['A_gapMs']} ms -> ${first ? JSON.stringify(first).slice(0, 300) : 'NO REPLY'}`);

  if (first && first.type !== 'session.error') {
    // Did configuration carry over? Ask for a reply BEFORE re-sending config.
    r.send({ type: 'reply.create', instructions: 'What code word were you told earlier in this conversation? Say it, or say: no code word.' });
    findings['A_after'] = await r.replyText(15000);
    console.log(`  after resume, agent said: ${findings['A_after']}`);
    r.send({ type: 'session.update', session: { system_prompt: CONFIG.system_prompt } });
    findings['A_reconfig'] = (await r.wait((m) => m.type === 'session.updated' || m.type === 'session.error', 5000))?.type ?? 'no reply';
    console.log(`  re-sent configuration -> ${findings['A_reconfig']}`);
  }
  await r.end();

  // ------------------------------------------------------------------ B
  if (!SKIP_B) {
  console.log('B. resume beyond the window (35 s)');
  const b = await openSession('B1');
  open.push(b.c);
  b.c.ws.terminate();
  const bDropped = Date.now();
  await sleep(35_000);
  const rb = await Conn.open('B2');
  open.push(rb);
  rb.send({ type: 'session.resume', session_id: b.sessionId, ...(WITH_TOKEN && b.resumeToken ? { resume_token: b.resumeToken } : {}) });
  const bReply = await rb.wait((m) => ['session.ready', 'session.resumed', 'session.error'].includes(m.type), 8000);
  findings['B_gapMs'] = Date.now() - bDropped;
  findings['B_resumeReply'] = bReply;
  console.log(`  resume after ${findings['B_gapMs']} ms -> ${bReply ? JSON.stringify(bReply).slice(0, 300) : 'NO REPLY'}`);
  await rb.end();
  }
} finally {
  for (const c of open) await c.end().catch(() => {});
  log('findings', findings);
  fs.writeFileSync(path.join(ROOT, 'logs', 'a8-findings.json'), JSON.stringify(findings, null, 2));
  console.log(`\nlog: ${path.relative(process.cwd(), logFile)}`);
}
