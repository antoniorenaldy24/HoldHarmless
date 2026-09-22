/**
 * Acceptance criteria for module 2.1 (§21 week 2):
 *   "Emits at 250 ms; provisional tier fires within 1.5 s of hold audio onset;
 *    confirmed tier requires autocorrelation"
 *
 * The audio is the harness's own: the generated hold music, and — where they
 * have been rendered — the real IVR and representative lines. CI has no TTS, so
 * the speech cases that must run everywhere use a synthetic stand-in whose
 * measured signals sit inside the range of the rendered voices.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AcousticObservation } from '@holdharmless/events';
import { SAMPLE_RATE, muLaw } from '@holdharmless/audio';
import { ASSET_DIR, MANIFEST, holdMusicPcm, lineFile, type LineId } from '@holdharmless/ivr-harness';
import {
  EMIT_INTERVAL_MS,
  createAcousticClassifier,
  voteAutocorrelation,
  votePauseRatio,
  voteSpectralFlatness,
} from '../src/index.js';

/**
 * Bursts of correlated noise separated by pauses — speech-shaped, not speech.
 *
 * Burst and pause lengths are drawn from the same generator as the noise, so the
 * clip has no period. The first version cycled three fixed burst lengths, which
 * gave it an autocorrelation peak of 0.60 — as periodic as the hold music.
 *
 * Generate the WHOLE duration a test needs. Looping a short clip to fill a
 * window makes it periodic with the clip's own length, whatever its content:
 * an 8 s clip looped through the 20 s window measured 0.60 as well.
 */
function syntheticSpeech(seconds: number): Int16Array {
  const out: number[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const uniform = (lo: number, hi: number) => lo + ((rnd() + 1) / 2) * (hi - lo);
  let prev = 0;
  while (out.length < seconds * SAMPLE_RATE) {
    const burst = Math.round(SAMPLE_RATE * uniform(0.18, 0.55));
    for (let i = 0; i < burst; i++) {
      prev = 0.6 * rnd() + 0.4 * prev;
      out.push(Math.round(prev * 9000));
    }
    const pause = Math.round(SAMPLE_RATE * uniform(0.1, 0.35));
    for (let i = 0; i < pause; i++) out.push(0);
  }
  return Int16Array.from(out.slice(0, seconds * SAMPLE_RATE));
}

const silence = (seconds: number) => new Int16Array(seconds * SAMPLE_RATE);

/**
 * Feeds `seconds` of audio, looping the source, and returns the observations.
 *
 * `from` continues a source where a previous call left off. Restarting the loop
 * at zero on a second call puts a phase break in the middle of the window, and
 * the music's autocorrelation peak falls from 0.60 to 0.28 — a property of the
 * test, not of the classifier.
 */
function feed(
  classifier: ReturnType<typeof createAcousticClassifier>,
  source: Int16Array,
  seconds: number,
  opts: { startMs?: number; from?: number } = {},
): AcousticObservation[] {
  const out: AcousticObservation[] = [];
  const frames = Math.round((seconds * SAMPLE_RATE) / 160);
  const base = opts.from ?? 0;
  for (let f = 0; f < frames; f++) {
    const frame = new Int16Array(160);
    for (let j = 0; j < 160; j++) frame[j] = source[(base + f * 160 + j) % source.length]!;
    const o = classifier.push(frame, (opts.startMs ?? 0) + f * 20);
    if (o) out.push(o);
  }
  return out;
}

const MUSIC = holdMusicPcm();

describe('emission cadence', () => {
  test('one observation per 250 ms of audio, and none before', () => {
    const c = createAcousticClassifier();
    assert.equal(feed(c, MUSIC, 0.24).length, 0);
    assert.equal(feed(c, MUSIC, 10).length, 40);
    assert.equal(EMIT_INTERVAL_MS, 250);
  });

  test('every observation carries its signals and window lengths (§6.4)', () => {
    const c = createAcousticClassifier();
    const first = feed(c, MUSIC, 0.3)[0]!;
    assert.deepEqual(first.windowsMs, { rms: 250, pauseRatio: 2000, spectralFlatness: 1000, autocorrelation: 20000 });
    assert.deepEqual(first.signalsAvailable, ['rms'], 'at 250 ms only the RMS window has enough audio');
    const later = feed(c, MUSIC, 25).at(-1)!;
    assert.deepEqual(later.signalsAvailable, ['rms', 'pauseRatio', 'spectralFlatness', 'autocorrelation']);
  });
});

describe('the three classes', () => {
  const last = (source: Int16Array, seconds = 25) => feed(createAcousticClassifier(), source, seconds).at(-1)!;

  test('hold music is PERIODIC', () => {
    const o = last(MUSIC);
    assert.equal(o.winner, 'PERIODIC');
    assert.ok(o.accepted && o.confidence > 0.8, `confidence ${o.confidence.toFixed(2)}`);
  });

  test('speech is SPEECH_LIKE', () => {
    const o = last(syntheticSpeech(25));
    assert.equal(o.winner, 'SPEECH_LIKE');
  });

  test('silence is SILENCE', () => {
    const o = last(silence(25));
    assert.equal(o.winner, 'SILENCE');
  });

  test('speech over continuous background music reads as PERIODIC — a stated limit, not a bug', () => {
    // The pause signal is the layer's strongest, and music under the speech
    // fills every pause. A representative talking over hold music therefore
    // reads as hold audio here; only the semantic layer (§6.2) can tell them
    // apart, which is the division of labor §6.1 describes.
    const speech = syntheticSpeech(25);
    const mixed = Int16Array.from(speech, (v, i) => v + Math.round(MUSIC[i % MUSIC.length]! * 0.2));
    assert.equal(last(mixed).winner, 'PERIODIC');
  });
});

describe('the provisional tier (§21 2.1: within 1.5 s of hold onset)', () => {
  test('hold audio starting after a conversation is called PERIODIC within 1.5 s', () => {
    const c = createAcousticClassifier();
    feed(c, syntheticSpeech(30), 30); // a conversation first: every window is full of speech
    const after = feed(c, MUSIC, 4, { startMs: 30_000 });
    const firstPeriodic = after.findIndex((o) => o.winner === 'PERIODIC');
    assert.ok(firstPeriodic >= 0, 'hold audio was never called PERIODIC');
    const ms = (firstPeriodic + 1) * EMIT_INTERVAL_MS;
    assert.ok(ms <= 1500, `PERIODIC after ${ms} ms of hold audio`);
  });

  test('that first PERIODIC is provisional: the 20 s window is still full of the conversation', () => {
    const c = createAcousticClassifier();
    feed(c, syntheticSpeech(30), 30);
    const first = feed(c, MUSIC, 4, { startMs: 30_000 }).find((o) => o.winner === 'PERIODIC')!;
    assert.equal(first.tier, 'provisional');
  });
});

describe('the confirmed tier requires autocorrelation (§6.1)', () => {
  test('music alone is provisional until the 20 s window is full, then confirmed', () => {
    const c = createAcousticClassifier();
    const early = feed(c, MUSIC, 19);
    assert.ok(early.every((o) => o.tier === 'provisional'), 'confirmed before the window was full');
    assert.ok(early.at(-1)!.winner === 'PERIODIC', 'and PERIODIC throughout');
    const late = feed(c, MUSIC, 6, { startMs: 19_000, from: 19 * SAMPLE_RATE });
    assert.equal(late.at(-1)!.tier, 'confirmed');
  });

  test('speech is never confirmed, however long it runs', () => {
    const os = feed(createAcousticClassifier(), syntheticSpeech(40), 40);
    assert.ok(os.every((o) => o.tier === 'provisional'));
  });

  test('confirmation needs the autocorrelation peak, not merely the window', () => {
    // Silence fills the window and has no loop: available, but no evidence.
    const o = feed(createAcousticClassifier(), silence(25), 25).at(-1)!;
    assert.ok(o.signalsAvailable.includes('autocorrelation'));
    assert.equal(o.tier, 'provisional');
  });
});

describe('what the tiers refuse to confirm', () => {
  test('a looping recorded announcement is periodic audio but still SPEECH_LIKE, so it is never confirmed', () => {
    // §10.5's mid-hold announcements, and the reason the tier checks the winner
    // and not just the autocorrelation peak: a recording that repeats every few
    // seconds has a loop, and is still speech.
    const clip = syntheticSpeech(8);
    const os = feed(createAcousticClassifier(), clip, 30); // looped: periodic by construction
    const o = os.at(-1)!;
    assert.equal(o.winner, 'SPEECH_LIKE');
    assert.ok(os.every((x) => x.tier === 'provisional'), 'a looping announcement was confirmed as hold audio');
  });
});

describe('weights are renormalized over the signals that exist (§6.4)', () => {
  test('the first observation, on RMS alone, is as confident as a later one', () => {
    const o = feed(createAcousticClassifier(), silence(1), 0.25)[0]!;
    assert.deepEqual(o.signalsAvailable, ['rms']);
    assert.equal(o.winner, 'SILENCE', 'RMS alone identifies silence');
    assert.ok(o.confidence > 0.9, `confidence ${o.confidence.toFixed(2)} — weights were not renormalized`);
  });

  test('a quarter second of loud audio is not silence, on RMS alone', () => {
    const o = feed(createAcousticClassifier(), MUSIC, 0.25)[0]!;
    assert.ok(o.scores.SILENCE < 0.1, `silence score ${o.scores.SILENCE.toFixed(2)}`);
  });
});

describe('UNKNOWN rather than a guess (§6.4)', () => {
  test('a winner below the minimum weight is not accepted', () => {
    const strict = createAcousticClassifier({ minWeight: 0.99 });
    const o = feed(strict, syntheticSpeech(25), 25).at(-1)!;
    assert.equal(o.accepted, false);
    assert.equal(o.winner, 'UNKNOWN');
    assert.ok(o.scores.SPEECH_LIKE > o.scores.PERIODIC, 'the scores are still reported');
  });
});

describe('the signal votes, at the measured values', () => {
  test('pause ratio: hold music 0.00 votes PERIODIC, speech 0.42 votes SPEECH_LIKE', () => {
    assert.ok(votePauseRatio(0.0).PERIODIC > 0.9);
    assert.ok(votePauseRatio(0.42).SPEECH_LIKE > 0.9);
  });

  test('spectral flatness: music 0.0015 votes PERIODIC, the quietest voice 0.0077 does not', () => {
    assert.ok(voteSpectralFlatness(0.0015).PERIODIC > 0.9);
    assert.ok(voteSpectralFlatness(0.0077).PERIODIC < 0.5, 'the five-fold gap is not treated as decisive');
    assert.ok(voteSpectralFlatness(0.1447).SPEECH_LIKE > 0.9);
  });

  test('autocorrelation: music 0.60 and DTMF 0.93 vote PERIODIC, speech 0.05 does not', () => {
    assert.ok(voteAutocorrelation(0.6).PERIODIC > 0.9);
    assert.ok(voteAutocorrelation(0.93).PERIODIC > 0.9);
    assert.ok(voteAutocorrelation(0.05).SPEECH_LIKE > 0.9);
  });
});

describe('against the rendered assets', () => {
  const rendered = fs.existsSync(path.join(ASSET_DIR, MANIFEST));
  const load = (id: LineId) => muLaw.decode(new Uint8Array(fs.readFileSync(path.join(ASSET_DIR, lineFile(id)))));

  test('every rendered line reads as speech, and none is confirmed as hold', { skip: rendered ? false : 'assets not rendered (pnpm render-assets); CI has no TTS' }, () => {
    for (const id of ['ivr_main_menu', 'rep1_greeting', 'rep2_greeting_um', 'rep1_approved', 'rep2_approved'] as LineId[]) {
      const os = feed(createAcousticClassifier(), load(id), 25);
      const o = os.at(-1)!;
      assert.equal(o.winner, 'SPEECH_LIKE', `${id} read as ${o.winner}`);
      assert.ok(os.every((x) => x.tier === 'provisional'), `${id} was confirmed as hold audio`);
    }
  });
});
