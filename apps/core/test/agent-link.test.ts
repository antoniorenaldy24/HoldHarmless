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
import type { ReplyGuardState, SessionConfig } from '@holdharmless/agent';
import { HOLD_CONFIRM_MS, PARTY_CONTINUITY_MS, type ChannelTimers } from '@holdharmless/callmodel';
import type { AuthRequest, GateIntent } from '@holdharmless/events';
import { PROFILES, gateAdmits, type AudioSource, type CallTransport } from '@holdharmless/transport';
import { createEventLog, startCall, type AgentMedia, type BridgeScheduler } from '../src/index.js';

const request: AuthRequest = {
  id: 'R1', patientRef: 'p', memberId: 'm', patientDob: '1970-01-01',
  cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-01',
  payerId: 'payer', payerEndpoint: 'ws://x', clinicName: 'Clinic', clinicCallbackPhone: '555',
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
  constructor(readonly guard: () => ReplyGuardState) {
    // A real session could consult its guard at any moment, including this one.
    this.guardAtConstruction = guard();
  }
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
  agentTurn(text: string, closing = false): void { for (const f of this.h.turn) f('agent', text, closing); }
  speechStarted(): void { for (const f of this.h.speech) f(); }
}

function fakeTransport() {
  let intent: GateIntent = 'closed';
  const sent: { frame: Uint8Array; source: AudioSource }[] = [];
  let clears = 0;
  let onAudio: ((f: Uint8Array) => void) | null = null;
  const t: CallTransport = {
    kind: 'loopback',
    dial: async () => {},
    sendAudio(frame, source) {
      if (!gateAdmits(intent, source)) return false;
      sent.push({ frame, source });
      return true;
    },
    clear: async () => { clears++; return []; },
    mark: async () => {},
    applyGate(next) { intent = next; },
    gate: () => intent,
    hangup: async () => {},
    onAudio(h) { onAudio = h; },
    onMark() {},
    onFault() {},
    onClosed() {},
  };
  return { t, sent, feed: (f: Uint8Array) => onAudio?.(f), get clears() { return clears; }, get intent() { return intent; } };
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

function rig() {
  const tp = fakeTransport();
  const clock = manualTime();
  const log = createEventLog({ callId: 'CALL-L' });
  let session!: FakeSession;
  const call = startCall({
    request, log, transport: tp.t, navMode: 'dtmf', networkProfile: 'TELEPHONY',
    createSession: (guard) => (session = new FakeSession(guard)),
    nowMs: clock.now,
    epochMs: () => 1_000_000 + clock.now(),
    timers: clock.timers,
    bridge: { now: clock.now, scheduler: clock.scheduler },
  });
  const human = () => call.loop.gate.setChannel('HUMAN', { kind: 'transport', cause: 'test' });
  return { tp, clock, log, call, session, human, kinds: () => log.events().map((e) => e.t) };
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
      request, log, transport: tp.t, navMode: 'dtmf', networkProfile: 'TELEPHONY',
      createSession: (guard) => new FakeSession(guard),
      nowMs: clock.now, timers: clock.timers, bridge: { now: clock.now, scheduler: clock.scheduler },
    });
    assert.equal(live, 1);
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
