/**
 * The media path — module 4.0, reply half, step 2.
 *
 * The session is a stand-in with the same surface as `AgentSession`, driven by
 * the test, so every rule here can be checked without a socket or credit. The
 * transport enforces the gate exactly as the real one does, and the Audio
 * Bridge is the real one, on time the test controls.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BYTES_PER_FRAME, MULAW_SILENCE } from '@holdharmless/audio';
import type { ReplyCause, ReplyGuardState, SessionConfig } from '@holdharmless/agent';
import { HOLD_CONFIRM_MS, HOLD_TIMEOUT_MS, PARTY_CONTINUITY_MS, type ChannelTimers } from '@holdharmless/callmodel';
import { checkInvariants } from '@holdharmless/invariants';
import type { AuthRequest, GateIntent, ToolName } from '@holdharmless/events';
import { PROFILES, gateAdmits, type AudioSource, type CallTransport } from '@holdharmless/transport';
import { PLAYOUT_MARK_TIMEOUT_MS, createEventLog, createWorkQueue, dropCauseOf, startCall, type AgentMedia, type BridgeScheduler } from '../src/index.js';

const request: AuthRequest = {
  // Synthetic by INV-12's rules, so the end-to-end tests can hold the whole
  // log to every invariant without a fixture exemption.
  id: 'R1', patientRef: 'SYN-P1', memberId: 'SYN-M1', patientDob: '1970-01-01',
  cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-01',
  payerId: 'payer', payerEndpoint: 'ws://127.0.0.1:8090', clinicName: 'Clinic', clinicCallbackPhone: '555-0142',
  priority: 'routine', clinicalSummary: 's', status: 'in_progress', attempts: 0,
};

/** Every surface of the session the media path uses, driven by the test. */
class FakeSession implements AgentMedia {
  heard: Uint8Array[] = [];
  updates: Partial<SessionConfig>[] = [];
  private h = {
    delta: [] as ((t: string) => void)[],
    turn: [] as ((s: 'agent' | 'far_end', t: string, c: boolean) => void)[],
    speech: [] as (() => void)[],
    audio: [] as ((b: Uint8Array) => void)[],
    started: [] as (() => void)[],
    done: [] as ((s: 'completed' | 'interrupted') => void)[],
  };
  /** What the guard said while the session was being built — before the call was wired. */
  readonly guardAtConstruction: ReplyGuardState;
  ended = false;
  constructor(readonly guard: () => ReplyGuardState, readonly isClosing: () => boolean = () => false) {
    // A real session could consult its guard at any moment, including this one.
    this.guardAtConstruction = guard();
  }
  end(): Promise<void> { this.ended = true; return Promise.resolve(); }
  sendAudio(f: Uint8Array): void { this.heard.push(f); }
  onTranscriptDelta(f: (t: string) => void): void { this.h.delta.push(f); }
  onTurn(f: (s: 'agent' | 'far_end', t: string, c: boolean) => void): void { this.h.turn.push(f); }
  onSpeechStarted(f: () => void): void { this.h.speech.push(f); }
  onReplyAudio(f: (b: Uint8Array) => void): void { this.h.audio.push(f); }
  onReplyStarted(f: () => void): void { this.h.started.push(f); }
  onReplyDone(f: (s: 'completed' | 'interrupted') => void): void { this.h.done.push(f); }
  update(cfg: Partial<SessionConfig>): Promise<void> { this.updates.push(cfg); return Promise.resolve(); }
  /** What the session holds now: every update applied in order. */
  get config(): Partial<SessionConfig> { return Object.assign({}, ...this.updates); }

  // --- tools ---------------------------------------------------------------
  private toolHandlers: ((id: string, n: ToolName, a: unknown) => void)[] = [];
  results: { callId: string; result: unknown; isError: boolean }[] = [];
  replyRequests: { cause: ReplyCause; instructions?: string }[] = [];
  /** When set, createReply refuses as the real session would. */
  refuseReplies = false;
  onToolCall(f: (id: string, n: ToolName, a: unknown) => void): void { this.toolHandlers.push(f); }
  queueToolResult(callId: string, result: unknown, isError = false): void { this.results.push({ callId, result, isError }); }
  createReply(cause: ReplyCause, instructions?: string): Promise<void> {
    if (this.refuseReplies) return Promise.reject(new Error('reply_outstanding'));
    this.replyRequests.push({ cause, ...(instructions !== undefined ? { instructions } : {}) });
    return Promise.resolve();
  }
  /** The model calls a tool; returns the result the session would send back. */
  callsTool(name: ToolName, args: unknown, callId = `c${this.results.length + 1}`) {
    for (const f of this.toolHandlers) f(callId, name, args);
    return this.results.find((r) => r.callId === callId)!;
  }

  // --- what the server would do -------------------------------------------
  farEndSays(text: string): void {
    for (const f of this.h.delta) f(text);
    for (const f of this.h.turn) f('far_end', text, false);
  }
  replies(bytes: Uint8Array): void {
    for (const f of this.h.started) f();
    for (const f of this.h.audio) f(bytes);
  }
  replyDone(status: 'completed' | 'interrupted'): void { for (const f of this.h.done) f(status); }
  /** Like the real session: the closing flag is ASKED for when the turn is emitted (§7.6). */
  agentTurn(text: string, closing = this.isClosing()): void { for (const f of this.h.turn) f('agent', text, closing); }
  /** One whole spoken reply: started, audio, its transcript, done. */
  speaks(text: string, frames = 10, status: 'completed' | 'interrupted' = 'completed'): void {
    this.replies(new Uint8Array(frames * BYTES_PER_FRAME).fill(0x30));
    this.agentTurn(text);
    this.replyDone(status);
  }
  speechStarted(): void { for (const f of this.h.speech) f(); }
}

function fakeTransport() {
  let intent: GateIntent = 'closed';
  const sent: { frame: Uint8Array; source: AudioSource }[] = [];
  let clears = 0;
  let hangups = 0;
  let onAudio: ((f: Uint8Array) => void) | null = null;
  let onClosed: ((c: 'far_end_hangup' | 'link_drop' | 'timeout') => void) | null = null;
  const markHandlers: ((name: string) => void)[] = [];
  const marks: string[] = [];
  /** Whether the far end answers a mark (it has played everything before it). */
  let echoMarks = true;
  const t: CallTransport = {
    kind: 'loopback',
    dial: async () => {},
    sendAudio(frame, source) {
      if (!gateAdmits(intent, source)) return false;
      sent.push({ frame, source });
      return true;
    },
    clear: async () => { clears++; return []; },
    mark: async (name) => {
      marks.push(name);
      if (echoMarks) for (const h of markHandlers) h(name);
    },
    applyGate(next) { intent = next; },
    gate: () => intent,
    hangup: async () => { hangups++; },
    onAudio(h) { onAudio = h; },
    onMark(h) { markHandlers.push(h); },
    onFault() {},
    onClosed(h) { onClosed = h; },
  };
  return {
    t, sent, marks,
    feed: (f: Uint8Array) => onAudio?.(f),
    close: (c: 'far_end_hangup' | 'link_drop' | 'timeout') => onClosed?.(c),
    silenceMarks: () => { echoMarks = false; },
    get clears() { return clears; },
    get hangups() { return hangups; },
    get intent() { return intent; },
  };
}

function manualTime() {
  let now = 0;
  let fn: (() => void) | null = null;
  const scheduler: BridgeScheduler = { every(f) { fn = f; return () => { if (fn === f) fn = null; }; } };
  // The §5.3 timers, on the same clock.
  const pending: { at: number; f: () => void; live: boolean }[] = [];
  const timers: ChannelTimers = {
    after(ms, f) {
      const t = { at: now + ms, f, live: true };
      pending.push(t);
      return () => { t.live = false; };
    },
  };
  return {
    now: () => now,
    scheduler,
    timers,
    advance(ms: number) {
      now += ms;
      fn?.();
      for (;;) {
        const due = pending.filter((t) => t.live && t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        due.f();
      }
    },
  };
}

function rig(over: Partial<AuthRequest> = {}) {
  const tp = fakeTransport();
  const clock = manualTime();
  const log = createEventLog({ callId: 'CALL-L' });
  let session!: FakeSession;
  // A fresh record per call: tools write to it (lastReference, status).
  const req: AuthRequest = { ...request, ...over };
  const queue = createWorkQueue({ requests: [req], emit: (e) => log.append(e) });
  const call = startCall({
    request: req, queue, log, transport: tp.t, navMode: 'dtmf', networkProfile: 'TELEPHONY',
    createSession: (guard, isClosing) => (session = new FakeSession(guard, isClosing)),
    nowMs: clock.now,
    epochMs: () => 1_000_000 + clock.now(),
    timers: clock.timers,
    bridge: { now: clock.now, scheduler: clock.scheduler },
  });
  const human = () => call.loop.gate.setChannel('HUMAN', { kind: 'transport', cause: 'test' });
  return { tp, clock, log, call, session, human, req, queue, kinds: () => log.events().map((e) => e.t) };
}

const speech = (frames: number) => new Uint8Array(frames * BYTES_PER_FRAME).fill(0x30);

describe('the agent hears everything; the gate governs only what it says', () => {
  test('every far-end frame reaches the session, whatever the gate', () => {
    const r = rig();
    assert.equal(r.tp.intent, 'closed', 'DIALING: the gate is shut');
    for (let i = 0; i < 10; i++) r.tp.feed(new Uint8Array(BYTES_PER_FRAME).fill(MULAW_SILENCE));
    assert.equal(r.session.heard.length, 10, 'and the agent still heard all of it');
  });
});

describe('agent speech goes out through the bridge (§4)', () => {
  test('paced, not dumped', () => {
    const r = rig();
    r.human();
    r.session.replies(speech(50));
    assert.equal(r.tp.sent.length, 1, 'one frame now, the rest on the cadence');
    r.clock.advance(1000);
    assert.equal(r.tp.sent.length, 50);
  });

  test('a completed reply s last partial frame is sent, not held', () => {
    const r = rig();
    r.human();
    r.session.replies(new Uint8Array(BYTES_PER_FRAME + 40).fill(0x30));
    r.session.replyDone('completed');
    r.clock.advance(200);
    assert.equal(r.tp.sent.length, 2);
  });
});

describe('the gate reaches the reply (ADR-007, through the bridge)', () => {
  test('a cue phrase mid-reply stops the rest of the reply — here AND at the far end', () => {
    const r = rig();
    r.human();
    r.session.replies(speech(100)); // two seconds of reply queued
    r.clock.advance(200);
    const before = r.tp.sent.length;
    r.session.farEndSays('let me check that for you');
    assert.equal(r.tp.intent, 'closed');
    assert.equal(r.call.bridge.pending('agent'), 0, 'the queued tail was flushed, not left to play later');
    r.clock.advance(2000);
    assert.equal(r.tp.sent.length, before, 'nothing more went out');
  });

  test('audio the model produces while muted never plays when the gate reopens', () => {
    const r = rig();
    r.human();
    r.session.farEndSays('let me check that for you');
    r.session.replies(speech(40)); // generated during the mute
    r.session.farEndSays('okay, I can see the member right here');
    r.session.farEndSays('and I have the request open now, so what did you need');
    assert.equal(r.tp.intent, 'open', 'the gate reopened (§6.5, N=2)');
    r.clock.advance(2000);
    assert.equal(r.tp.sent.length, 0);
  });
});

describe('interruption (§3)', () => {
  test('far-end speech starting clears the queued reply and the far end', () => {
    const r = rig();
    r.human();
    r.session.replies(speech(100));
    r.session.speechStarted();
    assert.equal(r.call.bridge.pending('agent'), 0);
    assert.equal(r.tp.clears, 1);
  });

  test('a reply the server interrupted does not play its tail', () => {
    const r = rig();
    r.human();
    r.session.replies(speech(100));
    r.session.replyDone('interrupted');
    assert.equal(r.call.bridge.pending('agent'), 0);
  });
});

describe('the session s guard reads the gate (ADR-022)', () => {
  test('closed until wired, then whatever the gate is', () => {
    const r = rig();
    // The window that matters is DURING construction, when the loop the guard
    // reads does not exist yet. An open answer there would let a reply out
    // before anything could have closed the gate.
    assert.deepEqual(r.session.guardAtConstruction, { gateIntent: 'closed', holdSuspected: false });
    assert.deepEqual(r.session.guard(), { gateIntent: 'closed', holdSuspected: false });
    r.human();
    assert.deepEqual(r.session.guard(), { gateIntent: 'open', holdSuspected: false });
    r.session.farEndSays('one moment please');
    assert.deepEqual(r.session.guard(), { gateIntent: 'closed', holdSuspected: true });
  });
});

describe('transcripts reach the semantic layer, turn ends included', () => {
  test('the latch §6.8 describes does not happen through a real session s events', () => {
    const r = rig();
    r.human();
    r.session.farEndSays('let me check that for you');
    r.session.farEndSays('okay, I can see the member right here');
    r.session.farEndSays('and I have the request open now, so what did you need');
    assert.equal(r.call.loop.gate.gate, 'open');
  });

  test('the agent speaking makes responsiveness available to the next far-end turn (§6.2)', () => {
    // §6.2's highest-weighted HUMAN signal. It no longer decides a hold cue —
    // a listed cue is decisive (fixed 2026-09-30) — but on ordinary speech it is
    // still what makes a person read as a person quickly, which A-5 measures.
    const r = rig();
    r.human();
    r.session.replies(speech(5));
    r.clock.advance(800);
    r.session.farEndSays('sure, and what is the member ID');
    const obs = r.log.events().filter((e) => e.t === 'semantic.observed');
    const last = obs[obs.length - 1]!;
    assert.ok(last.t === 'semantic.observed' && last.obs.signalsAvailable.includes('responsiveness'));
  });

  test('agent turns are logged, redactable, with the closing flag carried', () => {
    const r = rig();
    r.session.agentTurn('The authorization number is A472-91, is that right?', false);
    r.session.agentTurn('Thank you, goodbye.', true);
    const turns = r.log.events().filter((e) => e.t === 'turn.transcribed' && e.speaker === 'agent');
    assert.equal(turns.length, 2);
    assert.ok(turns.every((e) => e.t === 'turn.transcribed' && e.redactable));
    assert.equal(turns[1]!.t === 'turn.transcribed' && turns[1]!.isClosing, true);
  });
});

describe('stop()', () => {
  test('nothing moves after the call is stopped', () => {
    const r = rig();
    r.human();
    r.call.stop();
    r.session.replies(speech(20));
    r.tp.feed(new Uint8Array(BYTES_PER_FRAME));
    r.clock.advance(1000);
    assert.equal(r.tp.sent.length, 0);
    assert.equal(r.session.heard.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Step 3: the session is told what each position is
// ---------------------------------------------------------------------------

const toolsOf = (c: Partial<SessionConfig>) => (c.tools ?? []).map((t) => t.name);
const HUMAN_LINES = ['okay, I can see the member right here', 'and I have the request open now, so what did you need'];

describe('per-position configuration reaches the session (§5.6, §7.3)', () => {
  test('dialed: the menu prompt and send_dtmf; a person answers: the exchange, with the disclosure', async () => {
    const r = rig();
    await r.call.loop.dial('ws://payer', PROFILES.TELEPHONY);
    await r.call.configurator.idle();
    assert.deepEqual(toolsOf(r.session.config), ['send_dtmf']);
    assert.equal(r.session.config.interruptResponse, false);

    r.session.farEndSays(HUMAN_LINES[0]!);
    r.session.farEndSays(HUMAN_LINES[1]!);
    await r.call.configurator.idle();
    assert.equal(r.call.loop.gate.channel, 'HUMAN', 'nobody set the channel by hand');
    assert.ok(toolsOf(r.session.config).includes('capture_auth_number'));
    assert.equal(r.session.config.interruptResponse, true);
    const loaded = r.log.events().filter((e) => e.t === 'prompt.loaded');
    assert.deepEqual(loaded.map((e) => e.t === 'prompt.loaded' && e.files), [['IVR_DTMF.txt'], ['EXCHANGE.txt', 'DISCLOSURE.txt']]);
  });

  test('the disclosure is dropped when the agent SAID it — and not before', async () => {
    const r = rig();
    r.human();
    await r.call.configurator.idle();
    r.session.agentTurn('Hello, I am calling about a prior authorization.');
    await r.call.configurator.idle();
    assert.equal(r.call.loop.disclosure.disclosedToCurrentParty, false, 'no disclosure phrase, no disclosure');
    r.session.agentTurn("Hi, I'm an AI assistant calling on behalf of Clinic.");
    await r.call.configurator.idle();
    assert.equal(r.call.loop.disclosure.disclosedToCurrentParty, true);
    const last = r.log.events().filter((e) => e.t === 'prompt.loaded').at(-1)!;
    assert.ok(last.t === 'prompt.loaded' && last.files.join() === 'EXCHANGE.txt');
  });

  test('back from a hold long enough for a person to change: the party hedge', async () => {
    const r = rig();
    r.human();
    r.session.agentTurn("Hi, I'm an AI assistant calling on behalf of Clinic.");
    r.session.farEndSays('one moment please');
    r.clock.advance(HOLD_CONFIRM_MS);
    assert.equal(r.call.loop.gate.channel, 'HOLD');
    await r.call.configurator.idle();
    assert.deepEqual(toolsOf(r.session.config), [], 'no tools on hold');

    r.clock.advance(PARTY_CONTINUITY_MS * 4);
    r.session.farEndSays(HUMAN_LINES[0]!);
    r.session.farEndSays(HUMAN_LINES[1]!);
    await r.call.configurator.idle();
    assert.equal(r.call.loop.gate.channel, 'HUMAN');
    const last = r.log.events().filter((e) => e.t === 'prompt.loaded').at(-1)!;
    assert.ok(last.t === 'prompt.loaded' && last.hedged, 'a different person may have come back');
    assert.ok(r.call.loop.lastHoldSegmentMs >= PARTY_CONTINUITY_MS * 4, 'measured from suspicion, not from the channel change');
  });

  test('stop() lets go of the log — a call that has ended holds no subscription', () => {
    const tp = fakeTransport();
    const clock = manualTime();
    const log = createEventLog({ callId: 'CALL-S' });
    const real = log.subscribe.bind(log);
    let live = 0;
    log.subscribe = (h) => {
      live++;
      const off = real(h);
      return () => { live--; off(); };
    };
    const call = startCall({
      request, queue: createWorkQueue({ requests: [{ ...request }] }), log, transport: tp.t, navMode: 'dtmf', networkProfile: 'TELEPHONY',
      createSession: (guard) => new FakeSession(guard),
      nowMs: clock.now, timers: clock.timers, bridge: { now: clock.now, scheduler: clock.scheduler },
    });
    assert.ok(live > 0, 'the call reads its own log');
    call.stop();
    assert.equal(live, 0, 'a work queue running many calls would otherwise keep every one of them alive');
  });

  test('stop() ends the configuration with everything else', async () => {
    const r = rig();
    r.call.stop();
    r.call.loop.gate.setChannel('HUMAN', { kind: 'transport', cause: 'test' });
    await r.call.configurator.idle();
    assert.equal(r.session.updates.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Step 4: the model's tool calls reach the handlers, and their effects land
// ---------------------------------------------------------------------------

/** Dial, and let a representative answer — no channel set by hand. */
async function atHuman(over: Partial<AuthRequest> = {}) {
  const r = rig(over);
  await r.call.loop.dial('ws://payer', PROFILES.TELEPHONY);
  r.session.farEndSays(HUMAN_LINES[0]!);
  r.session.farEndSays(HUMAN_LINES[1]!);
  assert.equal(r.call.loop.gate.channel, 'HUMAN');
  return r;
}

const GOOD_SUMMARY = 'Routine. Gave member ID and date of birth. They asked for the operative note. Clinical staff need to fax it and call back.';

describe('tools reach the call (§8, module 4.0 step 4)', () => {
  test('send_dtmf in the menu: tones go out through the bridge, and the model is told', async () => {
    const r = rig();
    await r.call.loop.dial('ws://payer', PROFILES.TELEPHONY);
    const res = r.session.callsTool('send_dtmf', { digits: '2', reason: 'prior authorization' });
    assert.equal(res.isError, false);
    assert.ok(r.kinds().includes('dtmf.sent'));
    r.clock.advance(2_000);
    assert.ok(r.tp.sent.some((s) => s.source === 'dtmf'), 'the tones reached the transport, through a dtmf_only gate');
  });

  test('a tool the position forbids is refused with a reason the model can act on — and nothing happens', async () => {
    const r = rig();
    await r.call.loop.dial('ws://payer', PROFILES.TELEPHONY);
    const res = r.session.callsTool('capture_auth_number', { value: 'A472-91' });
    assert.equal(res.isError, true);
    assert.match(JSON.stringify(res.result), /not available right now/);
    assert.equal(r.call.loop.phase.state.phase, 'NOT_STARTED');
    assert.ok(r.kinds().includes('tool.rejected'));
  });

  test('the whole exchange: capture → READBACK → confirmed → CLOSING, and the session follows each step', async () => {
    const r = await atHuman();
    r.session.farEndSays('the authorization number is A472-91');
    assert.equal(r.session.callsTool('capture_auth_number', { value: 'A472-91' }).isError, false);
    assert.equal(r.call.loop.phase.state.phase, 'READBACK');
    await r.call.configurator.idle();
    assert.ok(toolsOf(r.session.config).includes('confirm_readback'));
    assert.ok(r.session.config.systemPrompt?.includes('A472-91'), 'READBACK.txt carries the captured number');
    assert.equal(r.kinds().includes('auth_number.suspect'), false, 'it was said, so it is not suspect (§8.2)');

    r.session.callsTool('confirm_readback', { matched: true });
    assert.equal(r.call.loop.phase.state.phase, 'CLOSING');
    assert.equal(r.call.loop.phase.state.closingKind, 'wrapup');
    await r.call.configurator.idle();
    assert.ok(toolsOf(r.session.config).includes('record_outcome'));

    const out = r.session.callsTool('record_outcome', { status: 'approved', auth_number: 'A472-91' });
    assert.equal(out.isError, false);
    assert.equal(r.queue.get('R1')!.status, 'approved');
    assert.equal(r.call.loop.phase.state.outcomeWritten, true);
    assert.equal(r.call.loop.phase.state.phase, 'CLOSING', 'recording the outcome does not end the call (ADR-015)');
  });

  test('every transition a tool produces names its tool.called by seq (§3.3 rule 4)', async () => {
    const r = await atHuman();
    r.session.agentTurn("Hi, I'm an AI assistant calling on behalf of Clinic.");
    r.session.farEndSays('the authorization number is A472-91');
    r.session.callsTool('capture_auth_number', { value: 'A472-91' });
    r.session.callsTool('notify_transfer', { destination: 'utilization management' });
    const ev = r.log.events();
    const toolCalled = (name: string) => ev.find((e) => e.t === 'tool.called' && e.name === name)!;
    const ph = ev.find((e) => e.t === 'phase.changed' && e.to === 'READBACK')!;
    assert.ok(ph.t === 'phase.changed' && ph.producer.kind === 'tool');
    assert.equal(ph.producer.kind === 'tool' && ph.producer.seq, toolCalled('capture_auth_number').seq);
    const ch = ev.find((e) => e.t === 'channel.changed' && e.to === 'TRANSFER')!;
    assert.equal(ch.t === 'channel.changed' && ch.producer.kind === 'tool' && ch.producer.seq, toolCalled('notify_transfer').seq);
    const gate = ev.find((e) => e.t === 'gate.changed' && e.producer.kind === 'tool')!;
    assert.equal(gate.t === 'gate.changed' && gate.producer.kind === 'tool' && gate.producer.seq, toolCalled('notify_transfer').seq,
      'the gate closed on the ANNOUNCEMENT, and says which one (ADR-019)');
  });

  test('a captured number the far end never said is flagged for review, not refused (§8.2)', async () => {
    const r = await atHuman();
    assert.equal(r.session.callsTool('capture_auth_number', { value: 'Z999-00' }).isError, false);
    assert.ok(r.kinds().includes('auth_number.suspect'));
    assert.equal(r.call.loop.phase.state.phase, 'READBACK');
  });

  test('an outcome carrying a different number than the one captured: refused AND a safety violation, same id', async () => {
    const r = await atHuman();
    r.session.farEndSays('it is A472-91');
    r.session.callsTool('capture_auth_number', { value: 'A472-91' });
    r.session.callsTool('confirm_readback', { matched: true });
    const res = r.session.callsTool('record_outcome', { status: 'approved', auth_number: 'A472-19' }, 'bad-1');
    assert.equal(res.isError, true);
    const v = r.log.events().find((e) => e.t === 'safety.violation');
    assert.ok(v && v.t === 'safety.violation' && v.kind === 'auth_number_mismatch' && v.toolCallId === 'bad-1');
    assert.equal(r.queue.get('R1')!.status, 'in_progress', 'nothing was written');
  });

  test('capture_reference outlives the call: it lands on the request (A-16)', async () => {
    const r = await atHuman();
    r.session.callsTool('capture_reference', { reference: 'CR-2231', kind: 'call_reference' });
    assert.equal(r.req.lastReference, 'CR-2231');
  });

  test('notify_transfer: gate shut on the announcement, channel TRANSFER, ONE new party', async () => {
    const r = await atHuman();
    r.session.agentTurn("Hi, I'm an AI assistant calling on behalf of Clinic.");
    r.session.callsTool('notify_transfer', { destination: 'utilization management' });
    assert.equal(r.call.loop.gate.channel, 'TRANSFER');
    assert.equal(r.tp.intent, 'closed');
    const suspected = r.log.events().find((e) => e.t === 'hold.suspected');
    assert.ok(suspected && suspected.t === 'hold.suspected' && suspected.trigger === 'notify_transfer', 'ADR-019');
    assert.equal(r.log.events().filter((e) => e.t === 'party.changed').length, 1, 'told twice, the tracker counts a phantom party');
    assert.equal(r.call.loop.disclosure.partiesDetected, 2);
    assert.equal(r.call.loop.disclosure.disclosedToCurrentParty, false);
  });
});

describe('escalation reaches a summary on every path (§8.6, INV-9)', () => {
  const summaries = (r: ReturnType<typeof rig>) => r.log.events().filter((e) => e.t === 'escalation.summary');

  test('the model escalates with a usable summary: CLOSING, and the model summary is kept', async () => {
    const r = await atHuman();
    r.session.callsTool('escalate_to_human', { reason: 'clinical question', context_summary: GOOD_SUMMARY });
    assert.equal(r.call.loop.phase.state.phase, 'CLOSING');
    assert.equal(r.call.loop.phase.state.closingKind, 'escalation');
    const s = summaries(r);
    assert.equal(s.length, 1);
    assert.ok(s[0]!.t === 'escalation.summary' && s[0]!.source === 'model');
    assert.equal(r.session.replyRequests.length, 0, 'nobody asked the model to write what it had just written');
  });

  const failReadbackThrice = (r: ReturnType<typeof rig>) => {
    for (let i = 0; i < 3; i++) {
      if (r.call.loop.phase.state.phase === 'EXCHANGE') r.session.callsTool('capture_auth_number', { value: `A472-9${i}` });
      r.session.callsTool('confirm_readback', { matched: false, corrected_value: `A47${i}-91` });
    }
    assert.equal(r.call.loop.phase.state.closingKind, 'escalation');
  };

  test('three failed read-backs: tier 1 waits for the reply CARRYING the tool call to end, then asks', async () => {
    // Asked inside that reply, the session would refuse (a reply is active)
    // and tier 2 would write every summary — tier 1 would never run at all.
    const r = await atHuman();
    failReadbackThrice(r);
    assert.equal(r.session.replyRequests.length, 0, 'not while the model is still mid-reply');
    r.session.replyDone('completed');
    assert.equal(r.session.replyRequests.length, 1);
    assert.equal(r.session.replyRequests[0]!.cause, 'escalation_instruction');
    assert.equal(summaries(r).length, 0, 'that reply.done was not the turn tier 2 waits for');
    r.session.replyDone('completed');
    const s = summaries(r);
    assert.equal(s.length, 1, 'a whole turn with no summary: tier 2 writes it');
    assert.ok(s[0]!.t === 'escalation.summary' && s[0]!.source === 'deterministic');
  });

  test('…and the model answering tier 1 with a usable summary ends the procedure', async () => {
    const r = await atHuman();
    failReadbackThrice(r);
    r.session.replyDone('completed');
    r.session.callsTool('escalate_to_human', { reason: 'read-back failed', context_summary: GOOD_SUMMARY });
    r.session.replyDone('completed');
    const s = summaries(r);
    assert.equal(s.length, 1);
    assert.ok(s[0]!.t === 'escalation.summary' && s[0]!.source === 'model');
  });

  test('an escalation begun OUTSIDE a tool call asks at once — a timer is not inside anyone s reply', async () => {
    // The read-back re-prompt limit (§5.7) is a silence timer: no reply is
    // active when it fires, so there is nothing to wait for.
    const r = await atHuman();
    r.session.farEndSays('the number is A472-91');
    r.session.callsTool('capture_auth_number', { value: 'A472-91' }); // a tool call came and went
    r.call.loop.phase.onRecoveryLimit();
    assert.equal(r.call.loop.phase.state.closingKind, 'escalation');
    assert.equal(r.session.replyRequests.length, 1, 'asked now, not held for a reply.done that is not coming');
  });

  test('an interrupted reply is not the turn tier 2 waits for', async () => {
    const r = await atHuman();
    failReadbackThrice(r);
    r.session.replyDone('completed'); // asks
    r.session.replyDone('interrupted');
    assert.equal(summaries(r).length, 0, 'the model did not get to finish');
    r.session.replyDone('completed');
    assert.equal(summaries(r).length, 1);
  });

  test('tier 1 refused by the session: tier 2 at once, not after a turn that will never come', async () => {
    const r = await atHuman();
    r.session.refuseReplies = true;
    failReadbackThrice(r);
    r.session.replyDone('completed');
    await new Promise((res) => setImmediate(res));
    assert.equal(summaries(r).length, 1);
  });

  test('the gate shut when the escalation begins: tier 2 at once, and the model is never asked', async () => {
    const r = await atHuman();
    r.session.farEndSays('the number is A472-90');
    r.session.farEndSays('one moment please'); // suspected: the gate closes
    assert.equal(r.tp.intent, 'closed');
    failReadbackThrice(r);
    assert.equal(summaries(r).length, 1);
    assert.equal(r.session.replyRequests.length, 0);
  });

  test('the gate shut between the tool call and its reply ending: tier 2, never asked', async () => {
    const r = await atHuman();
    failReadbackThrice(r);
    r.session.farEndSays('one moment please');
    r.session.replyDone('completed');
    assert.equal(r.session.replyRequests.length, 0, 'a reply requested now would be refused, or worse, spoken on hold');
    assert.equal(summaries(r).length, 1);
  });

  test('the phase timeout, on HUMAN time: escalated with a deterministic summary, the model never asked', async () => {
    const r = await atHuman();
    r.clock.advance(480_000);
    assert.equal(r.call.loop.phase.state.phase, 'CLOSING');
    assert.equal(r.call.loop.phase.state.closingKind, 'escalation');
    const s = summaries(r);
    assert.ok(s.length === 1 && s[0]!.t === 'escalation.summary' && s[0]!.source === 'deterministic');
    assert.equal(r.session.replyRequests.length, 0, '§8.6: a timeout never asks the model');
  });

  test('…and a hold spends none of that budget', async () => {
    const r = await atHuman();
    r.clock.advance(400_000);
    r.session.farEndSays('one moment please');
    r.clock.advance(HOLD_CONFIRM_MS);
    assert.equal(r.call.loop.gate.channel, 'HOLD');
    r.clock.advance(300_000);
    r.session.farEndSays(HUMAN_LINES[0]!);
    r.session.farEndSays(HUMAN_LINES[1]!);
    assert.equal(r.call.loop.gate.channel, 'HUMAN');
    r.clock.advance(70_000);
    assert.equal(r.call.loop.phase.state.phase, 'EXCHANGE', '400 + 3 + 70 s of HUMAN time is under 480');
    r.clock.advance(10_000);
    assert.equal(r.call.loop.phase.state.phase, 'CLOSING');
  });
});

describe('tools after stop()', () => {
  test('a tool call on a stopped call gets no result and moves nothing', async () => {
    const r = await atHuman();
    r.call.stop();
    r.session.callsTool('capture_auth_number', { value: 'A472-91' }, 'late');
    assert.equal(r.session.results.length, 0);
    assert.equal(r.call.loop.phase.state.phase, 'EXCHANGE');
  });
});

// ---------------------------------------------------------------------------
// Step 5: the closing, DONE, the hangup, and the outcome when the line closes
// ---------------------------------------------------------------------------

/** HUMAN → number captured and confirmed: the call is in CLOSING/wrapup. */
async function atClosing() {
  const r = await atHuman();
  r.session.agentTurn("Hi, I'm an AI assistant calling on behalf of Clinic.");
  r.session.farEndSays('the authorization number is A472-91');
  r.session.callsTool('capture_auth_number', { value: 'A472-91' });
  r.session.callsTool('confirm_readback', { matched: true });
  assert.equal(r.call.loop.phase.state.phase, 'CLOSING');
  await r.call.configurator.idle();
  return r;
}

/** The model's record_outcome reply: it starts, calls the tool, and ends. */
function recordsOutcome(r: Awaited<ReturnType<typeof atClosing>>, text = 'Let me record that.') {
  r.session.replies(speech(5));
  r.session.agentTurn(text);
  const res = r.session.callsTool('record_outcome', { status: 'approved', auth_number: 'A472-91' });
  r.session.replyDone('completed');
  return res;
}

const invariantsOf = (r: ReturnType<typeof rig>) =>
  // One representative throughout: the harness's ground truth for INV-7 (ADR-018).
  checkInvariants({ call: r.call.loop.snapshot(), request: r.req, log: r.log.events(), harnessParties: 1 }, 'all');

describe('the closing detector (§7.6), as built', () => {
  test('the reply that CALLS record_outcome is not closing; the reply after it is', async () => {
    const r = await atClosing();
    recordsOutcome(r);
    r.session.speaks('Thank you so much, have a good day.');
    const agent = r.log.events().filter((e) => e.t === 'turn.transcribed' && e.speaker === 'agent');
    const byText = (t: string) => agent.find((e) => e.t === 'turn.transcribed' && e.text === t);
    const recording = byText('Let me record that.')!;
    assert.ok(recording.t === 'turn.transcribed' && !recording.isClosing, 'started before the marker');
    const bye = byText('Thank you so much, have a good day.')!;
    assert.ok(bye.t === 'turn.transcribed' && bye.isClosing, 'past [[CLOSING]]');
  });

  test('a REJECTED record_outcome does not pass the marker: what the model says next is not a closing', async () => {
    const r = await atClosing();
    r.session.replies(speech(5));
    const res = r.session.callsTool('record_outcome', { status: 'approved' }); // no auth_number: refused
    r.session.replyDone('completed');
    assert.equal(res.isError, true);
    r.session.speaks('Sorry, let me try that again.');
    const last = r.log.events().filter((e) => e.t === 'turn.transcribed' && e.speaker === 'agent').at(-1)!;
    assert.ok(last.t === 'turn.transcribed' && !last.isClosing);
    assert.equal(r.call.loop.phase.state.phase, 'CLOSING');
  });

  test('nothing before CLOSING is ever marked closing', async () => {
    const r = await atHuman();
    r.session.speaks('Hi, I am calling about a prior authorization.');
    const t = r.log.events().filter((e) => e.t === 'turn.transcribed' && e.speaker === 'agent');
    assert.ok(t.every((e) => e.t === 'turn.transcribed' && !e.isClosing));
  });
});

describe('DONE, then the hangup — after the goodbye is heard (§5.4, ADR-015)', () => {
  test('the whole call: outcome, goodbye, DONE, hangup, CLOSED, call.ended — and no invariant violated', async () => {
    const r = await atClosing();
    recordsOutcome(r);
    assert.equal(r.call.loop.phase.state.phase, 'CLOSING', 'recording is not the end (ADR-015)');
    r.session.speaks('Thank you so much, have a good day.', 50);
    assert.equal(r.call.loop.phase.state.phase, 'DONE');
    assert.equal(r.tp.hangups, 0, 'not while the goodbye is still queued in the bridge');
    r.clock.advance(1_200);
    assert.equal(r.tp.hangups, 1);
    assert.equal(r.call.loop.gate.channel, 'CLOSED');
    const end = await r.call.finished;
    assert.deepEqual(end, { dropped: null, outcome: { status: 'approved', authNumber: 'A472-91' } });
    const ended = r.log.events().filter((e) => e.t === 'call.ended');
    assert.deepEqual(ended.map((e) => e.t === 'call.ended' && e.outcome), [{ status: 'approved', authNumber: 'A472-91' }], 'in the log, once');
    assert.ok(r.session.ended, 'session.end, never a bare close (§15)');
    assert.equal(r.kinds().includes('call.dropped'), false, 'we hung up: nothing dropped');
    assert.deepEqual(invariantsOf(r), []);
  });

  test('the end-to-end check has teeth: the same call with no disclosure spoken fails INV-7', async () => {
    const r = await atHuman(); // never says it is an AI assistant
    r.session.farEndSays('the authorization number is A472-91');
    r.session.callsTool('capture_auth_number', { value: 'A472-91' });
    r.session.callsTool('confirm_readback', { matched: true });
    await r.call.configurator.idle();
    recordsOutcome(r);
    r.session.speaks('Thank you, goodbye.');
    r.clock.advance(1_000);
    await r.call.finished;
    assert.deepEqual(invariantsOf(r).map((v) => v.id), ['INV-7']);
  });

  test('an interrupted goodbye is not a closing delivered: no DONE until one completes', async () => {
    const r = await atClosing();
    recordsOutcome(r);
    r.session.speaks('Thank you so—', 5, 'interrupted');
    assert.equal(r.call.loop.phase.state.phase, 'CLOSING');
    r.session.speaks('Of course. Thank you, goodbye.');
    assert.equal(r.call.loop.phase.state.phase, 'DONE');
  });

  test('the far end never confirms playout: the hangup still happens, bounded', async () => {
    const r = await atClosing();
    r.tp.silenceMarks();
    recordsOutcome(r);
    r.session.speaks('Thank you, goodbye.', 5);
    r.clock.advance(500);
    assert.deepEqual(r.tp.marks, ['closing-played']);
    assert.equal(r.tp.hangups, 0, 'waiting for the far end');
    r.clock.advance(PLAYOUT_MARK_TIMEOUT_MS);
    assert.equal(r.tp.hangups, 1);
  });

  test('the escalation closing ends the same way, with the outcome escalated', async () => {
    const r = await atHuman();
    r.session.agentTurn("Hi, I'm an AI assistant calling on behalf of Clinic.");
    r.session.replies(speech(5));
    r.session.callsTool('escalate_to_human', { reason: 'clinical', context_summary: GOOD_SUMMARY });
    r.session.replyDone('completed');
    await r.call.configurator.idle();
    r.session.replies(speech(5));
    r.session.callsTool('record_outcome', { status: 'escalated', notes: 'clinical question' });
    r.session.replyDone('completed');
    r.session.speaks('Our clinical staff will call you back. Thank you, goodbye.');
    assert.equal(r.call.loop.phase.state.phase, 'DONE');
    r.clock.advance(1_000);
    const end = await r.call.finished;
    assert.equal(end.outcome?.status, 'escalated');
    assert.deepEqual(invariantsOf(r), []);
  });
});

describe('the line closing without a finished call (INV-18, INV-19)', () => {
  test('the far end hangs up mid-exchange: dropped, nothing written, the request stays open for redial', async () => {
    const r = await atHuman();
    r.tp.close('far_end_hangup');
    const end = await r.call.finished;
    assert.deepEqual(end, { dropped: 'far_end_hangup', outcome: null });
    const dropped = r.log.events().filter((e) => e.t === 'call.dropped');
    assert.deepEqual(dropped.map((e) => e.t === 'call.dropped' && e.cause), ['far_end_hangup'], 'in the LOG, where INV-19 looks');
    assert.equal(r.queue.get('R1')!.status, 'in_progress');
    assert.equal(r.kinds().includes('call.ended'), false, 'no final status, so no call.ended');
    assert.ok(r.session.ended);
    assert.equal(r.tp.hangups, 0, 'the far end is already gone');
  });

  test('…on the last attempt, the request is failed', async () => {
    const r = rig({ attempts: 3 });
    await r.call.loop.dial('ws://payer', PROFILES.TELEPHONY);
    r.tp.close('link_drop');
    const end = await r.call.finished;
    assert.deepEqual(end, { dropped: 'link_drop', outcome: { status: 'failed' } });
  });

  test('dropped after the model escalated: escalated is written, never failed (INV-19)', async () => {
    const r = await atHuman({ attempts: 3 });
    r.session.agentTurn("Hi, I'm an AI assistant calling on behalf of Clinic.");
    r.session.callsTool('escalate_to_human', { reason: 'clinical', context_summary: GOOD_SUMMARY });
    r.tp.close('far_end_hangup');
    const end = await r.call.finished;
    assert.equal(end.outcome?.status, 'escalated');
    assert.deepEqual(invariantsOf(r), []);
  });

  test('dropped after the outcome was recorded: the outcome stands, and the call still ended', async () => {
    const r = await atClosing();
    recordsOutcome(r);
    r.tp.close('far_end_hangup');
    const end = await r.call.finished;
    assert.deepEqual(end, { dropped: 'far_end_hangup', outcome: { status: 'approved', authNumber: 'A472-91' } });
    assert.equal(r.log.events().filter((e) => e.t === 'outcome.written' && !e.skipped).length, 1, 'written once');
    assert.equal(r.log.events().some((e) => e.t === 'outcome.written' && e.writer === 'call_model'), false,
      'the Call Model does not even attempt a write the call already made — a skipped entry is noise in an audit trail');
  });

  test('a hold nobody ends: HOLD_TIMEOUT_MS closes the call — and hangs up the line the timer closed', async () => {
    const r = await atHuman();
    r.session.farEndSays('one moment please');
    r.clock.advance(HOLD_CONFIRM_MS);
    assert.equal(r.call.loop.gate.channel, 'HOLD');
    r.clock.advance(HOLD_TIMEOUT_MS);
    const end = await r.call.finished;
    assert.equal(end.dropped, 'timeout');
    assert.equal(r.tp.hangups, 1, 'the far end is still there; the line must be put down');
  });

  test('the close is written AFTER its atomic phase follow-up, not in the middle of it', async () => {
    const r = await atHuman();
    r.tp.close('far_end_hangup');
    await r.call.finished;
    const k = r.kinds();
    const at = k.lastIndexOf('channel.changed');
    assert.equal(k[at + 1], 'phase.changed', 'CLOSED → DONE sits next to the channel change (§5.3)');
  });

  test('after the call has finished, it is stopped: nothing it hears moves anything', async () => {
    const r = await atHuman();
    r.tp.close('far_end_hangup');
    await r.call.finished;
    const before = r.log.length;
    r.session.farEndSays('hello? are you there?');
    r.session.callsTool('capture_auth_number', { value: 'A472-91' }, 'late');
    assert.equal(r.log.length, before);
  });
});

describe('dropCauseOf', () => {
  test('every producer that can close a call maps to a §9.3 DropCause', () => {
    assert.equal(dropCauseOf({ kind: 'transport', cause: 'far_end_hangup' }), 'far_end_hangup');
    assert.equal(dropCauseOf({ kind: 'transport', cause: 'timeout' }), 'timeout');
    assert.equal(dropCauseOf({ kind: 'transport', cause: 'link_drop' }), 'link_drop');
    assert.equal(dropCauseOf({ kind: 'transport', cause: 'link_refused: ECONNREFUSED' }), 'link_drop');
    assert.equal(dropCauseOf({ kind: 'timer', name: 'HOLD_TIMEOUT_MS' }), 'timeout');
    assert.equal(dropCauseOf({ kind: 'timer', name: 'TRANSFER_TIMEOUT_MS' }), 'timeout');
    assert.equal(dropCauseOf({ kind: 'timer', name: 'REPROMPT_LIMIT' }), 'unresponsive');
  });
});
