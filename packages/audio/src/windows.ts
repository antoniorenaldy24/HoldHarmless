/**
 * Signal windows for the acoustic layer — §4.3 and §6.1.
 *
 * Window length and hysteresis count are different things; conflating them
 * produces a gate that appears fast and is not. These are the LENGTHS. The
 * counts live in the classifier.
 *
 *   RMS energy       250 ms   SILENCE versus signal present
 *   Pause ratio        2 s    hold audio has almost no pauses; speech has many
 *   Spectral flatness  1 s    music and tones have stable spectral structure
 *   Autocorrelation   20 s    hold music loops
 *
 * The 20-second window is the reason the confirmed tier is slow and the
 * provisional tier exists at all (ADR-007).
 */

import { SAMPLE_RATE } from './mulaw.js';

export const WINDOW_MS = {
  rms: 250,
  pauseRatio: 2_000,
  spectralFlatness: 1_000,
  autocorrelation: 20_000,
} as const;

export type SignalName = keyof typeof WINDOW_MS;

export interface SignalWindows {
  push(frame: Int16Array, atMs: number): void;
  rms(): number;
  pauseRatio(): number;
  spectralFlatness(): number;
  autocorrelationPeak(): number;
  windowsMs(): Record<string, number>;
  /** Only signals whose window is actually full — §6.4. */
  availability(): string[];
  reset(): void;
}

/** Below this RMS a 20 ms block counts as a pause. */
const PAUSE_RMS_THRESHOLD = 300;

export function createSignalWindows(sampleRate = SAMPLE_RATE): SignalWindows {
  const capacity = Math.round((sampleRate * WINDOW_MS.autocorrelation) / 1000);
  // One ring buffer sized to the longest window; every shorter signal reads a
  // suffix of it. Keeping four separate buffers would let them drift apart.
  const ring = new Int16Array(capacity);
  let written = 0;

  const tail = (ms: number): Int16Array => {
    const want = Math.min(Math.round((sampleRate * ms) / 1000), Math.min(written, capacity));
    const out = new Int16Array(want);
    for (let i = 0; i < want; i++) {
      out[i] = ring[(written - want + i) % capacity]!;
    }
    return out;
  };

  const have = (ms: number): boolean => written >= Math.round((sampleRate * ms) / 1000);

  const rmsOf = (xs: Int16Array): number => {
    if (xs.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < xs.length; i++) sum += xs[i]! * xs[i]!;
    return Math.sqrt(sum / xs.length);
  };

  return {
    push(frame: Int16Array): void {
      for (let i = 0; i < frame.length; i++) {
        ring[written % capacity] = frame[i]!;
        written++;
      }
    },

    rms(): number {
      return rmsOf(tail(WINDOW_MS.rms));
    },

    /** Fraction of 20 ms blocks whose energy is below the pause threshold. */
    pauseRatio(): number {
      const xs = tail(WINDOW_MS.pauseRatio);
      const block = Math.round(sampleRate * 0.02);
      if (xs.length < block) return 0;

      let pauses = 0;
      let blocks = 0;
      for (let off = 0; off + block <= xs.length; off += block) {
        blocks++;
        if (rmsOf(xs.subarray(off, off + block)) < PAUSE_RMS_THRESHOLD) pauses++;
      }
      return blocks === 0 ? 0 : pauses / blocks;
    },

    /**
     * Geometric mean over arithmetic mean of the power spectrum. Near 1 for
     * noise, near 0 for a tone or a pitched instrument — which is what makes it
     * separate hold music from speech.
     */
    spectralFlatness(): number {
      const xs = tail(WINDOW_MS.spectralFlatness);
      if (xs.length < 64) return 0;

      // 64 evenly spaced bins over the telephony band. A full FFT is not needed
      // for a ratio statistic, and 64 Goertzel-style evaluations are cheap.
      const bins = 64;
      const power: number[] = [];
      for (let b = 1; b <= bins; b++) {
        const freq = (b * (sampleRate / 2)) / (bins + 1);
        const omega = (2 * Math.PI * freq) / sampleRate;
        let re = 0;
        let im = 0;
        for (let i = 0; i < xs.length; i++) {
          re += xs[i]! * Math.cos(omega * i);
          im += xs[i]! * Math.sin(omega * i);
        }
        power.push((re * re + im * im) / xs.length + 1e-9);
      }

      const arithmetic = power.reduce((a, b) => a + b, 0) / power.length;
      const logMean = power.reduce((a, b) => a + Math.log(b), 0) / power.length;
      const geometric = Math.exp(logMean);
      return arithmetic === 0 ? 0 : geometric / arithmetic;
    },

    /**
     * Peak normalized autocorrelation at lags from 1 s to 10 s. Hold music
     * loops; conversation does not. This is the only signal that can CONFIRM
     * hold, and its 20-second window is why confirmation is slow (§6.1).
     */
    autocorrelationPeak(): number {
      const xs = tail(WINDOW_MS.autocorrelation);
      const minLag = sampleRate * 1;
      const maxLag = Math.min(sampleRate * 10, Math.floor(xs.length / 2));
      if (maxLag <= minLag) return 0;

      // Coarse lag steps: a music loop is periodic over seconds, so 100 ms
      // resolution finds it without evaluating every sample offset.
      const step = Math.round(sampleRate * 0.1);
      let energy = 0;
      for (let i = 0; i < xs.length; i++) energy += xs[i]! * xs[i]!;
      if (energy === 0) return 0;

      let best = 0;
      for (let lag = minLag; lag <= maxLag; lag += step) {
        let sum = 0;
        for (let i = 0; i + lag < xs.length; i++) sum += xs[i]! * xs[i + lag]!;
        best = Math.max(best, Math.abs(sum) / energy);
      }
      return best;
    },

    windowsMs(): Record<string, number> {
      return { ...WINDOW_MS };
    },

    availability(): string[] {
      return (Object.keys(WINDOW_MS) as SignalName[]).filter((name) => have(WINDOW_MS[name]));
    },

    reset(): void {
      ring.fill(0);
      written = 0;
    },
  };
}
