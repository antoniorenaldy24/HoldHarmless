/**
 * Hold music, generated rather than recorded — §10.2.
 *
 * "A looping music file ... deliberately loopable so the 20-second
 * autocorrelation signal has something real to detect." Generating it has
 * three advantages over a downloaded track: it is deterministic (the same
 * bytes every build, so a classifier regression is attributable), it carries no
 * licence, and its loop length is exactly known — which is the property the
 * autocorrelation signal (§6.3, 20 s window) keys on.
 *
 * Shape: a slow chord progression with a plucked arpeggio over it, all below
 * full scale. Tonal, periodic and speech-unlike, as hold music is. The loop is
 * LOOP_SECONDS long and each note decays to silence before the boundary, so the
 * loop point has no click.
 */

import { SAMPLE_RATE, muLaw } from '@holdharmless/audio';

export const LOOP_SECONDS = 16;

const CHORDS: readonly (readonly number[])[] = [
  [261.63, 329.63, 392.0], // C
  [220.0, 261.63, 329.63], // Am
  [174.61, 220.0, 261.63], // F
  [196.0, 246.94, 293.66], // G
];

export function holdMusicPcm(): Int16Array {
  const total = LOOP_SECONDS * SAMPLE_RATE;
  const out = new Float64Array(total);
  const chordSeconds = LOOP_SECONDS / CHORDS.length;
  const noteSeconds = chordSeconds / 8;

  CHORDS.forEach((chord, c) => {
    const chordStart = c * chordSeconds;
    // Pad: the chord held, with a slow swell and release inside its own slot.
    for (let i = 0; i < chordSeconds * SAMPLE_RATE; i++) {
      const t = i / SAMPLE_RATE;
      const env = Math.sin((Math.PI * t) / chordSeconds) ** 2;
      let v = 0;
      for (const f of chord) v += Math.sin(2 * Math.PI * f * t);
      out[Math.floor(chordStart * SAMPLE_RATE) + i]! += 0.08 * env * v;
    }
    // Arpeggio: eight plucked notes an octave up, each decaying within its slot.
    for (let n = 0; n < 8; n++) {
      const f = chord[n % chord.length]! * 2;
      const start = Math.floor((chordStart + n * noteSeconds) * SAMPLE_RATE);
      const len = Math.floor(noteSeconds * SAMPLE_RATE);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const env = Math.exp(-6 * t) * Math.min(1, i / 40) * (1 - i / len);
        out[start + i]! += 0.18 * env * Math.sin(2 * Math.PI * f * t);
      }
    }
  });

  return Int16Array.from(out, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 16384));
}

export function holdMusicMulaw(): Uint8Array {
  return muLaw.encode(holdMusicPcm());
}
