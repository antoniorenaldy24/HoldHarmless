/**
 * Acceptance criteria for module 4.1 (§21 week 4):
 *   "Live microphone path working; classifier holds its calibration figures;
 *    latency reported separately"
 *
 * CI has no microphone, and neither does any build agent, so every behaviour
 * that can be pinned without a device is pinned here against `ScriptedMicrophone`
 * — the same class `scripts/mic-check.ts` uses to push rendered assets down the
 * live path. What genuinely needs a device is the device: `FfmpegMicrophone`'s
 * argument construction and its three failure modes are tested with `spawn`
 * injected, and the acoustic figures are measured by the script, on real audio,
 * where §6.6's recordings will answer the second criterion.
 *
 * The test that matters most here is the one about `lastSpeechAtMs`. Getting it
 * wrong does not break anything: it silently adds the endpointer's own 700 ms
 * of patience to every `HUMAN_REP` latency figure, against a bar of 300 ms.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { BYTES_PER_FRAME, FRAME_MS, MULAW_SILENCE, dtmf, muLaw } from '@holdharmless/audio';
import { PROFILES } from '@holdharmless/transport';
import { LoopbackTransport } from '@holdharmless/transport-loopback';
import {
  FfmpegMicrophone,
  HarnessServer,
  LINE_IDS,
  ScriptedMicrophone,
  SPEECH_RMS,
  TURN_END_SILENCE_MS,
  captureArgs,
  connectControl,
  frameRms,
  micTurn,
  type AssetSource,
  type LineId,
  type MicFrame,
  type MicrophoneSource,
  type TelemetryMessage,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Test audio
// ---------------------------------------------------------------------------

/** A frame well above the speech threshold. 0x20 is a large negative μ-law. */
const loud = (): Uint8Array => new Uint8Array(BYTES_PER_FRAME).fill(0x20);
/** μ-law silence, which decodes to an RMS of zero. */
const quiet = (): Uint8Array => new Uint8Array(BYTES_PER_FRAME).fill(MULAW_SILENCE);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drives `micTurn` with no real time and no scheduler: one frame per call. */
function harnessedTurn(opts: { silenceMs?: number; maxMs?: number; onsetTimeoutMs?: number } = {}) {
  const mic = new ScriptedMicrophone([]);
  const emitted: Uint8Array[] = [];
  let now = 1000;
  const fires: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const turn = micTurn({
    source: mic,
    emit: (f) => emitted.push(f),
    schedule: (fn, ms) => {
      const entry = { at: now + ms, fn, cancelled: false };
      fires.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    },
    ...opts,
  });
  /** Feeds one frame, stamped as captured exactly on cadence and on time. */
  const feed = (frame: Uint8Array, delayMs = 0) => {
    const capturedAtMs = now;
    now += FRAME_MS;
    for (const h of (mic as unknown as { handlers: ((f: MicFrame) => void)[] }).handlers) h({ frame, capturedAtMs, delayMs });
  };
  const advanceTo = (t: number) => {
    now = t;
    for (const f of fires) if (!f.cancelled && f.at <= t) { f.cancelled = true; f.fn(); }
  };
  return { turn, emitted, feed, advanceTo, at: () => now };
}

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

describe('a microphone turn (§10.6)', () => {
  test('the room before the turn is not forwarded', async () => {
    // The device is open for the whole call (see microphone.ts), so what
    // precedes a turn is the room. Sending it would run the agent's own
    // silence-recovery timers (§5.7) against noise nobody made.
    const h = harnessedTurn();
    h.feed(quiet());
    h.feed(quiet());
    assert.deepEqual(h.emitted, [], 'nothing before onset');
    h.feed(loud());
    assert.equal(h.emitted.length, 1, 'and everything from onset');
    h.turn.stop();
    await h.turn.done;
  });

  test('lastSpeechAtMs is the last frame with speech in it, not the endpointer\'s verdict', async () => {
    // THE test of this module. `perceived_response_ms` is measured from this
    // point; if it were the moment the turn resolved, every HUMAN_REP figure
    // would carry the whole silence window inside it.
    const h = harnessedTurn({ silenceMs: 100 });
    h.feed(loud());
    const lastSpeechAt = h.at() - FRAME_MS; // the frame just fed
    for (let i = 0; i < 6; i++) h.feed(quiet());
    const result = await h.turn.done;

    assert.equal(result.endedBy, 'silence');
    assert.equal(result.lastSpeechAtMs, lastSpeechAt);
    assert.ok(
      h.at() - result.lastSpeechAtMs! >= 100,
      'the turn resolved at least a silence window after the last speech, which is exactly what must NOT be counted as latency',
    );
  });

  test('a mid-sentence pause shorter than the window does not end the turn', async () => {
    const h = harnessedTurn({ silenceMs: 200 });
    h.feed(loud());
    h.feed(quiet());       //  20 ms
    h.feed(quiet());       //  40 ms
    h.feed(loud());        // speaking again
    h.feed(loud());
    const stillOpen = await Promise.race([h.turn.done, sleep(0).then(() => 'open' as const)]);
    assert.equal(stillOpen, 'open');
    assert.equal(h.emitted.length, 5, 'the pause is part of the turn and is forwarded');
    h.turn.stop();
    await h.turn.done;
  });

  test('the turn is capped, and the cap replaces the onset deadline rather than joining it', async () => {
    const h = harnessedTurn({ maxMs: 500, onsetTimeoutMs: 300 });
    h.feed(loud()); // onset at t=1000; the 300 ms onset deadline must be gone
    h.advanceTo(1400);
    const notYet = await Promise.race([h.turn.done, sleep(0).then(() => 'open' as const)]);
    assert.equal(notYet, 'open', 'the onset deadline would have fired by now if it had survived');
    h.advanceTo(1600);
    assert.equal((await h.turn.done).endedBy, 'max_duration');
  });

  test('nobody speaking is reported as no_onset, not as an empty turn', async () => {
    const h = harnessedTurn({ onsetTimeoutMs: 300 });
    h.feed(quiet());
    h.advanceTo(2000);
    const result = await h.turn.done;
    assert.equal(result.endedBy, 'no_onset');
    assert.equal(result.lastSpeechAtMs, null);
    assert.deepEqual(result.frames, []);
  });

  test('stop() ends the turn', async () => {
    const h = harnessedTurn();
    h.feed(loud());
    h.turn.stop();
    assert.equal((await h.turn.done).endedBy, 'stopped');
  });

  test('the turn passes on the delay the source measured, and measures none of its own', async () => {
    // The two numbers are separate fields on MicFrame for a reason the type
    // records: the timeline must keep its 20 ms spacing, the delay must discount
    // the constant buffering, and one field cannot be both. A turn that
    // recomputed the delay from the timeline would reintroduce exactly the
    // standing offset the source exists to remove.
    const mic = new ScriptedMicrophone([]);
    const turn = micTurn({ source: mic, emit: () => {}, silenceMs: 10_000 });
    const handlers = (mic as unknown as { handlers: ((f: MicFrame) => void)[] }).handlers;
    handlers[0]!({ frame: loud(), capturedAtMs: 500, delayMs: 0 });
    handlers[0]!({ frame: loud(), capturedAtMs: 520, delayMs: 40 });
    turn.stop();
    assert.deepEqual((await turn.done).frameDelaysMs, [0, 40]);
  });

  test('a finished turn lets go of the stream', async () => {
    // One source serves a whole call. A turn that stayed subscribed would leave
    // one dead listener per turn, each decoding every frame of every later turn.
    const mic = new ScriptedMicrophone([]);
    const handlers = (mic as unknown as { handlers: ((f: MicFrame) => void)[] }).handlers;
    const first = micTurn({ source: mic, emit: () => {} });
    assert.equal(handlers.length, 1);
    first.stop();
    await first.done;
    assert.equal(handlers.length, 0, 'unsubscribed');
    const second = micTurn({ source: mic, emit: () => {} });
    assert.equal(handlers.length, 1, 'and the next turn is the only listener');
    second.stop();
    await second.done;
  });

  test('SPEECH_RMS is the threshold onset actually consults', async () => {
    // Not asserted against a hand-built frame at exactly SPEECH_RMS: μ-law
    // quantizes, so "a frame whose samples are 250" and "a frame whose RMS is
    // 250" are different things and the test would be about the codec. Two
    // frames on opposite sides of the threshold, measured rather than assumed,
    // say what matters — and then the turn is asked which one it opened on.
    const amp = (a: number) => muLaw.encode(new Int16Array(BYTES_PER_FRAME).fill(a));
    const below = amp(100);
    const above = amp(4000);
    assert.ok(frameRms(below) < SPEECH_RMS, `below: ${frameRms(below)}`);
    assert.ok(frameRms(above) >= SPEECH_RMS, `above: ${frameRms(above)}`);
    assert.equal(frameRms(quiet()), 0, 'comfort silence is silent');

    const h = harnessedTurn();
    h.feed(below);
    assert.deepEqual(h.emitted, [], 'the quieter frame did not open the turn');
    h.feed(above);
    assert.equal(h.emitted.length, 1, 'the louder one did');
    h.turn.stop();
    await h.turn.done;
  });
});

// ---------------------------------------------------------------------------
// The device
// ---------------------------------------------------------------------------

describe('the capture device', () => {
  test('each platform gets the input its ffmpeg expects, and every platform the same output', () => {
    const win = captureArgs('Microphone (Realtek)', 'win32');
    const mac = captureArgs(':1', 'darwin');
    const linux = captureArgs('default', 'linux');
    assert.ok(win.join(' ').includes('-f dshow -i audio=Microphone (Realtek)'));
    assert.ok(mac.join(' ').includes('-f avfoundation -i :1'));
    assert.ok(linux.join(' ').includes('-f alsa -i default'));
    for (const args of [win, mac, linux]) {
      assert.ok(args.join(' ').endsWith('-ar 8000 -ac 1 -f mulaw -'), 'μ-law 8 kHz mono, which is what the wire carries');
    }
  });

  test('no loudnorm on the live path, and that is a decision', () => {
    // §10.2 loudness-normalizes every rendered asset. Doing the same here would
    // add about three seconds of lookahead to a path this module exists to
    // measure. The consequence — live capture is not level-matched to the
    // assets — is handled by MEASURING the level (mic_level_rms), and this test
    // is what stops the filter being added back for consistency's sake.
    assert.ok(!captureArgs('x', 'win32').join(' ').includes('loudnorm'));
    assert.ok(!captureArgs('x', 'win32').join(' ').includes('dynaudnorm'));
  });

  /** A fake capture process whose stdout the test controls. */
  function fakeProc(): ChildProcess & { stdout: PassThrough; stderr: PassThrough } {
    const proc = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    Object.defineProperty(proc, 'exitCode', { value: null, writable: true });
    proc.kill = () => { proc.emit('exit', 0); return true; };
    return proc;
  }

  test('a device that opens and then stays silent is an error that names it', async () => {
    // The failure mode that matters: a muted input, or a webcam microphone
    // whose phone app is not running. spawn() succeeds, audio never comes, and
    // without this it looks like a hang in the middle of a rehearsal.
    const mic = new FfmpegMicrophone({ device: 'Microphone (Iriun Webcam)', openTimeoutMs: 30, spawn: () => fakeProc() });
    await assert.rejects(mic.open(), /Microphone \(Iriun Webcam\).*produced no audio/s);
  });

  test('ffmpeg exiting before any audio is reported with its own complaint', async () => {
    const proc = fakeProc();
    const mic = new FfmpegMicrophone({ device: 'nope', openTimeoutMs: 2_000, spawn: () => proc });
    const opening = assert.rejects(mic.open(), /exited with code 1.*Unknown input format/s);
    proc.stderr.write('Unknown input format: dshow\n');
    await sleep(0);
    proc.emit('exit', 1);
    await opening;
  });

  test('audio arriving in chunks that do not align to frames still comes out as frames', async () => {
    // ffmpeg writes when its buffer is ready, not on 160-byte boundaries.
    const proc = fakeProc();
    const mic = new FfmpegMicrophone({ device: 'x', spawn: () => proc });
    const frames: MicFrame[] = [];
    mic.onFrame((f) => frames.push(f));
    const opening = mic.open();
    const audio = new Uint8Array(BYTES_PER_FRAME * 3).fill(0x20);
    proc.stdout.write(Buffer.from(audio.subarray(0, 250)));   // 1 frame + 90 bytes
    await opening;
    proc.stdout.write(Buffer.from(audio.subarray(250)));      // the rest
    await sleep(0);
    assert.equal(frames.length, 3);
    for (const f of frames) assert.equal(f.frame.length, BYTES_PER_FRAME);
    assert.deepEqual(
      frames.map((f) => f.capturedAtMs - frames[0]!.capturedAtMs),
      [0, FRAME_MS, FRAME_MS * 2],
      'capture times follow the cadence, not the chunking',
    );
    assert.ok(frames.every((f) => f.delayMs >= 0), 'and no delay is negative');
    await mic.close();
  });

  test('a buffer flushed at open does not put a permanent negative offset on every delay', async () => {
    // Found by running this against real hardware: ffmpeg opens the device,
    // buffers, then flushes — 174 frames (3480 ms of audio) in the first 3000 ms
    // of wall time. Anchored to frame zero's arrival, the stream position runs
    // permanently ahead of the clock by the depth of that flush and every delay
    // reads about -480 ms, so a real stall could never show as positive.
    const proc = fakeProc();
    let now = 0;
    const mic = new FfmpegMicrophone({ device: 'x', spawn: () => proc, clock: () => now });
    const frames: MicFrame[] = [];
    mic.onFrame((f) => frames.push(f));
    const opening = mic.open();

    // 25 frames (500 ms of audio) arrive in one chunk, at one instant.
    proc.stdout.write(Buffer.from(new Uint8Array(BYTES_PER_FRAME * 25).fill(0x20)));
    await opening;
    // Then the stream runs in real time: one frame per 20 ms.
    for (let i = 0; i < 10; i++) {
      now += FRAME_MS;
      proc.stdout.write(Buffer.from(new Uint8Array(BYTES_PER_FRAME).fill(0x20)));
      await sleep(0);
    }
    const steady = frames.slice(25).map((f) => f.delayMs);
    assert.ok(
      steady.every((d) => d >= 0 && d <= FRAME_MS),
      `steady-state delays are ${JSON.stringify(steady)} ms; the 500 ms flush has been baked into the anchor`,
    );
    // And the timeline is untouched by the flush: the 25 frames that arrived at
    // one instant still describe 500 ms of audio, because they were 500 ms of
    // audio. Collapsing them would shorten every turn delivered in one chunk.
    assert.equal(frames[24]!.capturedAtMs - frames[0]!.capturedAtMs, 24 * FRAME_MS);
    await mic.close();
  });

  test('startup latency is the gap from open to the first byte, and is reported once', async () => {
    const proc = fakeProc();
    let now = 0;
    const mic = new FfmpegMicrophone({ device: 'x', spawn: () => proc, clock: () => now });
    const opening = mic.open();
    assert.equal(mic.startupLatencyMs, null, 'unknown until audio arrives');
    now = 420;
    proc.stdout.write(Buffer.from(new Uint8Array(BYTES_PER_FRAME).fill(0x20)));
    await opening;
    assert.equal(mic.startupLatencyMs, 420);
    await mic.close();
  });
});

// ---------------------------------------------------------------------------
// The harness in HUMAN_REP mode
// ---------------------------------------------------------------------------

const TAG_BASE = 0x20;
const tagOf = (id: LineId) => TAG_BASE + LINE_IDS.indexOf(id);

function taggedAssets(): AssetSource {
  const frame = (tag: number) => new Uint8Array(BYTES_PER_FRAME).fill(tag);
  return {
    line: (id) => Array.from({ length: 5 }, () => frame(tagOf(id))),
    holdMusic: () => Array.from({ length: 10 }, () => frame(0x10)),
  };
}

describe('HUMAN_REP end to end', () => {
  const servers: HarnessServer[] = [];
  test.after(async () => { for (const s of servers) await s.close(); });

  /**
   * A microphone that speaks a short turn: loud frames, then silence long
   * enough to end it. `open()` here does not start a timer — the frames are
   * pushed by the test, so the turn cannot depend on wall-clock timing.
   */
  class PushMic implements MicrophoneSource {
    private readonly handlers: ((f: MicFrame) => void)[] = [];
    startupLatencyMs: number | null = null;
    opened = 0;
    open(): Promise<void> {
      this.opened++;
      this.startupLatencyMs = 130;
      return Promise.resolve();
    }
    onFrame(h: (f: MicFrame) => void): () => void {
      this.handlers.push(h);
      return () => { const i = this.handlers.indexOf(h); if (i >= 0) this.handlers.splice(i, 1); };
    }
    /**
     * Pushes frames at the real frame cadence, so `capturedAtMs` tracks wall
     * time the way a device's does. The instant `say` below is fine for tests
     * about what was reported; a test about a DURATION cannot use it, because
     * fifty frames pushed in one millisecond carry capture times a second into
     * the future.
     */
    async sayPaced(loudFrames: number, quietFrames: number): Promise<void> {
      for (let i = 0; i < loudFrames + quietFrames; i++) {
        const frame = i < loudFrames ? loud() : quiet();
        for (const h of [...this.handlers]) h({ frame, capturedAtMs: performance.now(), delayMs: 0 });
        await sleep(FRAME_MS);
      }
    }
    say(loudFrames: number, quietFrames: number): void {
      const t0 = performance.now();
      let n = 0;
      for (let i = 0; i < loudFrames; i++) for (const h of [...this.handlers]) h({ frame: loud(), capturedAtMs: t0 + n++ * FRAME_MS, delayMs: 0 });
      n = loudFrames;
      for (let i = 0; i < quietFrames; i++) for (const h of [...this.handlers]) h({ frame: quiet(), capturedAtMs: t0 + n++ * FRAME_MS, delayMs: 0 });
    }
    close(): Promise<void> { return Promise.resolve(); }
  }

  const start = async (over: Parameters<typeof HarnessServer.start>[0] extends infer T ? Partial<T> : never = {}) => {
    const h = await HarnessServer.start({ port: 0, profile: PROFILES.TELEPHONY, assets: taggedAssets(), navMode: 'dtmf', ...over });
    servers.push(h);
    return h;
  };

  async function call(h: HarnessServer, callId: string) {
    const transport = new LoopbackTransport();
    const telemetry: TelemetryMessage[] = [];
    await connectControl(h.controlUrl(), (m) => { if (m.callId === callId) telemetry.push(m); });
    const heardFrames: Uint8Array[] = [];
    const tags = new Set<number>();
    transport.onAudio((f) => { heardFrames.push(f); tags.add(f[0]!); });
    await transport.dial(h.callUrl(callId), PROFILES.TELEPHONY);
    transport.applyGate('open');
    const metric = (name: string) => telemetry.filter((m) => m.metric === name);
    const pressDigit = async (d: string) => {
      for (const frame of dtmf.generate(d)) {
        transport.sendAudio(frame, 'dtmf');
        await sleep(FRAME_MS);
      }
    };
    const waitFor = async (what: string, ok: () => boolean, timeoutMs = 5_000) => {
      const until = performance.now() + timeoutMs;
      while (!ok()) {
        if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
        await sleep(10);
      }
    };
    /**
     * §10.5's conversation begins at the representative's greeting, and the
     * greeting is the first thing HUMAN_REP substitutes — so every test here
     * has to walk the menu to get to it. Skipping the walk was why two of these
     * tests first "passed" by never reaching the code they were about.
     */
    const reachRepresentative = async () => {
      await waitFor('main menu', () => tags.has(tagOf('ivr_main_menu')));
      await pressDigit('3');
      await waitFor('prior-auth menu', () => tags.has(tagOf('ivr_priorauth_menu')));
      await pressDigit('1');
      await waitFor('service menu', () => tags.has(tagOf('ivr_service_menu')));
      await pressDigit('1');
      await waitFor('the connecting line', () => tags.has(tagOf('ivr_connecting')));
    };
    return { transport, telemetry, heardFrames, tags, metric, pressDigit, waitFor, reachRepresentative };
  }

  test('the mode is reported first, so no figure from the run is mode-less', async () => {
    const mic = new PushMic();
    const h = await start({ repMode: 'HUMAN_REP', microphone: () => mic, queueHoldMs: 0 });
    const c = await call(h, 'MIC-mode');
    await sleep(120);
    const modes = c.metric('rep_mode');
    assert.equal(modes.length, 1);
    assert.equal(modes[0]!.value, 1);
    assert.equal(modes[0]!.detail, 'HUMAN_REP');
    await c.transport.hangup();
  });

  test('BOT_REP reports itself too — the metric exists in both modes or it proves nothing', async () => {
    const h = await start({ queueHoldMs: 0 });
    const c = await call(h, 'MIC-bot');
    await sleep(120);
    assert.deepEqual(c.metric('rep_mode').map((m) => [m.value, m.detail]), [[0, 'BOT_REP']]);
    await c.transport.hangup();
  });

  test('a live turn reaches the core, and reports its length, level and startup cost', async () => {
    const mic = new PushMic();
    const h = await start({ repMode: 'HUMAN_REP', microphone: () => mic, queueHoldMs: 0 });
    const c = await call(h, 'MIC-turn');
    await c.reachRepresentative();
    // The greeting is a rep line, so in HUMAN_REP it waits for the microphone.
    await c.waitFor('the device to open', () => mic.opened === 1);
    mic.say(10, 40);
    await sleep(400);

    assert.deepEqual(c.metric('mic_startup_latency_ms').map((m) => m.value), [130]);
    const length = c.metric('human_rep_turn_ms');
    assert.equal(length.length, 1);
    assert.equal(length[0]!.detail, 'silence', 'the turn ended because the speaker stopped');
    assert.ok(length[0]!.value >= 10 * FRAME_MS, `turn was ${length[0]!.value} ms`);
    assert.ok(c.metric('mic_level_rms')[0]!.value > SPEECH_RMS);
    assert.equal(c.metric('human_rep_line')[0]!.detail, 'rep1_greeting', 'what the person was reading is what the run reports');
    assert.ok(c.heardFrames.some((f) => f[0] === 0x20), 'the core heard the live audio');
    await c.transport.hangup();
  });

  test('the latency zero point is the last word spoken, not the moment the endpointer agreed', async () => {
    // The mutation that survived the first pass of module 4.1's mutation run.
    // Arming from the endpointer's verdict deducts the whole silence window from
    // every HUMAN_REP figure — 700 ms off a number measured against 300 ms, in
    // the flattering direction. See TurnResult.lastSpeechAtMs.
    const mic = new PushMic();
    const h = await start({ repMode: 'HUMAN_REP', microphone: () => mic, queueHoldMs: 0 });
    const c = await call(h, 'MIC-zero');
    await c.reachRepresentative();
    await c.waitFor('the device to open', () => mic.opened === 1);

    // Ten frames of speech, then enough quiet to end the turn: the last word is
    // ~200 ms in, the endpointer agrees ~700 ms after that.
    await mic.sayPaced(10, 40);
    await c.waitFor('the turn to end', () => c.metric('human_rep_turn_ms').length === 1);
    c.transport.sendAudio(new Uint8Array(BYTES_PER_FRAME).fill(0x30), 'agent');
    await c.waitFor('a latency figure', () => c.metric('perceived_response_ms').length >= 1);

    const ms = c.metric('perceived_response_ms')[0]!.value;
    // The bar is the silence window itself, and that is not arbitrary: that
    // silence happened AFTER the last word and BEFORE the reply, so a correct
    // figure cannot be smaller than it. Measured here: 1329 ms correct against
    // 603 ms when armed from the endpointer's verdict — the difference is the
    // window, to within a frame.
    assert.ok(ms >= TURN_END_SILENCE_MS, `${ms} ms is less than the ${TURN_END_SILENCE_MS} ms of silence that preceded the reply: the window has been deducted from the agent's latency`);
    assert.equal(c.metric('perceived_response_ms')[0]!.detail, 'HUMAN_REP');
    await c.transport.hangup();
  });

  test('a turn nobody speaks is reported as missing, not as a slow agent', async () => {
    const mic = new PushMic();
    const h = await start({ repMode: 'HUMAN_REP', microphone: () => mic, queueHoldMs: 0 });
    const c = await call(h, 'MIC-silent');
    await c.reachRepresentative();
    await c.waitFor('the device to open', () => mic.opened === 1);
    mic.say(0, 5); // room noise only, below the threshold
    await sleep(50);
    // The onset deadline is 20 s by default, so nothing has fired yet — what is
    // asserted is that no latency figure was invented in the meantime.
    assert.deepEqual(c.metric('perceived_response_ms'), []);
    await c.transport.hangup();
  });

  test('HUMAN_REP without a configured device fails loudly, and BOT_REP refuses the microphone', async () => {
    const noMic = await start({ repMode: 'HUMAN_REP', queueHoldMs: 0 });
    const c1 = await call(noMic, 'MIC-none');
    await c1.reachRepresentative();
    await c1.waitFor(
      'the failure to be reported',
      () => c1.metric('harness_error').some((m) => /no microphone source is configured/.test(m.detail ?? '')),
    );
    await c1.transport.hangup();

    // The other direction: a device configured on a BOT_REP session is refused
    // rather than quietly used, so a mode set in one place and a source set in
    // another cannot combine into a run that is neither mode.
    const bot = await start({ microphone: () => new PushMic(), queueHoldMs: 0 });
    const c2 = await call(bot, 'MIC-wrongmode');
    await c2.waitFor('the session', () => bot.sessions.has('MIC-wrongmode'));
    await assert.rejects(bot.sessions.get('MIC-wrongmode')!.streamMicrophone(1), /requires repMode HUMAN_REP/);
    await c2.transport.hangup();
  });

  test('only a representative can be live', async () => {
    const h = await start({ repMode: 'HUMAN_REP', microphone: () => new PushMic(), queueHoldMs: 0 });
    const c = await call(h, 'MIC-persona');
    await c.waitFor('the session', () => h.sessions.has('MIC-persona'));
    const s = h.sessions.get('MIC-persona')!;
    await assert.rejects(s.streamMicrophone(0), /only a representative can be live/);
    await assert.rejects(s.streamMicrophone(9), /only a representative can be live/);
    await c.transport.hangup();
  });
});

// ---------------------------------------------------------------------------
// perceived_response_ms — §7, §16.1
// ---------------------------------------------------------------------------

describe('perceived_response_ms is produced by the harness (§16.1)', () => {
  const servers: HarnessServer[] = [];
  test.after(async () => { for (const s of servers) await s.close(); });

  async function rig(callId: string, over: Record<string, unknown> = {}) {
    const h = await HarnessServer.start({ port: 0, profile: PROFILES.CLEAN, assets: taggedAssets(), navMode: 'dtmf', queueHoldMs: 0, ...over });
    servers.push(h);
    const transport = new LoopbackTransport();
    const telemetry: TelemetryMessage[] = [];
    await connectControl(h.controlUrl(), (m) => { if (m.callId === callId) telemetry.push(m); });
    await transport.dial(h.callUrl(callId), PROFILES.CLEAN);
    transport.applyGate('open');
    const say = async (frames: number) => {
      for (let i = 0; i < frames; i++) {
        transport.sendAudio(new Uint8Array(BYTES_PER_FRAME).fill(0x30), 'agent');
        await sleep(FRAME_MS);
      }
    };
    return { h, transport, telemetry, say, of: (m: string) => telemetry.filter((t) => t.metric === m) };
  }

  test('a representative line starts the clock and the agent\'s first audible frame stops it', async () => {
    const r = await rig('PRM-rep');
    await sleep(200);           // the menu plays, then the greeting
    const s = r.h.sessions.get('PRM-rep')!;
    await s.speakAs(1, 'rep1_ask_npi');
    await r.say(5);
    await sleep(200);
    const figures = r.of('perceived_response_ms');
    assert.ok(figures.length >= 1, 'a figure was produced');
    assert.equal(figures[0]!.detail, 'BOT_REP', 'the mode travels with the figure');
    assert.ok(figures[0]!.value >= 0 && figures[0]!.value < 5_000, `implausible: ${figures[0]!.value} ms`);
    await r.transport.hangup();
  });

  test('a menu prompt does NOT start it — §7 defines it on the representative\'s line', async () => {
    // After a prompt the agent replies with DTMF, and DTMF is not what this
    // number is about. Arming on every line would quietly change its meaning.
    const r = await rig('PRM-ivr');
    await sleep(100);
    const s = r.h.sessions.get('PRM-ivr')!;
    await s.speakAs(0, 'ivr_invalid');
    await r.say(5);
    await sleep(150);
    assert.deepEqual(r.of('perceived_response_ms'), []);
    await r.transport.hangup();
  });

  test('hold music cancels a pending wait rather than timing itself', async () => {
    const r = await rig('PRM-hold');
    await sleep(200);
    const s = r.h.sessions.get('PRM-hold')!;
    await s.speakAs(1, 'rep1_hold_cue');
    const before = r.of('perceived_response_ms').length;
    await s.playHold(200, false);
    await r.say(5);
    await sleep(200);
    assert.equal(r.of('perceived_response_ms').length, before, 'the wait ended when the far end acted, not when the agent did');
    await r.transport.hangup();
  });

  test('comfort silence is not a reply', async () => {
    // onSpeaker fires on every drain tick, silence included (§4.4). A figure
    // measured from the first tick would be noise dressed as a measurement.
    const r = await rig('PRM-silence');
    await sleep(200);
    const s = r.h.sessions.get('PRM-silence')!;
    await s.speakAs(1, 'rep1_ask_dob');
    await sleep(300); // nothing sent: only comfort silence reaches the speaker
    assert.deepEqual(r.of('perceived_response_ms'), []);
    await r.transport.hangup();
  });
});
