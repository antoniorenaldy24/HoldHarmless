/**
 * Acceptance criteria for module 1.3 (§21 week 1):
 *   "Two endpoints exchange mu-law at 8 kHz under TELEPHONY; measured one-way
 *    delay matches the profile within 5 ms; applyGate('closed') makes sendAudio
 *    return false; clear() empties a loaded playout queue and returns one mark
 *    per discarded chunk"
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { BYTES_PER_FRAME, FRAME_MS, MULAW_SILENCE, chunkToFrames, dtmf, createGoertzelDetector } from '@holdharmless/audio';
import { PROFILES, raiseTimerResolution, measureTimerAccuracy } from '@holdharmless/transport';
import { LoopbackEndpoint, LoopbackTransport, createPlayoutQueue, type FarEndSession } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frameOf = (fill: number) => new Uint8Array(BYTES_PER_FRAME).fill(fill);

async function pair(profile = PROFILES.TELEPHONY, autoDrain = true) {
  const endpoint = await LoopbackEndpoint.listen({ port: 0, profile, autoDrain });
  const sessionReady = new Promise<FarEndSession>((resolve) => endpoint.onSession(resolve));
  const transport = new LoopbackTransport();
  await transport.dial(endpoint.url(), profile);
  const session = await sessionReady;
  return { endpoint, transport, session };
}

// The profile is only honored at 1 ms timer resolution. On Windows the default
// quantum is 15.625 ms, which turns 25 +/- 8 ms into roughly 31 +/- 1 ms and
// makes every delay assertion below a measurement of the host, not the link.
const timerResolution = raiseTimerResolution();

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});

describe('playout queue (ADR-008)', () => {
  test('drains one frame per tick and reports marks when reached', () => {
    const played: string[] = [];
    const q = createPlayoutQueue({ onMarkPlayed: (n) => played.push(n) });
    q.push(frameOf(1));
    q.mark('a');
    q.push(frameOf(2));

    assert.equal(q.tick()![0], 1);
    assert.deepEqual(played, []);
    assert.equal(q.tick()![0], 2, 'the mark is passed on the way to the next frame');
    assert.deepEqual(played, ['a']);
    assert.equal(q.tick(), null);
  });

  test('overflow drops the oldest audio and counts it', () => {
    const q = createPlayoutQueue({ depthMs: 60 });
    for (let i = 1; i <= 5; i++) q.push(frameOf(i));
    assert.equal(q.overflowCount(), 2);
    assert.equal(q.depthMs(), 60);
    assert.equal(q.tick()![0], 3);
  });

  test('clear discards everything and returns every unplayed mark', () => {
    const q = createPlayoutQueue({ depthMs: 1000 });
    for (const chunk of ['r1', 'r2', 'r3']) {
      q.push(frameOf(1));
      q.push(frameOf(2));
      q.mark(chunk);
    }
    assert.deepEqual(q.clear(), ['r1', 'r2', 'r3']);
    assert.equal(q.depthMs(), 0);
    assert.equal(q.tick(), null);
  });
});

describe('host timer resolution', () => {
  test('the host can schedule a 25 ms delay to within 3 ms', async () => {
    // A precondition for every delay figure in this file. If this fails, the
    // delay test below is measuring the operating system's scheduler.
    console.log(`      timer resolution: ${timerResolution.detail}`);
    const { meanMs, errorMs } = await measureTimerAccuracy(25, 20);
    console.log(`      setTimeout(25) actually took ${meanMs.toFixed(2)} ms`);
    assert.ok(Math.abs(errorMs) <= 3, `setTimeout(25) took ${meanMs.toFixed(2)} ms — the host clock is too coarse`);
  });
});

describe('loopback link (acceptance 1.3)', () => {
  test('two endpoints exchange mu-law at 8 kHz in both directions under TELEPHONY', async () => {
    const { endpoint, transport, session } = await pair();
    cleanups.push(() => endpoint.close());
    transport.applyGate('open');

    const atFar: Uint8Array[] = [];
    const atCore: Uint8Array[] = [];
    session.onReceived((f) => atFar.push(f));
    transport.onAudio((f) => atCore.push(f));

    for (let i = 0; i < 10; i++) {
      transport.sendAudio(frameOf(0x10 + i), 'agent');
      session.sendAudio(frameOf(0x40 + i));
    }
    await sleep(150);

    assert.equal(atFar.length, 10);
    assert.equal(atCore.length, 10);
    assert.ok(atFar.every((f) => f.length === BYTES_PER_FRAME));
    assert.deepEqual(atFar.map((f) => f[0]), Array.from({ length: 10 }, (_, i) => 0x10 + i), 'in order');
    assert.deepEqual(atCore.map((f) => f[0]), Array.from({ length: 10 }, (_, i) => 0x40 + i));
    await transport.hangup();
  });

  test('measured one-way delay matches TELEPHONY within 5 ms', async () => {
    const { endpoint, transport, session } = await pair(PROFILES.TELEPHONY, false);
    cleanups.push(() => endpoint.close());
    transport.applyGate('open');

    const arrivals: number[] = [];
    session.onReceived((_, at) => arrivals.push(at));

    const sends: number[] = [];
    const count = 100;
    for (let i = 0; i < count; i++) {
      sends.push(performance.now());
      transport.sendAudio(frameOf(i % 256), 'agent');
      await sleep(FRAME_MS);
    }
    await sleep(100);

    assert.equal(arrivals.length, count);
    const delays = arrivals.map((a, i) => a - sends[i]!);
    const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
    const sorted = [...delays].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(count / 2)]!;

    // Reported, not just asserted: this is the figure §4.2 builds on.
    console.log(
      `      TELEPHONY one-way delay: mean ${mean.toFixed(2)} ms, median ${p50.toFixed(2)} ms, ` +
        `min ${sorted[0]!.toFixed(2)}, max ${sorted[count - 1]!.toFixed(2)} (profile: 25 +/- 8 ms)`,
    );
    assert.ok(Math.abs(mean - 25) <= 5, `mean one-way delay ${mean.toFixed(2)} ms is not within 5 ms of 25 ms`);
    await transport.hangup();
  });

  test('applyGate(closed) makes sendAudio return false, for agent AND dtmf', async () => {
    const { endpoint, transport } = await pair(PROFILES.CLEAN);
    cleanups.push(() => endpoint.close());

    transport.applyGate('open');
    assert.equal(transport.sendAudio(frameOf(1), 'agent'), true);

    transport.applyGate('closed');
    assert.equal(transport.sendAudio(frameOf(1), 'agent'), false);
    assert.equal(transport.sendAudio(frameOf(1), 'dtmf'), false);

    transport.applyGate('dtmf_only');
    assert.equal(transport.sendAudio(frameOf(1), 'agent'), false);
    assert.equal(transport.sendAudio(frameOf(1), 'dtmf'), true);
    await transport.hangup();
  });

  test('a fresh transport starts with the gate closed', () => {
    // Fail-safe default: the agent cannot be heard until the Call Model derives
    // an open gate. The opposite default would make every missed applyGate a leak.
    assert.equal(new LoopbackTransport().gate(), 'closed');
  });

  test('clear() empties a loaded playout queue and returns one mark per discarded chunk', async () => {
    const { endpoint, transport, session } = await pair(PROFILES.TELEPHONY, false);
    cleanups.push(() => endpoint.close());
    transport.applyGate('open');

    const chunks = ['reply-1', 'reply-2', 'reply-3', 'reply-4'];
    for (const name of chunks) {
      for (let i = 0; i < 2; i++) transport.sendAudio(frameOf(0x20), 'agent');
      await transport.mark(name);
    }
    await sleep(100);
    assert.ok(session.playout.depthMs() > 0, 'the queue is loaded before clearing');

    const discarded = await transport.clear();
    assert.deepEqual(discarded, chunks, 'one mark per discarded chunk, in order');
    assert.equal(session.playout.depthMs(), 0, 'queue is empty afterwards');
    await transport.hangup();
  });

  test('closing the gate clears the far-end queue on its own (ADR-007 layer 2)', async () => {
    const { endpoint, transport, session } = await pair(PROFILES.TELEPHONY, false);
    cleanups.push(() => endpoint.close());
    transport.applyGate('open');

    for (let i = 0; i < 8; i++) transport.sendAudio(frameOf(0x20), 'agent');
    await sleep(80);
    assert.ok(session.playout.depthMs() > 0);

    transport.applyGate('closed'); // no explicit clear() call
    await sleep(80);
    assert.equal(session.playout.depthMs(), 0, 'agent audio already queued must not play after the gate closes');
    await transport.hangup();
  });

  test('marks come back as they are played', async () => {
    const { endpoint, transport } = await pair(PROFILES.TELEPHONY, true);
    cleanups.push(() => endpoint.close());
    transport.applyGate('open');

    const played: string[] = [];
    transport.onMark((n) => played.push(n));
    transport.sendAudio(frameOf(0x20), 'agent');
    await transport.mark('end-of-greeting');
    await sleep(200);
    assert.deepEqual(played, ['end-of-greeting']);
    await transport.hangup();
  });

  test('DTMF survives the link and decodes at the far end (E1 precursor)', async () => {
    const { endpoint, transport, session } = await pair(PROFILES.TELEPHONY, true);
    cleanups.push(() => endpoint.close());
    transport.applyGate('dtmf_only');

    const detector = createGoertzelDetector();
    let decoded = '';
    session.onSpeaker((f) => {
      const d = detector.push(f);
      if (d !== null) decoded += d;
    });

    const frames = dtmf.generate('2');
    for (const f of frames) {
      assert.equal(transport.sendAudio(f, 'dtmf'), true);
      await sleep(FRAME_MS);
    }
    await sleep(200);
    assert.equal(decoded, '2');
    await transport.hangup();
  });

  test('A-1 regression: 20 digits at 100/50 ms decode 20/20 across TELEPHONY, off the frame grid', async () => {
    // The E1 criterion, kept in CI at one offset (scripts/e1-dtmf-reach.ts runs
    // the full sweep). Includes four immediate repeats, the case a short gap breaks.
    const { endpoint, transport, session } = await pair(PROFILES.TELEPHONY, true);
    cleanups.push(() => endpoint.close());
    transport.applyGate('dtmf_only');
    const detector = createGoertzelDetector();
    let decoded = '';
    session.onSpeaker((f) => { decoded += detector.push(f) ?? ''; });

    const digits = '0123456789*#55443300';
    const offset = new Uint8Array(56).fill(MULAW_SILENCE); // 7 ms
    const tones = dtmf.generate(digits, 100, 50);
    const bytes = new Uint8Array(offset.length + tones.length * BYTES_PER_FRAME);
    bytes.set(offset);
    tones.forEach((f, k) => bytes.set(f, offset.length + k * BYTES_PER_FRAME));
    const start = performance.now();
    for (const [k, f] of chunkToFrames(bytes).entries()) {
      transport.sendAudio(f, 'dtmf');
      // Paced by elapsed time, as the Audio Bridge will be.
      const due = start + (k + 1) * FRAME_MS;
      await sleep(Math.max(0, due - performance.now()));
    }
    await sleep(300);
    assert.equal(decoded, digits);
    await transport.hangup();
  });

  test('the speaker emits comfort silence on every empty tick; a short hole counts as underflow, a pause does not', async () => {
    const { endpoint, transport, session } = await pair(PROFILES.CLEAN, true);
    cleanups.push(() => endpoint.close());
    transport.applyGate('open');
    const speaker: number[] = [];
    session.onSpeaker((f) => speaker.push(f[0]!));

    const burst = (n: number) => { for (let i = 0; i < n; i++) transport.sendAudio(frameOf(0x33), 'agent'); };
    burst(2);
    await sleep(40 + 50); // the queue empties for a tick or two: a hole mid-audio
    burst(2);
    await sleep(60);
    const afterHole = session.underflowCount();
    assert.ok(afterHole >= 1, `a ${afterHole}-tick hole was not counted`);

    await sleep(400); // a pause, far longer than UNDERFLOW_SPAN ticks
    burst(2);
    await sleep(80);
    assert.equal(session.underflowCount(), afterHole, 'a pause was counted as underflow');

    // Every tick was heard: audio where there was audio, silence elsewhere.
    assert.equal(speaker.filter((b) => b === 0x33).length, 6);
    assert.ok(speaker.filter((b) => b === 0xff).length > 15, 'the silent ticks were not emitted');
    await transport.hangup();
  });

  test('a far-end hangup reports far_end_hangup, a dropped socket reports link_drop', async () => {
    const a = await pair(PROFILES.CLEAN);
    cleanups.push(() => a.endpoint.close());
    const causeA = new Promise<string>((r) => a.transport.onClosed(r));
    a.session.hangup();
    assert.equal(await causeA, 'far_end_hangup');

    const b = await pair(PROFILES.CLEAN);
    const causeB = new Promise<string>((r) => b.transport.onClosed(r));
    await b.endpoint.close(); // terminate without a hangup message
    assert.equal(await causeB, 'link_drop');
  });

  test('a malformed inbound frame is reported as a fault, never thrown', async () => {
    const { endpoint, transport, session } = await pair(PROFILES.CLEAN);
    cleanups.push(() => endpoint.close());
    const faults: string[] = [];
    transport.onFault((k) => faults.push(k));
    session.sendAudio(new Uint8Array(37));
    await sleep(40);
    assert.deepEqual(faults, ['malformed_frame']);
    await transport.hangup();
  });
});
