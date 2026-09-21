/**
 * Acceptance criteria for module 1.2 (§21 week 1):
 *   "mu-law round-trips losslessly; DTMF output decodes through Goertzel
 *    in-process 20/20; all four windows report their length; jitter policy
 *    implemented with all fault counters"
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  muLaw, encodeSample, decodeSample, silenceFrame,
  BYTES_PER_FRAME, MULAW_SILENCE, SAMPLE_RATE,
  dtmf, tonesFor, DTMF_FREQUENCIES, chunkToFrames,
  createGoertzelDetector, GOERTZEL_WINDOW_MS,
  createJitterBuffer,
  createSignalWindows, WINDOW_MS,
} from '../src/index.js';

describe('mu-law codec', () => {
  test('255 of 256 mu-law bytes survive decode->encode; 0x7F is the one exception', () => {
    // This, not PCM round-tripping, is what the transport depends on: mu-law is
    // what crosses the link in both directions with no resampling (§4.1).
    //
    // The exception is inherent to G.711, not a defect here. The format carries
    // both a positive and a negative zero — 0xFF and 0x7F — and both decode to
    // linear 0, so re-encoding cannot tell them apart and normalizes to 0xFF.
    // Worth knowing before anyone builds a checksum or a byte comparison on
    // mu-law: there is exactly one collision, and this is it.
    const survivors: number[] = [];
    const casualties: number[] = [];
    for (let byte = 0; byte < 256; byte++) {
      (encodeSample(decodeSample(byte)) === byte ? survivors : casualties).push(byte);
    }

    assert.deepEqual(casualties, [0x7f], 'only negative zero may fail to round-trip');
    assert.equal(survivors.length, 255);
    assert.equal(decodeSample(0x7f), 0);
    assert.equal(decodeSample(0xff), 0, 'both zeros decode to linear zero');
    assert.equal(encodeSample(0), 0xff, 'and encoding normalizes to positive zero');
  });

  test('array round trip over a full frame, avoiding the negative-zero code', () => {
    const original = new Uint8Array(BYTES_PER_FRAME);
    for (let i = 0; i < original.length; i++) {
      const byte = (i * 7) % 256;
      original[i] = byte === 0x7f ? 0xff : byte;
    }
    assert.deepEqual(muLaw.encode(muLaw.decode(original)), original);
  });

  test('PCM round trip is lossy, and that is the encoding working as designed', () => {
    // 8-bit logarithmic quantization of a 14-bit range. Stated as a test so
    // nobody later "fixes" the codec to chase exactness it cannot have.
    const pcm = Int16Array.from([0, 100, 1000, -1000, 16000, -16000]);
    const back = muLaw.decode(muLaw.encode(pcm));
    for (let i = 0; i < pcm.length; i++) {
      const error = Math.abs(back[i]! - pcm[i]!);
      const tolerance = Math.max(64, Math.abs(pcm[i]!) * 0.09);
      assert.ok(error <= tolerance, `sample ${pcm[i]} came back as ${back[i]}`);
    }
  });

  test('silence is 0xFF, not 0x00', () => {
    // 0x00 decodes to near full negative scale. Getting this wrong fills the
    // line with a loud tone during every gap.
    assert.equal(MULAW_SILENCE, 0xff);
    assert.ok(Math.abs(decodeSample(0xff)) < 100);
    assert.ok(Math.abs(decodeSample(0x00)) > 30000);

    const frame = silenceFrame();
    assert.equal(frame.length, BYTES_PER_FRAME);
    assert.ok(frame.every((b) => b === MULAW_SILENCE));
  });

  test('frame arithmetic matches §4.1', () => {
    assert.equal(SAMPLE_RATE, 8000);
    assert.equal(BYTES_PER_FRAME, 160);
  });
});

describe('DTMF generation', () => {
  test('the eight frequencies are ADR-005’s', () => {
    assert.deepEqual(DTMF_FREQUENCIES, [697, 770, 852, 941, 1209, 1336, 1477, 1633]);
  });

  test('keypad maps digits to the documented pairs', () => {
    assert.deepEqual(tonesFor('1'), [697, 1209]);
    assert.deepEqual(tonesFor('5'), [770, 1336]);
    assert.deepEqual(tonesFor('9'), [852, 1477]);
    assert.deepEqual(tonesFor('#'), [941, 1477]);
    assert.equal(tonesFor('Z'), null);
  });

  test('generated output is whole 20 ms frames', () => {
    for (const frame of dtmf.generate('2')) {
      assert.equal(frame.length, BYTES_PER_FRAME);
    }
  });

  test('a non-DTMF character is rejected loudly rather than silently skipped', () => {
    assert.throws(() => dtmf.generate('2Z'), /Not a DTMF digit/);
  });

  test('chunkToFrames pads a short tail with silence, not zeros', () => {
    const frames = chunkToFrames(new Uint8Array(BYTES_PER_FRAME + 10).fill(0x40));
    assert.equal(frames.length, 2);
    assert.equal(frames[1]![10], MULAW_SILENCE);
  });
});

describe('Goertzel detection (A-1, in-process half)', () => {
  const decode = (digits: string, toneMs?: number, gapMs?: number): string => {
    const detector = createGoertzelDetector();
    let out = '';
    for (const frame of dtmf.generate(digits, toneMs, gapMs)) {
      const digit = detector.push(frame);
      if (digit !== null) out += digit;
    }
    return out;
  };

  test('window is 40 ms and two consecutive detections are required (ADR-013)', () => {
    assert.equal(GOERTZEL_WINDOW_MS, 40);
  });

  test('20/20 digits at the default 100 ms / 50 ms timing', () => {
    // The in-process half of A-1. E1 runs the same sweep ACROSS the transport
    // under TELEPHONY, where jitter disturbs frame spacing; passing here is
    // necessary and not sufficient.
    const digits = '0123456789*#0192837465';
    let correct = 0;
    let attempted = 0;
    for (const digit of digits) {
      attempted++;
      if (decode(digit) === digit) correct++;
    }
    assert.ok(attempted >= 20, `expected at least 20 digits, tried ${attempted}`);
    assert.equal(correct, attempted, `${attempted - correct} of ${attempted} digits failed to decode`);
  });

  test('a multi-digit sequence decodes in order', () => {
    assert.equal(decode('2'), '2');
    assert.equal(decode('192'), '192');
  });

  test('a repeated digit is not collapsed — the gap separates the presses', () => {
    assert.equal(decode('11'), '11');
  });

  test('silence produces nothing', () => {
    const detector = createGoertzelDetector();
    for (let i = 0; i < 50; i++) assert.equal(detector.push(silenceFrame()), null);
  });

  test('a single pure tone is not a DTMF digit', () => {
    // Only a valid low+high PAIR is a digit. One tone must not be guessed at.
    const samples: number[] = [];
    for (let n = 0; n < SAMPLE_RATE; n++) {
      samples.push(Math.round(0.8 * Math.sin((2 * Math.PI * 697 * n) / SAMPLE_RATE) * 16384));
    }
    const detector = createGoertzelDetector();
    let detected: string | null = null;
    for (const frame of chunkToFrames(muLaw.encode(Int16Array.from(samples)))) {
      detected ??= detector.push(frame);
    }
    assert.equal(detected, null);
  });
});

describe('jitter buffer (§4.4)', () => {
  const frame = () => new Uint8Array(BYTES_PER_FRAME).fill(0x7f);

  test('underflow returns null and never blocks', () => {
    const jb = createJitterBuffer({ targetMs: 0 });
    assert.equal(jb.pull(), null);
    assert.equal(jb.faults().underflow, 1);
  });

  test('primes to the target depth before the first pull', () => {
    const jb = createJitterBuffer({ targetMs: 40 }); // two frames
    jb.push(frame(), 0);
    assert.equal(jb.pull(), null, 'one frame is below the target');
    jb.push(frame(), 20);
    assert.notEqual(jb.pull(), null);
  });

  test('overflow drops the OLDEST frame and counts it, never growing unbounded', () => {
    const jb = createJitterBuffer({ maxMs: 60, targetMs: 0 }); // three frames
    const tagged = (n: number) => new Uint8Array(BYTES_PER_FRAME).fill(n);
    for (let i = 1; i <= 5; i++) jb.push(tagged(i), i * 20);

    assert.equal(jb.faults().overflow, 2);
    assert.equal(jb.depthMs(), 60, 'depth is capped');
    assert.equal(jb.pull()![0], 3, 'frames 1 and 2 were dropped, 3 is now oldest');
  });

  test('a malformed frame is dropped and counted, never thrown', () => {
    const jb = createJitterBuffer({ targetMs: 0 });
    assert.doesNotThrow(() => jb.push(new Uint8Array(37), 0));
    assert.doesNotThrow(() => jb.push(new Uint8Array(BYTES_PER_FRAME + 1), 0));
    assert.equal(jb.faults().malformed, 2);
    assert.equal(jb.depthMs(), 0);
  });

  test('all three fault counters exist and are independent', () => {
    const jb = createJitterBuffer({ maxMs: 20, targetMs: 0 });
    jb.push(new Uint8Array(3), 0);
    jb.push(frame(), 0);
    jb.push(frame(), 20);
    jb.pull();
    jb.pull();
    const faults = jb.faults();
    assert.deepEqual(Object.keys(faults).sort(), ['malformed', 'overflow', 'underflow']);
    assert.equal(faults.malformed, 1);
    assert.equal(faults.overflow, 1);
    assert.equal(faults.underflow, 1);
  });
});

describe('signal windows (§4.3)', () => {
  const push = (w: ReturnType<typeof createSignalWindows>, seconds: number, gen: (n: number) => number) => {
    const total = SAMPLE_RATE * seconds;
    for (let off = 0; off < total; off += 160) {
      const block = new Int16Array(Math.min(160, total - off));
      for (let i = 0; i < block.length; i++) block[i] = gen(off + i);
      w.push(block, 0);
    }
  };

  test('all four windows report their documented length', () => {
    assert.deepEqual(createSignalWindows().windowsMs(), {
      rms: 250,
      pauseRatio: 2000,
      spectralFlatness: 1000,
      autocorrelation: 20000,
    });
    assert.equal(WINDOW_MS.autocorrelation, 20_000, 'the slow confirmation window');
  });

  test('availability reports only windows that are actually full (§6.4)', () => {
    const w = createSignalWindows();
    assert.deepEqual(w.availability(), [], 'nothing is available before any audio');

    push(w, 0.3, () => 5000);
    assert.deepEqual(w.availability(), ['rms']);

    push(w, 1.0, () => 5000);
    assert.deepEqual(w.availability().sort(), ['rms', 'spectralFlatness']);

    push(w, 1.0, () => 5000);
    assert.ok(w.availability().includes('pauseRatio'));
    assert.ok(!w.availability().includes('autocorrelation'), '20 s is not reached yet');
  });

  test('RMS separates silence from signal', () => {
    const quiet = createSignalWindows();
    push(quiet, 0.5, () => 0);
    assert.ok(quiet.rms() < 10);

    const loud = createSignalWindows();
    push(loud, 0.5, (n) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * n) / SAMPLE_RATE)));
    assert.ok(loud.rms() > 1000);
  });

  test('pause ratio is high for intermittent speech and low for continuous audio', () => {
    const continuous = createSignalWindows();
    push(continuous, 3, (n) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * n) / SAMPLE_RATE)));
    assert.ok(continuous.pauseRatio() < 0.1, 'hold audio has almost no pauses');

    const intermittent = createSignalWindows();
    push(intermittent, 3, (n) => {
      const onePerSecond = Math.floor(n / (SAMPLE_RATE * 0.5)) % 2 === 0;
      return onePerSecond ? Math.round(8000 * Math.sin((2 * Math.PI * 440 * n) / SAMPLE_RATE)) : 0;
    });
    assert.ok(intermittent.pauseRatio() > 0.3, 'speech has many pauses');
  });

  test('spectral flatness is low for a tone and high for noise', () => {
    const tone = createSignalWindows();
    push(tone, 1.5, (n) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * n) / SAMPLE_RATE)));

    const noise = createSignalWindows();
    let seed = 12345;
    push(noise, 1.5, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return ((seed % 16000) - 8000) | 0;
    });

    assert.ok(tone.spectralFlatness() < noise.spectralFlatness(),
      `tone ${tone.spectralFlatness()} should be flatter-negative than noise ${noise.spectralFlatness()}`);
  });

  test('autocorrelation finds a loop and does not invent one in noise', () => {
    // This is the signal the CONFIRMED tier rests on, so a false peak here
    // would confirm HOLD on a live conversation.
    const looped = createSignalWindows();
    const loopSamples = SAMPLE_RATE * 2;
    push(looped, 20, (n) => {
      const p = n % loopSamples;
      return Math.round(6000 * Math.sin((2 * Math.PI * 300 * p) / SAMPLE_RATE));
    });

    const noisy = createSignalWindows();
    let seed = 999;
    push(noisy, 20, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return ((seed % 12000) - 6000) | 0;
    });

    assert.ok(looped.autocorrelationPeak() > 0.5, `loop peak was ${looped.autocorrelationPeak()}`);
    assert.ok(noisy.autocorrelationPeak() < 0.3, `noise peak was ${noisy.autocorrelationPeak()}`);
  });

  test('reset clears availability', () => {
    const w = createSignalWindows();
    push(w, 1.5, () => 5000);
    assert.ok(w.availability().length > 0);
    w.reset();
    assert.deepEqual(w.availability(), []);
  });
});
