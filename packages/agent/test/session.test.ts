/**
 * Acceptance criteria for module 2.4 (§21 week 2):
 *   "Connects, reconfigures, createReply under all three ADR-022 conditions,
 *    resumes after a forced disconnect, handles a gap beyond the window per §15"
 *
 * Against a local fake of the AssemblyAI protocol that reproduces what was
 * OBSERVED: reply.create queued during a reply (E-REPLY), tool.result as a JSON
 * string (E-AUTH), session.updated before session.ready (E0), and resume
 * refused with session_not_found and a 1008 close (A-8). The live API is
 * exercised separately by scripts/agent-live-smoke.ts.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { GateIntent } from '@holdharmless/events';
import {
  AgentSession,
  ReplyRefused,
  SessionError,
  gateAdmitsProduct,
  initialPayload,
  type AgentEvent,
  type ConnectionState,
  type InitialConfig,
} from '../src/index.js';

type Msg = Record<string, any>;

class FakeAssemblyAI {
  readonly wss: WebSocketServer;
  readonly received: Msg[][] = [];
  resume: 'refuse' | 'accept' = 'refuse';
  replyText = 'Hello there.';
  toolCallNext: { name: string; args: unknown } | null = null;
  private sessions = 0;
  private live = new Set<WebSocket>();

  failNextUpdate: string | null = null;
  interruptNext = false;

  private constructor() {
    this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    this.wss.on('connection', (ws, req) => this.accept(ws, req.headers['authorization']));
  }

  static async create(): Promise<FakeAssemblyAI> {
    const f = new FakeAssemblyAI();
    await new Promise<void>((r) => f.wss.once('listening', () => r()));
    return f;
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }

  /** Drops every socket without a close frame — a network failure. */
  dropAll(): void {
    for (const ws of this.live) ws.terminate();
  }

  sent(conn: number, type: string): Msg[] {
    return (this.received[conn] ?? []).filter((m) => m['type'] === type);
  }

  close(): Promise<void> {
    for (const ws of this.live) ws.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }

  private accept(ws: WebSocket, auth: string | undefined): void {
    const log: Msg[] = [];
    this.received.push(log);
    this.live.add(ws);
    ws.on('close', () => this.live.delete(ws));
    let sessionId: string | null = null;
    let replying = false;
    let queued = 0;
    let replyNo = 0;
    const send = (m: Msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

    const runReply = (instructions?: string) => {
      replying = true;
      const id = `resp_${++replyNo}`;
      send({ type: 'reply.started', reply_id: id });
      const text = instructions ? `Instructed: ${instructions}` : this.replyText;
      for (const w of text.split(/(?<= )/)) send({ type: 'transcript.agent.delta', reply_id: id, delta: w });
      send({ type: 'reply.audio', data: Buffer.alloc(320, 0x55).toString('base64') });
      if (this.toolCallNext) {
        send({ type: 'tool.call', call_id: `call_${replyNo}`, name: this.toolCallNext.name, arguments: this.toolCallNext.args });
        this.toolCallNext = null;
      }
      const status = this.interruptNext ? 'interrupted' : 'completed';
      this.interruptNext = false;
      setTimeout(() => {
        send({ type: 'reply.done', reply_id: id, status });
        replying = false;
        // Queued, not rejected or merged (E-REPLY).
        if (queued > 0) { queued--; runReply(); }
      }, 30);
    };

    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as Msg;
      log.push({ ...m, _auth: auth });
      switch (m['type']) {
        case 'session.update':
          if (sessionId === null) {
            sessionId = `sess_${++this.sessions}`;
            send({ type: 'session.updated', config: m['session'] });
            send({ type: 'session.ready', session_id: sessionId, resume_token: 'opaque' });
          } else if (this.failNextUpdate) {
            send({ type: 'session.error', code: this.failNextUpdate, message: 'rejected by the fake', param: 'input.transcription_mode' });
            this.failNextUpdate = null;
          } else {
            send({ type: 'session.updated', config: m['session'] });
          }
          return;
        case 'session.resume':
          if (this.resume === 'accept') {
            sessionId = String(m['session_id']);
            send({ type: 'session.ready', session_id: sessionId });
          } else {
            send({ type: 'session.error', code: 'session_not_found', message: 'Session not found or grace window has expired', session_id: null });
            ws.close(1008);
          }
          return;
        case 'reply.create':
          if (replying) queued++;
          else runReply(m['instructions']);
          return;
        case 'session.end':
          send({ type: 'session.ended' });
          ws.close(1000);
          return;
      }
    });
  }
}

const INITIAL: InitialConfig = {
  systemPrompt: 'You are a test agent.',
  tools: [{ name: 'capture_reference', description: 'Capture a reference number.', parameters: { type: 'object', properties: { value: { type: 'string' } } } }],
  transcriptionMode: 'balanced',
  keyterms: ['prior authorization'],
  interruptResponse: false,
  interruptionDelayMs: 700,
  voice: 'michael',
  inputFormat: 'audio/pcmu',
  outputFormat: 'audio/pcmu',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, pred: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const fakes: FakeAssemblyAI[] = [];
const sessions: AgentSession[] = [];
// End every session first — a session left open by a failed test would keep
// its recovery loop running — then stop the fakes.
after(async () => {
  for (const s of sessions) await s.end().catch(() => {});
  for (const f of fakes) await f.close();
});

async function setup(guard: { gateIntent: GateIntent; holdSuspected: boolean } = { gateIntent: 'open', holdSuspected: false }, extra: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
  const fake = await FakeAssemblyAI.create();
  fakes.push(fake);
  const events: AgentEvent[] = [];
  const connection: ConnectionState[] = [];
  const state = { ...guard };
  const session = new AgentSession({
    url: fake.url,
    apiKey: 'test-key',
    socket: (url, headers) => new WebSocket(url, { headers }),
    guard: () => state,
    enableInterruptionDelay: true,
    ackTimeoutMs: 2000,
    ...extra,
  });
  sessions.push(session);
  session.onEvent((e) => events.push(e));
  session.onConnection((c) => connection.push(c));
  await session.connect(INITIAL);
  return { fake, session, events, connection, state };
}

describe('connect and reconfigure', () => {
  test('connects with the full §7.1 payload, bearer auth, and stores the session id', async () => {
    const { fake, session } = await setup();
    assert.equal(session.sessionId(), 'sess_1');
    const [first] = fake.sent(0, 'session.update');
    assert.equal(first!['_auth'], 'Bearer test-key');
    assert.deepEqual(first!['session'], {
      system_prompt: 'You are a test agent.',
      tools: [{ type: 'function', ...INITIAL.tools[0] }],
      input: {
        transcription_mode: 'balanced',
        keyterms: ['prior authorization'],
        turn_detection: { interrupt_response: false, interruption_delay: 700 },
        format: { encoding: 'audio/pcmu', sample_rate: 8000 },
      },
      output: { voice: 'michael', format: { encoding: 'audio/pcmu', sample_rate: 8000 } },
    });
    await session.end();
  });

  test('the payload never carries greeting, min_silence or max_silence, and omits interruption_delay unless enabled', () => {
    const on = JSON.stringify(initialPayload(INITIAL, true));
    const off = JSON.stringify(initialPayload(INITIAL, false));
    for (const p of [on, off]) assert.doesNotMatch(p, /greeting|min_silence|max_silence/);
    assert.match(on, /interruption_delay/);
    assert.doesNotMatch(off, /interruption_delay/);
  });

  test('an uppercase voice is refused before anything is sent (§7.1: immutable, and invalid_value)', () => {
    assert.throws(() => initialPayload({ ...INITIAL, voice: 'Michael' }, false), /lowercase/);
  });

  test('transcription_prompt is sent when given and omitted when not (ADR-006, ADR-020)', async () => {
    const { fake, session } = await setup();
    await session.update({ transcriptionPrompt: 'A representative is reading an authorization number.' });
    assert.deepEqual(fake.sent(0, 'session.update').at(-1)!['session'], {
      input: { transcription_prompt: 'A representative is reading an authorization number.' },
    });
    const off = JSON.stringify(initialPayload(INITIAL, false));
    assert.doesNotMatch(off, /transcription_prompt/, 'a config without one must not send an empty field');
    await session.end();
  });

  test('update sends only the mutable fields and resolves on session.updated', async () => {
    const { fake, session } = await setup();
    await session.update({ systemPrompt: 'New prompt.', transcriptionMode: 'max_accuracy' });
    const upd = fake.sent(0, 'session.update').at(-1)!;
    assert.deepEqual(upd['session'], { system_prompt: 'New prompt.', input: { transcription_mode: 'max_accuracy' } });
    await session.end();
  });

  test('a session.error rejects the request it answers, with its code and param', async () => {
    const { fake, session } = await setup();
    fake.failNextUpdate = 'invalid_value';
    await assert.rejects(session.update({ transcriptionMode: 'balanced' }), (e) =>
      e instanceof SessionError && e.code === 'invalid_value' && e.param === 'input.transcription_mode');
    await session.update({ transcriptionMode: 'balanced' }); // the session is still usable
    await session.end();
  });
});

describe('createReply under the three ADR-022 conditions', () => {
  test('allowed when the gate is open, hold is not suspected and no reply is outstanding; logged with its cause', async () => {
    const { fake, session, events } = await setup();
    await session.createReply('silence_recovery', 'Ask whether they are still there.');
    await waitFor('reply.create at the server', () => fake.sent(0, 'reply.create').length === 1);
    assert.deepEqual(fake.sent(0, 'reply.create'), [{ type: 'reply.create', instructions: 'Ask whether they are still there.', _auth: 'Bearer test-key' }]);
    assert.deepEqual(events[0], { t: 'reply.requested', cause: 'silence_recovery', instructions: 'Ask whether they are still there.' });
    await session.end();
  });

  for (const gate of ['closed', 'dtmf_only'] as const) {
    test(`a speech reply is refused while the gate is ${gate}, and nothing is sent or logged`, async () => {
      const { fake, session, events } = await setup({ gateIntent: gate, holdSuspected: false });
      await assert.rejects(session.createReply('silence_recovery'), (e) => e instanceof ReplyRefused && e.reason === 'gate_forbids_product');
      assert.equal(fake.sent(0, 'reply.create').length, 0);
      assert.equal(events.length, 0);
      await session.end();
    });
  }

  test('a dtmf reply passes a dtmf_only gate — §5.7 IVR navigation recovery (ADR-022, refined 2026-09-23)', async () => {
    const { fake, session, events } = await setup({ gateIntent: 'dtmf_only', holdSuspected: false });
    await session.createReply('silence_recovery', 'Press the option for prior authorization.', 'dtmf');
    await waitFor('reply.create at the server', () => fake.sent(0, 'reply.create').length === 1);
    assert.equal(events[0]!.t, 'reply.requested');
    await session.end();
  });

  test('a dtmf reply is still refused while the gate is closed, and while hold is suspected', async () => {
    const closed = await setup({ gateIntent: 'closed', holdSuspected: false });
    await assert.rejects(closed.session.createReply('silence_recovery', undefined, 'dtmf'), (e) => e instanceof ReplyRefused && e.reason === 'gate_forbids_product');
    await closed.session.end();
    const held = await setup({ gateIntent: 'dtmf_only', holdSuspected: true });
    await assert.rejects(held.session.createReply('silence_recovery', undefined, 'dtmf'), (e) => e instanceof ReplyRefused && e.reason === 'hold_suspected');
    await held.session.end();
  });

  test('the gate rule itself, as a table', () => {
    const cases: [Parameters<typeof gateAdmitsProduct>[0], Parameters<typeof gateAdmitsProduct>[1], boolean][] = [
      ['open', 'speech', true], ['open', 'dtmf', true],
      ['dtmf_only', 'speech', false], ['dtmf_only', 'dtmf', true],
      ['closed', 'speech', false], ['closed', 'dtmf', false],
    ];
    for (const [gate, produces, expected] of cases) assert.equal(gateAdmitsProduct(gate, produces), expected, `${gate}/${produces}`);
  });

  test('refused while hold is suspected, even with the gate open (INV-4 by construction)', async () => {
    const { fake, session } = await setup({ gateIntent: 'open', holdSuspected: true });
    await assert.rejects(session.createReply('silence_recovery'), (e) => e instanceof ReplyRefused && e.reason === 'hold_suspected');
    assert.equal(fake.sent(0, 'reply.create').length, 0);
    await session.end();
  });

  test('refused while a reply is outstanding: a second call would buy a second utterance (E-REPLY)', async () => {
    const { fake, session } = await setup();
    await session.createReply('silence_recovery');
    await assert.rejects(session.createReply('silence_recovery'), (e) => e instanceof ReplyRefused && e.reason === 'reply_outstanding');
    await sleep(20);
    assert.equal(fake.sent(0, 'reply.create').length, 1);
    await new Promise<void>((r) => session.onReplyDone(() => r()));
    await session.createReply('silence_recovery'); // allowed again once done
    await session.end();
  });

  test('the guard is read at every call, never cached', async () => {
    const { session, state } = await setup({ gateIntent: 'closed', holdSuspected: false });
    await assert.rejects(session.createReply('silence_recovery'));
    state.gateIntent = 'open';
    await session.createReply('silence_recovery');
    await session.end();
  });
});

describe('turns, audio and tools', () => {
  test('agent turns are assembled from deltas; far-end turns come from transcript.user; audio is decoded', async () => {
    const { session } = await setup();
    const turns: [string, string][] = [];
    let audio = 0;
    session.onTurn((sp, text) => turns.push([sp, text]));
    session.onReplyAudio((b) => { audio += b.length; });
    await session.createReply('silence_recovery');
    await waitFor('agent turn', () => turns.length > 0);
    assert.deepEqual(turns[0], ['agent', 'Hello there.']);
    assert.equal(audio, 320);
    await session.end();
  });

  test('tool.result is held until reply.done, sent as a JSON string, one per call_id', async () => {
    const { fake, session } = await setup();
    fake.toolCallNext = { name: 'capture_reference', args: { value: 'R-14209' } };
    const calls: string[] = [];
    session.onToolCall((id, name, args) => {
      calls.push(`${name}:${JSON.stringify(args)}`);
      session.queueToolResult(id, { ok: true });
      // Queued mid-reply: nothing may be on the wire yet.
      assert.equal(fake.sent(0, 'tool.result').length, 0);
    });
    await session.createReply('silence_recovery');
    await waitFor('tool.result', () => fake.sent(0, 'tool.result').length === 1);
    assert.deepEqual(calls, ['capture_reference:{"value":"R-14209"}']);
    const r = fake.sent(0, 'tool.result')[0]!;
    assert.equal(r['call_id'], 'call_1');
    assert.equal(typeof r['result'], 'string');
    assert.deepEqual(JSON.parse(r['result']), { ok: true });
    await session.end();
  });

  test('an interrupted reply discards its pending results — reported, never sent (§8.8 rule 3)', async () => {
    const { fake, session, events } = await setup();
    fake.toolCallNext = { name: 'capture_reference', args: { value: 'R-2' } };
    fake.interruptNext = true;
    session.onToolCall((id) => session.queueToolResult(id, { ok: true }));
    const done = new Promise<string>((r) => session.onReplyDone(r));
    await session.createReply('silence_recovery');
    assert.equal(await done, 'interrupted');
    await sleep(50);
    assert.equal(fake.sent(0, 'tool.result').length, 0);
    assert.ok(events.some((e) => e.t === 'tool.result_discarded' && e.toolCallId === 'call_1'));
    await session.end();
  });

  test('a result queued after its reply is done is sent at once — the model is waiting on it', async () => {
    const { fake, session } = await setup();
    await session.createReply('silence_recovery');
    await new Promise<void>((r) => session.onReplyDone(() => r()));
    session.queueToolResult('late_call', { ok: true });
    await waitFor('late result', () => fake.sent(0, 'tool.result').length === 1);
    await session.end();
  });
});

describe('disconnect and recovery (§15, as A-8 observed it)', () => {
  test('resume refused (as observed): a new session opens with the FULL config; context reported lost', async () => {
    const { fake, session, events, connection } = await setup();
    fake.dropAll();
    await waitFor('replacement', () => connection.includes('context_lost'));

    assert.deepEqual(connection, ['lost', 'context_lost']);
    await sleep(300);
    // The refused resume is answered with an error AND a close. That close must
    // not start a second recovery: one replacement session, not two.
    assert.equal(fake.received.length, 3, 'original, resume attempt, one replacement');
    assert.equal(events.filter((e) => e.t === 'session.replaced').length, 1);
    assert.equal(fake.sent(1, 'session.resume')[0]!['session_id'], 'sess_1', 'one resume was attempted, with the stored id');
    const full = fake.sent(2, 'session.update')[0]!;
    assert.deepEqual(full['session']['output'], { voice: 'michael', format: { encoding: 'audio/pcmu', sample_rate: 8000 } }, 'immutable fields re-sent');
    assert.equal(session.sessionId(), 'sess_2');
    const replaced = events.find((e) => e.t === 'session.replaced')!;
    assert.deepEqual({ ...replaced, gapMs: 0 }, { t: 'session.replaced', previousSessionId: 'sess_1', sessionId: 'sess_2', gapMs: 0, reason: 'session_not_found' });
    await session.createReply('silence_recovery'); // the call continues
    await session.end();
  });

  test('resume accepted (as documented): same session, position config re-sent, session.resumed with gapMs', async () => {
    const { fake, session, events, connection } = await setup();
    fake.resume = 'accept';
    fake.dropAll();
    await waitFor('restored', () => connection.includes('restored'));
    assert.equal(session.sessionId(), 'sess_1');
    assert.equal(fake.sent(1, 'session.update').length, 1, 'position configuration re-sent (§15 step 3)');
    assert.equal(fake.sent(1, 'session.update')[0]!['session']['output'], undefined, 'without immutable fields');
    assert.ok(events.some((e) => e.t === 'session.resumed' && e.sessionId === 'sess_1'));
    await session.end();
  });

  test('a gap beyond the window skips resume and opens a new session', async () => {
    // The first reconnect attempt finds the network down, and 40 s pass before
    // the next: that attempt is past the window and must not try to resume.
    let clock = 1_000_000;
    let calls = 0;
    const fakeRef: { url: string } = { url: '' };
    const { fake, session, connection } = await setup(undefined, {
      now: () => clock,
      resumeWindowMs: 30_000,
      socket: (url, headers) => {
        calls++;
        if (calls === 2) {
          clock += 40_000;
          return new WebSocket('ws://127.0.0.1:1', { headers }); // refused
        }
        return new WebSocket(fakeRef.url || url, { headers });
      },
    });
    fakeRef.url = fake.url;
    fake.dropAll();
    await waitFor('replacement', () => connection.includes('context_lost'), 5000);
    assert.equal(fake.received.flat().filter((m) => m['type'] === 'session.resume').length, 0, 'no resume after the window');
    assert.ok(fake.sent(1, 'session.update')[0]!['session']['output'], 'the new session got the full configuration');
    await session.end();
  });

  test('while disconnected: audio is dropped and counted, createReply is refused, pending tool results die with the turn', async () => {
    const { fake, session, events, connection } = await setup();
    fake.toolCallNext = { name: 'capture_reference', args: { value: 'R-1' } };
    let toolCalled = false;
    session.onToolCall((id) => { toolCalled = true; session.queueToolResult(id, { ok: true }); });
    let refusal: unknown = null;
    session.onConnection((c) => {
      if (c !== 'lost') return;
      // Checked inside the 'lost' callback: on localhost recovery completes in
      // milliseconds, so a check after it would see a reconnected session.
      session.sendAudio(new Uint8Array(160));
      session.createReply('silence_recovery').catch((e: unknown) => { refusal = e; });
    });
    await session.createReply('silence_recovery');
    await waitFor('tool call', () => toolCalled);
    fake.dropAll(); // before the reply's reply.done
    await waitFor('replaced', () => connection.includes('context_lost'));
    assert.equal(session.framesDroppedWhileDisconnected(), 1);
    assert.ok(refusal instanceof ReplyRefused && refusal.reason === 'not_connected');
    assert.ok(events.some((e) => e.t === 'tool.result_discarded' && e.toolCallId === 'call_1' && e.name === 'capture_reference'));
    assert.equal(fake.received.flat().filter((m) => m['type'] === 'tool.result').length, 0, 'the result was never sent');
    await session.end();
  });

  test('end() during recovery still ends the session recovery was opening (no orphan billed)', async () => {
    // end() lands after the replacement socket opened and before its
    // session.ready: the moment a session exists that nobody else would end.
    let calls = 0;
    const hook: { session: AgentSession | null } = { session: null };
    const { fake, session, connection } = await setup(undefined, {
      socket: (url, headers) => {
        const ws = new WebSocket(url, { headers });
        if (++calls === 3) ws.once('open', () => void hook.session!.end()); // 1 = first, 2 = resume, 3 = replacement
        return ws;
      },
    });
    hook.session = session;
    fake.dropAll();
    await waitFor('the replacement was ended', () => fake.sent(2, 'session.end').length === 1, 3000);
    assert.equal(fake.sent(2, 'session.update').length, 1, 'the replacement session was opened');
    assert.ok(!connection.includes('context_lost'), 'the call did not go on after end()');
  });

  test('end() sends session.end, waits for session.ended, and never reconnects', async () => {
    const { fake, session, connection } = await setup();
    await session.end();
    assert.equal(fake.sent(0, 'session.end').length, 1);
    await sleep(300);
    assert.deepEqual(connection, []);
    assert.equal(fake.received.length, 1, 'no new connection after an intentional end');
  });
});

