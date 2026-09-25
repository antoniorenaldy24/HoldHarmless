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
 * THE PAUSE COLUMN ABOVE IS A WHOLE-CLIP AVERAGE, and this classifier never
 * sees a whole clip — it reads a 2 s sliding window. Re-measured over that
 * window in module 4.1, speech runs 0.060 to 0.73 (median 0.340) while hold
 * music is 0.000 at every window. So the ramp in `votePauseRatio` was set
 * against a statistic that is never computed, and sits inside the speech
 * population; that function records what the correction would cost and why the
 * operating point is the owner's to choose (§6.7).
 *
 * Pause ratio separates hold audio from speech cleanly (0.00 against 0.06+).
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

/**
 * How far the winner must lead the runner-up here. Measured, and deliberately
 * NOT the semantic layer's `CLASSIFIER_MARGIN` (0.15).
 *
 * This layer had no margin at all until module 4.1 — one bar, which §6.2 says
 * in as many words is not enough: "One bar would report a 0.46/0.45 split as a
 * decision." It did worse than that. 240 ms into a representative's line only
 * `rms` has filled its window, `voteRms` splits its weight 0.50/0.50 between
 * PERIODIC and SPEECH_LIKE because loudness cannot tell them apart, and the tie
 * broke toward PERIODIC because a stable sort puts it first. §6.5 sets
 * `holdSuspected` on ONE provisional PERIODIC, so the gate closed and the agent
 * went mute while the far end was still talking.
 *
 * The value is swept against every criterion this layer has at once: false
 * closures on the 23 rendered representative lines, the provisional tier's
 * 1.5 s requirement (§21 2.1) on hold audio following a conversation, and the
 * three class assertions that already existed. Audio is the classifier tests'
 * own — the generated hold music and their synthetic speech, so a number here
 * and a number in a test mean the same thing:
 *
 *     margin   false closures        hold onset   speech over music
 *     0.00     22/23 lines, 42 obs   1250 ms      PERIODIC   <- as built
 *     0.02     10/23, 20 obs         1250 ms      PERIODIC
 *     0.04      9/23, 15 obs         1250 ms      PERIODIC
 *     0.05      9/23, 15 obs         1250 ms      PERIODIC   <- chosen
 *     0.06      9/23, 15 obs         1750 ms      PERIODIC   <- §21 2.1 breaks here
 *     0.08      9/23, 15 obs         1750 ms      PERIODIC
 *     0.10      8/23, 13 obs         2000 ms      UNKNOWN
 *     0.15      6/23, 11 obs         2000 ms      UNKNOWN    <- CLASSIFIER_MARGIN
 *     0.20      5/23, 10 obs         2000 ms      UNKNOWN
 *
 * 0.05 is the largest value that costs nothing. Everything up to it cuts false
 * closures with hold onset unchanged at 1250 ms and every documented class
 * verdict intact; 0.06 is where the trade begins. So this is not the operating
 * point decision — it is the part of the curve where there is no decision to
 * make, and taking it is not a choice between criteria.
 *
 * (An earlier sweep here read 1500 ms and named 0.08. It used a speech
 * generator written for the sweep rather than the tests', and the tests caught
 * it. The table above is from the tests' own audio.)
 *
 * THE DECISION THAT REMAINS is the 9 lines out of 23 that still mute the agent
 * mid-sentence; `votePauseRatio` holds the numbers and §6.7 holds the rule that
 * the operating point is the owner's. §6.7 also names the way out — "better
 * signals, not a lower threshold" — and the obvious candidate was PROBED AND
 * FAILED: requiring two signals to vote PERIODIC, rather than letting one carry
 * a weighted majority, gives 9/23 and 1250 ms, exactly what the margin alone
 * already gives. It buys nothing here, so it is not offered as an answer.
 */
export const ACOUSTIC_MARGIN = 0.05;

export type AcousticOptions = {
  /** Below this the winner is UNKNOWN rather than a guess (§6.4). */
  minWeight?: number;
  /** How far the winner must lead the runner-up. `ACOUSTIC_MARGIN` by default. */
  margin?: number;
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
  // Measured: hold music 0.00, DTMF 0.26, speech 0.40-0.46, silence 1.00 —
  // and the speech figure there is a WHOLE-CLIP average, which is not what this
  // function is ever given. Re-measured in module 4.1 over the 2 s sliding
  // window the classifier actually reads, at 250 ms intervals, on frames that
  // contain speech, across every rendered asset (343 windows):
  //
  //     speech       min 0.060   p05 0.140   median 0.340   p75 0.446
  //     hold music   0.000 at all 27 windows — exactly zero, every time
  //
  // The two populations do not overlap: nothing at all lies between 0.000 and
  // 0.060. The ramp below (0.10 to 0.30) sits INSIDE the speech population —
  // 40.8% of speech windows draw a partial PERIODIC vote and 1.7% a full one.
  // Measured consequence, with the margin rule in place: 6 of 23 rendered
  // representative lines are classified PERIODIC mid-sentence, and §6.5 sets
  // `holdSuspected` on one such observation, so the gate closes and the agent
  // goes mute while the far end is still talking.
  //
  // THE RAMP IS NOT MOVED HERE, AND THAT IS DELIBERATE. Moving it to 0.01-0.05,
  // into the empty gap, takes all six false closures to zero — and breaks the
  // provisional tier's 1.5 s requirement (§21 2.1), because after a
  // conversation the first 2 s window of hold music is still part speech and no
  // longer clears the lower bar. Both were measured. This is §6.7's shape
  // exactly — "one lever, two opposing criteria" — and §6.7's own rule applies:
  // "The operating point is a written decision, not an emergent one." So it is
  // left to the project owner, with both numbers on the table:
  //
  //     ramp 0.10-0.30 (this one)   6/23 lines mute the agent   hold onset ≤1.5 s
  //     ramp 0.01-0.05              0/23                        hold onset >1.5 s
  //
  // §6.7 also names the way out of the trade: "If A-5 cannot be met at that
  // value, the correct response is better signals, not a lower threshold." The
  // candidate is in the same data — across all 23 lines, spectral flatness and
  // autocorrelation stayed on the speech side of the gap at EVERY observation,
  // and only pause ratio crossed. A PERIODIC that required two signals to agree
  // rather than a weighted majority one signal can carry would take both
  // criteria at once. That is a change to the voting scheme, not a threshold,
  // and it belongs in its own module with its own measurement.
  //
  // Whichever is chosen, it is chosen on rendered audio until §6.6's recordings
  // exist. `pnpm mic-check --file` re-runs all of it on a human voice.
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
  const margin = options.margin ?? ACOUSTIC_MARGIN;
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
      const runnerUp = ranked[1]!;
      const confidence = scores[top];
      // TWO BARS, as the semantic layer has had since module 2.2. `ACOUSTIC_MARGIN`
      // carries the measurement and why this layer's value is its own.
      const accepted = confidence >= minWeight && confidence - scores[runnerUp] >= margin;

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
