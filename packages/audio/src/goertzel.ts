/**
 * Goertzel filter bank for DTMF detection — ADR-013.
 *
 * The standard technique for detecting a small, known set of frequencies: it
 * evaluates a single DFT bin at a time, so eight bins cost eight cheap recursive
 * loops rather than a full transform. About sixty lines, no dependency.
 *
 * Two windows must agree before a digit is accepted. One window is enough to
 * detect a tone but not enough to distinguish a tone from a transient — and a
 * false digit sends the agent down the wrong IVR branch, which the re-prompt
 * limit in §5.7 will eventually catch but only after burning three attempts.
 */

import { muLaw, SAMPLE_RATE } from './mulaw.js';
import { LOW_TONES, HIGH_TONES, DTMF_KEYPAD } from './dtmf.js';

/** 40 ms at 8 kHz (§4.3). Long enough to resolve 697 Hz from 770 Hz. */
export const GOERTZEL_WINDOW_MS = 40;
export const WINDOW_SAMPLES = (SAMPLE_RATE * GOERTZEL_WINDOW_MS) / 1000;
export const CONSECUTIVE_REQUIRED = 2;
/** Half a window. See the note in push() for why the windows overlap. */
export const WINDOW_HOP_SAMPLES = WINDOW_SAMPLES / 2;

/**
 * A detected pair must stand clear of the background. Twice the mean energy of
 * the non-selected bins is a deliberately modest bar: the filter bank already
 * rejects everything outside its eight frequencies, so this guards against
 * broadband noise rather than against a competing tone.
 */
const MIN_RELATIVE_ENERGY = 2.0;
/** Absolute floor, so silence cannot produce a winner by ratio alone. */
const MIN_ABSOLUTE_ENERGY = 1e5;

/** Energy at one frequency over one block of samples. */
export function goertzelEnergy(samples: Int16Array, frequency: number, sampleRate = SAMPLE_RATE): number {
  const k = Math.round((samples.length * frequency) / sampleRate);
  const omega = (2 * Math.PI * k) / samples.length;
  const coeff = 2 * Math.cos(omega);

  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

export interface GoertzelDetector {
  /** Feed mu-law audio. Returns a digit once two consecutive windows agree. */
  push(frame: Uint8Array): string | null;
  reset(): void;
}

export function createGoertzelDetector(): GoertzelDetector {
  // Frames are 20 ms and the window is 40 ms, so samples are buffered across
  // frame boundaries rather than assuming one frame equals one window.
  let buffer: number[] = [];
  let candidate: string | null = null;
  let consecutive = 0;
  /** Prevents one long tone from decoding as a run of repeated digits. */
  let lastEmitted: string | null = null;

  function classify(window: Int16Array): string | null {
    const lowEnergies = LOW_TONES.map((f) => goertzelEnergy(window, f));
    const highEnergies = HIGH_TONES.map((f) => goertzelEnergy(window, f));

    const argmax = (xs: number[]) => xs.reduce((best, x, i) => (x > xs[best]! ? i : best), 0);
    const row = argmax(lowEnergies);
    const col = argmax(highEnergies);

    const rowEnergy = lowEnergies[row]!;
    const colEnergy = highEnergies[col]!;
    if (rowEnergy < MIN_ABSOLUTE_ENERGY || colEnergy < MIN_ABSOLUTE_ENERGY) return null;

    const others = [
      ...lowEnergies.filter((_, i) => i !== row),
      ...highEnergies.filter((_, i) => i !== col),
    ];
    const meanOther = others.reduce((a, b) => a + b, 0) / others.length;
    const weakest = Math.min(rowEnergy, colEnergy);
    if (meanOther > 0 && weakest / meanOther < MIN_RELATIVE_ENERGY) return null;

    return DTMF_KEYPAD[row]![col]!;
  }

  return {
    push(frame: Uint8Array): string | null {
      const pcm = muLaw.decode(frame);
      for (let i = 0; i < pcm.length; i++) buffer.push(pcm[i]!);

      let emitted: string | null = null;

      while (buffer.length >= WINDOW_SAMPLES) {
        const window = Int16Array.from(buffer.slice(0, WINDOW_SAMPLES));
        // Slide by half a window rather than consuming it whole. With disjoint
        // 40 ms blocks, a 50 ms gap can straddle two windows so that neither is
        // pure silence — the run never resets, and a repeated digit decodes as
        // one press. Overlapping guarantees a gap longer than the hop produces
        // at least one window that is entirely gap.
        buffer = buffer.slice(WINDOW_HOP_SAMPLES);

        const digit = classify(window);

        if (digit === null) {
          // A gap resets the run AND clears the guard, so the next press of the
          // same digit is a new digit rather than a suppressed repeat.
          candidate = null;
          consecutive = 0;
          lastEmitted = null;
          continue;
        }

        if (digit === candidate) {
          consecutive++;
        } else {
          candidate = digit;
          consecutive = 1;
        }

        if (consecutive >= CONSECUTIVE_REQUIRED && digit !== lastEmitted) {
          lastEmitted = digit;
          emitted = digit;
        }
      }

      return emitted;
    },

    reset(): void {
      buffer = [];
      candidate = null;
      consecutive = 0;
      lastEmitted = null;
    },
  };
}
