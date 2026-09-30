/**
 * The Audio Bridge — §4, ADR-007, ADR-008. Scheduled for week 2, built in 4.0.
 *
 * Two claims matter and each has a test that could fail:
 *
 *   PACING. Without it, a reply arriving faster than real time overflows the far
 *   end's 200 ms playout queue and the far end hears only the tail. The last
 *   test here shows both halves on the real loopback transport: the same burst
 *   sent unpaced overflows, sent through the bridge does not.
 *
 *   THE GATE, AT THIS LAYER. The burst now waits here, so ADR-007's "seconds of
 *   speech already queued when the gate closes" sit in this buffer. Narrowing
 *   must flush it before the transport is told, and audio arriving while the
 *   gate forbids it must never be buffered — or it plays when the gate reopens.
 */

import { test, describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { BYTES_PER_FRAME, FRAME_MS } from '@holdharmless/audio';
import type { GateIntent } from '@holdharmless/events';
import { PROFILES, gateAdmits, raiseTimerResolution, type AudioSource, type CallTransport } from '@holdharmless/transport';
import { LoopbackEndpoint, LoopbackTransport, type FarEndSession } from '@holdharmless/transport-loopback';
import { createAudioBridge, type BridgeScheduler } from '../src/index.js';

/** A transport that records, and enforces the gate exactly as the real one does. */
function fakeTransport(initial: GateIntent = 'open') {
  let intent: GateIntent = initial;
  const log: string[] = [];
  const sent: AudioSource[] = [];
  const frames: Uint8Array[] = [];
  let clears = 0;
  /** Set by the test: what the bridge still held at the moment applyGate arrived. */
  let pendingAtApply: (() => number) | null = null;
  const seen: number[] = [];
  const t: CallTransport = {
    kind: 'loopback',
    dial: async () => {},
    sendAudio(_f, source) {
      if (!gateAdmits(intent, source)) return false;
      sent.push(source);
      frames.push(_f);
      return true;
    },
    clear: async () => { clears++; log.push('clear'); return []; },
    mark: async () => {},
    applyGate(next) {
      if (pendingAtApply) seen.push(pendingAtApply());
      log.push(`gate:${next}`);
      intent = next;
    },
    gate: () => intent,
    hangup: async () => {},
    onAudio() {},
    onMark() {},
    onFault() {},
    onClosed() {},
  };
  return {
    t, log, sent, seen, frames,
    get clears() { return clears; },
    watch(fn: () => number) { pendingAtApply = fn; },
  };
}

/** Time under the test's control: nothing is paced unless the test says so. */
function manualTime() {
  let now = 0;
  let fn: (() => void) | null = null;
  const scheduler: BridgeScheduler = {
    every(f) { fn = f; return () => { if (fn === f) fn = null; }; },
  };
  return {
    now: () => now,
    scheduler,
    advance(ms: number) { now += ms; fn?.(); },
    get running() { return fn !== null; },
  };
}

const speech = (frames: number) => new Uint8Array(frames * BYTES_PER_FRAME).fill(0x30);

describe('pacing (§4: "a 200 ms queue only works if the sender is paced")', () => {
  test('a burst is held here and released at the frame cadence', () => {
    const tp = fakeTransport();
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    b.pushAgentAudio(speech(50)); // one second, delivered at once
    assert.equal(tp.sent.length, 1, 'the first frame goes immediately, and only the first');
    clock.advance(200);
    assert.equal(tp.sent.length, 11, '200 ms later, ten more');
    clock.advance(800);
    assert.equal(tp.sent.length, 50, 'and the rest over the following 800 ms');
    assert.equal(b.pending(), 0);
  });

  test('a late timer sends what is due rather than stretching the audio', () => {
    // Paced by the elapsed clock, not by counting ticks (§4.5).
    const tp = fakeTransport();
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    b.pushAgentAudio(speech(20));
    clock.advance(300); // one tick, arriving 300 ms late
    assert.equal(tp.sent.length, 16);
  });

  test('the timer stops when there is nothing left, so an idle call costs nothing', () => {
    const tp = fakeTransport();
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    b.pushAgentAudio(speech(3));
    clock.advance(100);
    assert.equal(b.pending(), 0);
    assert.equal(clock.running, false);
  });

  test('bytes are re-framed across chunks, and the last partial frame is padded, not held', () => {
    const tp = fakeTransport();
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    b.pushAgentAudio(new Uint8Array(250).fill(0x30)); // one frame and 90 bytes
    b.pushAgentAudio(new Uint8Array(100).fill(0x30)); // 190 bytes: one more frame, 30 left
    clock.advance(100);
    assert.equal(tp.sent.length, 2);
    b.finishReply();
    clock.advance(100);
    assert.equal(tp.sent.length, 3, 'the last syllable is not kept waiting for bytes that never come');
  });
});

describe('the gate, at this layer (ADR-007)', () => {
  test('narrowing FLUSHES this buffer BEFORE the transport hears of it', () => {
    const tp = fakeTransport();
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    tp.watch(() => b.pending('agent'));
    b.pushAgentAudio(speech(100)); // two seconds queued here
    b.applyGate('closed');
    assert.deepEqual(tp.seen, [0], 'nothing agent-sourced was left when the transport was told');
    assert.ok(b.counts.flushed >= 99);
    clock.advance(2000);
    assert.equal(tp.sent.length, 1, 'only the frame that left before the gate closed');
  });

  test('audio arriving while the gate is shut is dropped — and does NOT play when it reopens', () => {
    // The hazard ADR-007 names, one layer up: the model keeps generating while
    // it is muted, and buffering that would play it the instant the gate opened.
    const tp = fakeTransport('closed');
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    b.pushAgentAudio(speech(40));
    assert.equal(b.pending(), 0);
    assert.equal(b.counts.droppedOnArrival, 40);
    b.applyGate('open');
    clock.advance(1000);
    assert.equal(tp.sent.length, 0, 'nothing generated during the mute reached the far end');
  });

  test('dtmf_only keeps the tones and drops the speech — what navigating a menu needs', () => {
    const tp = fakeTransport();
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    void b.sendDtmf('3');
    b.pushAgentAudio(speech(20));
    const tones = b.pending('dtmf');
    b.applyGate('dtmf_only');
    assert.equal(b.pending('agent'), 0);
    assert.equal(b.pending('dtmf'), tones, 'every queued tone frame survived');
  });

  test('a tone requested while the gate is ALREADY shut is dropped, not saved for later', async () => {
    // The enqueue check is the only thing standing between a tone and a closed
    // gate — speech has a second check on arrival, tones do not. Without it the
    // tone would wait here and play into the hold the moment the gate reopened.
    const tp = fakeTransport('closed');
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    await b.sendDtmf('9');
    assert.equal(b.pending(), 0);
    b.applyGate('dtmf_only');
    clock.advance(2000);
    assert.equal(tp.sent.length, 0, 'the tone did not play into what came after');
  });

  test('not even a fragment of speech from during the mute survives into the next reply', () => {
    // Speech arrives in chunks that do not align to frames, and the remainder is
    // carried to the next chunk. If the remainder of a chunk that arrived DURING
    // the mute were kept, it would be glued to the front of the first reply
    // after the gate reopened: at most 159 bytes, 20 ms — and still audio
    // generated while the agent was supposed to be silent.
    const tp = fakeTransport('closed');
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    b.pushAgentAudio(new Uint8Array(90).fill(0x31)); // arrives while muted
    b.applyGate('open');
    b.pushAgentAudio(new Uint8Array(70).fill(0x30));
    b.finishReply();
    clock.advance(200);
    assert.ok(tp.frames.length > 0, 'the new reply was sent');
    assert.ok(tp.frames.every((f) => !f.includes(0x31)), 'a byte from the muted stretch reached the far end');
  });

  test('closed drops the tones too', () => {
    const tp = fakeTransport();
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    void b.sendDtmf('123');
    b.applyGate('closed');
    assert.equal(b.pending(), 0);
  });

  test('widening the gate flushes nothing', () => {
    const tp = fakeTransport('dtmf_only');
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    void b.sendDtmf('12');
    const before = b.pending();
    b.applyGate('open');
    assert.equal(b.pending(), before);
  });
});

describe('interruption (§3: the other two clear triggers)', () => {
  test('drops queued speech and clears the far end, but leaves tones alone', async () => {
    const tp = fakeTransport();
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    b.pushAgentAudio(speech(50));
    await b.interrupt();
    assert.equal(b.pending('agent'), 0);
    assert.equal(tp.clears, 1, 'the far end was told as well — its 200 ms queue is not ours to leave full');
  });
});

describe('DTMF injection', () => {
  test('tones are paced like speech and the promise resolves when the last one has left', async () => {
    const tp = fakeTransport('dtmf_only');
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    let done = false;
    const sending = b.sendDtmf('37').then(() => { done = true; });
    assert.equal(tp.sent.length, 1, 'paced: one frame now');
    await Promise.resolve();
    assert.equal(done, false);
    clock.advance(2000);
    await sending;
    assert.ok(tp.sent.every((s) => s === 'dtmf'));
  });

  test('a tone flushed by a closing gate still resolves — nobody waits forever on it', async () => {
    const tp = fakeTransport();
    const clock = manualTime();
    const b = createAudioBridge({ transport: tp.t, now: clock.now, scheduler: clock.scheduler });
    const sending = b.sendDtmf('5');
    b.applyGate('closed');
    await sending;
  });
});

describe('over the real loopback transport', () => {
  raiseTimerResolution();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function pair(t: TestContext) {
    const endpoint = await LoopbackEndpoint.listen({ port: 0, profile: PROFILES.TELEPHONY, autoDrain: true });
    const ready = new Promise<FarEndSession>((resolve) => endpoint.onSession(resolve));
    const transport = new LoopbackTransport();
    await transport.dial(endpoint.url(), PROFILES.TELEPHONY);
    const far = await ready;
    t.after(async () => {
      await transport.hangup().catch(() => undefined);
      await endpoint.close();
    });
    transport.applyGate('open');
    return { transport, far };
  }

  test('WITHOUT the bridge, a one-second burst overflows the far end: it hears only the tail', async (t) => {
    // The problem §4 describes, reproduced, so the next test means something.
    const { transport, far } = await pair(t);
    for (let i = 0; i < 50; i++) transport.sendAudio(new Uint8Array(BYTES_PER_FRAME).fill(0x30), 'agent');
    await sleep(1500);
    assert.ok(far.playout.overflowCount() > 0, 'the far end dropped audio');
  });

  test('WITH the bridge, the same burst is heard whole', async (t) => {
    const { transport, far } = await pair(t);
    let heard = 0;
    far.onPlayed(() => { heard++; });
    const b = createAudioBridge({ transport });
    b.pushAgentAudio(speech(50));
    await sleep(50 * FRAME_MS + 800);
    assert.equal(far.playout.overflowCount(), 0, 'nothing was dropped at the far end');
    assert.equal(heard, 50, 'every frame was played');
    b.stop();
  });
});
