/**
 * The acoustic layer — §6.1, §6.4, interface in §12.4.
 *
 * Local, every 250 ms, no API cost. Answers one question in three classes:
 * SILENCE, PERIODIC, SPEECH_LIKE. It cannot tell a human from an IVR prompt —
 * both are speech — which is why §6.2 exists.
 *
 * THRESHOLDS ARE MEASURED, NOT CHOSEN. Every number below comes from running
 * the §6.1 signals over real audio: the harness's own hold music, the rendered
 * IVR and representative lines, DTMF tones, and silence (module 2.1).
 *
 *   source                    pause   flatness   autocorrelation
 *   hold music                0.000    0.0015          0.60
 *   DTMF tones                0.260    0.0095          0.93
 *   IVR menu                  0.430    0.1447          0.01
 *   representative lines      0.40-0.46  0.008-0.043   0.02-0.05
 *   silence                   1.000    1.0000          0.00
 *
 * Pause ratio separates hold audio from speech cleanly (0.00 against 0.40+).
 * Flatness separates them by a factor of five at best — the quietest rendered
 * voice measures 0.0077 against music's 0.0015 — so it is weighted below pause
 * ratio and read on a log scale. Autocorrelation is decisive but slow: its
 * window is 20 s, which is exactly why the provisional tier exists (ADR-007).
 */

import {
  WINDOW_MS,
  createSignalWindows,
  type SignalWindows,
} from '@holdharmless/audio';
import type { AcousticClass, AcousticObservation } from '@holdharmless/events';

export const EMIT_INTERVAL_MS = 250;

/** Below this RMS the window is silence, whatever the other signals say. */
export const SILENCE_RMS = 200;

/**
 * How much audio a signal needs before it is used at all, as a fraction of its
 * window. A partially filled window still measures something real; a pause
 * ratio over 1 s is a pause ratio. Autocorrelation is the exception: a loop
 * claim needs the whole 20 s, because a short window cannot tell a loop from a
 * long note. This is what lets the provisional tier fire within 1.5 s of hold
 * onset (§21 2.1) although its longest window is 2 s.
 */
export const MIN_FILL: Readonly<Record<string, number>> = {
  rms: 1,
  pauseRatio: 0.5,
  spectralFlatness: 0.5,
  autocorrelation: 1,
};

/** Relative weights, renormalized over whichever signals are available (§6.4). */
export const SIGNAL_WEIGHTS: Readonly<Record<string, number>> = {
  rms: 0.2,
  pauseRatio: 0.45,
  spectralFlatness: 0.2,
  autocorrelation: 0.15,
};

/** A PERIODIC winner is CONFIRMED only above this autocorrelation peak (§6.5). */
export const CONFIRM_AUTOCORRELATION = 0.30;

export type AcousticOptions = {
  /** Below this the winner is UNKNOWN rather than a guess (§6.4). */
  minWeight?: number;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  windows?: SignalWindows;
};

type Vote = Record<AcousticClass, number>;

const vote = (silence: number, periodic: number, speech: number): Vote => ({
  SILENCE: silence,
  PERIODIC: periodic,
  SPEECH_LIKE: speech,
});

/** Linear ramp from a (score 1) to b (score 0), clamped. */
function ramp(x: number, a: number, b: number): number {
  if (a === b) return x <= a ? 1 : 0;
  const t = (x - a) / (b - a);
  return Math.max(0, Math.min(1, 1 - t));
}

export function voteRms(rms: number): Vote {
  // Silence is the only thing loudness proves. Above the floor it says
  // "something is here" and splits its weight rather than guessing which.
  const silence = ramp(rms, SILENCE_RMS * 0.5, SILENCE_RMS * 1.5);
  return vote(silence, (1 - silence) / 2, (1 - silence) / 2);
}

export function votePauseRatio(ratio: number): Vote {
  // Measured: hold music 0.00, DTMF 0.26, speech 0.40-0.46, silence 1.00.
  const periodic = ramp(ratio, 0.10, 0.30);
  const silence = Math.max(0, (ratio - 0.8) / 0.2);
  return vote(silence, periodic * (1 - silence), (1 - periodic) * (1 - silence));
}

export function voteSpectralFlatness(flatness: number): Vote {
  // Read on a log scale: measured values span 0.0015 (music) to 1.0 (silence),
  // and the gap that matters — music against the quietest rendered voice — is a
  // factor of five, invisible on a linear one.
  const log = Math.log10(Math.max(flatness, 1e-6));
  const periodic = ramp(log, -2.6, -2.0);
  const silence = Math.max(0, Math.min(1, (log + 0.3) / 0.3));
  return vote(silence, periodic * (1 - silence), (1 - periodic) * (1 - silence));
}

export function voteAutocorrelation(peak: number): Vote {
  // Measured: hold music 0.60, DTMF 0.93, speech 0.01-0.05.
  const periodic = Math.max(0, Math.min(1, (peak - 0.15) / 0.25));
  return vote(0, periodic, 1 - periodic);
}

export interface AcousticClassifier {
  /** Returns an observation every EMIT_INTERVAL_MS of audio, else null. */
  push(frame: Int16Array, atMs: number): AcousticObservation | null;
  reset(): void;
}

export function createAcousticClassifier(options: AcousticOptions = {}): AcousticClassifier {
  const minWeight = options.minWeight ?? 0.5;
  const now = options.now ?? (() => new Date());
  const windows = options.windows ?? createSignalWindows();

  let samplesSinceEmit = 0;
  let fed = 0;
  const emitEvery = (8000 * EMIT_INTERVAL_MS) / 1000;

  const available = (): string[] => {
    const fedMs = (fed / 8000) * 1000;
    return Object.keys(WINDOW_MS).filter((name) => fedMs >= WINDOW_MS[name as keyof typeof WINDOW_MS] * MIN_FILL[name]!);
  };

  return {
    push(frame: Int16Array, atMs: number): AcousticObservation | null {
      windows.push(frame, atMs);
      fed += frame.length;
      samplesSinceEmit += frame.length;
      if (samplesSinceEmit < emitEvery) return null;
      samplesSinceEmit -= emitEvery;

      const signals = available();
      const values: Record<string, number> = {
        rms: windows.rms(),
        pauseRatio: windows.pauseRatio(),
        spectralFlatness: windows.spectralFlatness(),
        autocorrelation: windows.autocorrelationPeak(),
      };
      const votes: Record<string, Vote> = {
        rms: voteRms(values['rms']!),
        pauseRatio: votePauseRatio(values['pauseRatio']!),
        spectralFlatness: voteSpectralFlatness(values['spectralFlatness']!),
        autocorrelation: voteAutocorrelation(values['autocorrelation']!),
      };

      // Weights are renormalized over the signals that exist right now, so an
      // observation made on two signals is comparable with one made on four.
      const totalWeight = signals.reduce((sum, s) => sum + SIGNAL_WEIGHTS[s]!, 0);
      const scores = vote(0, 0, 0);
      for (const s of signals) {
        const w = SIGNAL_WEIGHTS[s]! / totalWeight;
        for (const k of Object.keys(scores) as AcousticClass[]) scores[k] += w * votes[s]![k];
      }

      const ranked = (Object.keys(scores) as AcousticClass[]).sort((a, b) => scores[b] - scores[a]);
      const top = ranked[0]!;
      const confidence = scores[top];
      const accepted = confidence >= minWeight;

      // The confirmed tier exists only where autocorrelation can back it (§6.1):
      // it is the difference between suspecting a hold and declaring one.
      const confirmed =
        signals.includes('autocorrelation') &&
        top === 'PERIODIC' &&
        values['autocorrelation']! >= CONFIRM_AUTOCORRELATION;

      return {
        at: now().toISOString(),
        seq: 0, // assigned by the core (§3.3 rule 4)
        scores: { ...scores },
        winner: accepted ? top : 'UNKNOWN',
        tier: confirmed ? 'confirmed' : 'provisional',
        confidence,
        signalsAvailable: signals,
        windowsMs: windows.windowsMs(),
        accepted,
      };
    },

    reset(): void {
      windows.reset();
      fed = 0;
      samplesSinceEmit = 0;
    },
  };
}
