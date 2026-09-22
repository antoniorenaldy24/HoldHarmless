/**
 * Hold music, generated rather than recorded — §10.2.
 *
 * "A looping music file ... deliberately loopable so the 20-second
 * autocorrelation signal has something real to detect." Generating it has
 * three advantages over a downloaded track: it is deterministic (the same bytes
 * every build, so a classifier regression is attributable), it carries no
 * licence, and its loop length is exactly known.
 *
 * TWO PROPERTIES THE CLASSIFIER DEPENDS ON, both got wrong in the first version
 * and found by measuring the signals of §6.1 against it (module 2.1):
 *
 *  1. **Continuous.** The first version was a plucked arpeggio whose notes
 *     decayed into silence, giving a pause ratio of 0.31 against speech's 0.43 —
 *     nearly no separation on the signal §6.1 leans on. Hold music is a
 *     sustained pad: it has almost no pauses, and that is the point. Measured
 *     after this change: 0.00.
 *  2. **A loop the autocorrelation window can see twice.** The first version
 *     looped every 16 s, while the 20 s window searches lags of 1-10 s; the
 *     loop was invisible and the peak came from the chord rhythm (0.21). The
 *     loop is now LOOP_SECONDS = 8, so a full 20 s window holds two and a half
 *     repetitions. Measured after this change: 0.60, against 0.01-0.05 for speech.
 *
 * The pad is built from whole numbers of cycles per chord, and every join —
 * including the loop's own — is cross-faded over 30 ms, so the music neither
 * clicks nor falls silent.
 */

import { SAMPLE_RATE, muLaw } from '@holdharmless/audio';

export const LOOP_SECONDS = 8;

/** Four chords, two seconds each. Frequencies are snapped to whole cycles. */
const CHORDS: readonly (readonly number[])[] = [
  [261.63, 329.63, 392.0], // C
  [220.0, 261.63, 329.63], // Am
  [174.61, 220.0, 261.63], // F
  [196.0, 246.94, 293.66], // G
];

export function holdMusicPcm(): Int16Array {
  const total = LOOP_SECONDS * SAMPLE_RATE;
  const out = new Float64Array(total);
  const chordSamples = total / CHORDS.length;
  const chordSeconds = LOOP_SECONDS / CHORDS.length;

  CHORDS.forEach((chord, c) => {
    const start = c * chordSamples;
    for (const f of chord) {
      // Snap each partial to a whole number of cycles within its chord slot, so
      // every chord — and the loop as a whole — ends where it began.
      const cycles = Math.round(f * chordSeconds);
      const freq = cycles / chordSeconds;
      for (let i = 0; i < chordSamples; i++) {
        const t = i / SAMPLE_RATE;
        // A gentle swell that never reaches zero: continuous audio, no pauses.
        const env = 0.75 + 0.25 * Math.sin((2 * Math.PI * t) / chordSeconds - Math.PI / 2);
        out[start + i]! += 0.22 * env * Math.sin(2 * Math.PI * freq * t);
        // An octave above, quieter: gives the spectrum structure to be flat about.
        out[start + i]! += 0.06 * env * Math.sin(4 * Math.PI * freq * t);
      }
    }
  });

  // Cross-fade every chord join over 30 ms — including the loop's own join,
  // where the last chord meets the first — so neither a chord change nor the
  // loop point is a click. Two 30 ms dips per 8 s do not register as pauses.
  const fade = Math.round(SAMPLE_RATE * 0.03);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    out[i]! *= k;
    out[total - fade + i]! *= 1 - k;
  }
  for (let c = 1; c < CHORDS.length; c++) {
    const at = c * chordSamples;
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      out[at + i]! *= k;
      out[at - fade + i]! *= 1 - k;
    }
  }

  return Int16Array.from(out, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 16384));
}

export function holdMusicMulaw(): Uint8Array {
  return muLaw.encode(holdMusicPcm());
}
