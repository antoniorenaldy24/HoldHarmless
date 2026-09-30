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
 * HOW THE VALUE WAS CHOSEN, and why it survived the ramp moving under it.
 *
 * It is taken from the FREE part of the curve: the largest margin that cuts
 * false closures without slowing hold detection at all. That is not an
 * operating-point decision — there is nothing to trade on the free part — and
 * it is why the margin is chosen here rather than put to the owner.
 *
 * The curve moved once. Swept first under the old pause ramp (0.10-0.30), the
 * free part ran from 0 to 0.05 and 0.06 was where onset started to rise. The
 * owner then moved the ramp to 0.02-0.06 (§6.7, 2026-09-30), and re-swept on
 * the classifier tests' own audio (`pnpm mic-check --sweep`) the curve is:
 *
 *     margin   rendered lines muting   hold onset
 *     0.00     22/23                   1750 ms     <- the tie problem above
 *     0.02      1/23                   1750 ms
 *     0.05      1/23                   1750 ms     <- chosen, unchanged
 *     0.08      1/23                   1750 ms
 *     0.10      1/23                   2000 ms     <- the trade starts here
 *     0.15      0/23                   2000 ms     <- CLASSIFIER_MARGIN
 *
 * The free part now runs from 0.02 to 0.08, and 0.05 is inside it, so it did
 * not move. Raising it to 0.15 would clear the last rendered line at 250 ms of
 * onset — a trade, so a decision — and the line in question is
 * `rep1_hold_cue`, "One moment please, let me look that up": a hold cue, on
 * which the semantic layer closes the gate anyway. Its acoustic mute costs
 * nothing a correct call would not already pay.
 *
 * (Two corrections kept visible. An early sweep read 1500 ms and named 0.08,
 * because it used a speech generator written for the sweep rather than the
 * tests'. And §6.7 once said the gap ramp took rendered mutes to zero; that
 * was measured at a margin of 0.15.)
 *
 * §6.7's own escape — "better signals, not a lower threshold" — was PROBED AND
 * FAILED here: requiring two signals to vote PERIODIC, rather than letting one
 * carry a weighted majority, bought exactly what the margin already bought.
 */
export const ACOUSTIC_MARGIN = 0.05;

export type AcousticOptions = {
  /** Below this the winner is UNKNOWN rather than a guess (§6.4). */
  minWeight?: number;
  /** How far the winner must lead the runner-up. `ACOUSTIC_MARGIN` by default. */
  margin?: number;
  /** `PAUSE_RAMP` by default. Exists so an alternative can be MEASURED; changing the default is §6.7's decision. */
  pauseRamp?: readonly [number, number];
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

/**
 * The pause-ratio ramp: at or below the first value a window votes fully
 * PERIODIC, at or above the second it votes not at all.
 *
 * A named constant and an option rather than two literals, because §6.7 leaves
 * its value to the project owner and the evidence for that choice has to be
 * producible by a tool (`pnpm human-calibration`, section 5) rather than by
 * editing this file and re-running.
 *
 * DECIDED 2026-09-30 by the project owner: 0.02-0.06, replacing 0.10-0.30, on
 * the evidence of their own voice. `votePauseRatio` carries why.
 */
export const PAUSE_RAMP: readonly [periodicAt: number, speechAt: number] = [0.02, 0.06];

export function votePauseRatio(ratio: number, rampAt: readonly [number, number] = PAUSE_RAMP): Vote {
  // What the ramp separates, measured over the 2 s sliding window this
  // classifier actually reads, on frames that contain speech:
  //
  //     the owner's voice   min 0.060   median 0.290   (364 windows, 93 takes)
  //     rendered speech     min 0.060   median 0.360   (166 windows)
  //     hold music          0.000 at every window
  //
  // The populations never meet: nothing lies between 0.000 and 0.060. §6.1's
  // recorded "speech 0.40-0.46" is a WHOLE-CLIP average, which this function
  // is never given, and the old ramp (0.10-0.30) was set against it — so it
  // sat inside the speech population and voted hold on ordinary sentences.
  //
  // WHY 0.02-0.06 (decided by the project owner, 2026-09-30, §6.7). On a human
  // voice the old ramp muted the agent on 16 of 93 takes and this one on none
  // (8 of 68 when the decision was taken; the rest of the takes arrived after).
  // Each mute costs two far-end turns of silence, because provisional
  // suspicion clears only on two HUMAN observations — the same mechanism A-27
  // prices at about 5.8 s on this voice. What was given up is hold-onset
  // speed: after a human conversation 1500 ms rather than 750, after rendered
  // speech 2250 rather than 2000 — and the old ramp was ALREADY past §21 2.1's
  // 1.5 s there, so the trade costs 250 ms in a column both options failed.
  // The speed only matters for a hold announced by nobody: a spoken cue closes
  // the gate semantically before the music starts.
  //
  // The rejected alternatives and why: 0.01-0.05 also mutes none but takes
  // onset after a human voice to 2000 ms; 0.05-0.10 is 250 ms faster but mutes
  // 2 of 93; raising the margin instead slows onset (ACOUSTIC_MARGIN); making
  // two signals agree was probed and bought nothing.
  //
  // THE RISK THAT CAME WITH IT: 0.06 is exactly the floor of the one human
  // voice measured. A speaker who pauses even less could fall under it, where
  // this vote turns partial. Flatness and rms still vote speech and the margin
  // still applies, so there is a cushion — but not from this signal. Re-run
  // `pnpm human-calibration` on the next voice.
  const periodic = ramp(ratio, rampAt[0], rampAt[1]);
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
  const pauseRamp = options.pauseRamp ?? PAUSE_RAMP;
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
        pauseRatio: votePauseRatio(values['pauseRatio']!, pauseRamp),
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
