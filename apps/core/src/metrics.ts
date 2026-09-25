/**
 * §16.3's log-derived metrics — module 4.2.
 *
 * §16 divides every metric in three ways, and the division is the point:
 *
 *   §16.2  measured AT THE HARNESS, because the core cannot observe its zero
 *          point, or because measuring a mechanism by that mechanism makes the
 *          number zero by construction (§16.1).
 *   §16.3  DERIVED FROM THE EVENT LOG, because every input is a recorded fact
 *          about what the core did.
 *   §16.4  the rest.
 *
 * Getting the division wrong does not fail loudly; it produces a metric that is
 * always zero and a panel that looks calm. Module 3.8 found one instance in the
 * other direction — `perceived_response_ms` being computed in the core, where
 * §16.1 forbids it. This file exists because module 4.2 found two in THIS
 * direction: `gate_false_close_count` and `party_detection_miss_count`, both
 * named by §16.3 as log derivations, were being read out of `harness.telemetry`,
 * which nothing sends. Panel 7 reported 0 for both, forever, and 0 is exactly
 * what a working system reports.
 *
 * WHY THESE TWO MAY BE MEASURED IN THE CORE, when §16.1 is so strict.
 * `false_speech_during_hold_count` may not be, because the gate is the mechanism
 * meant to prevent leakage and measuring at the gate makes it zero. These two
 * are different in kind: they count the gate and the party tracker doing exactly
 * what they were told, against a fact the log also records. Nothing here asks a
 * mechanism whether it worked — it asks what happened, and the log is the record
 * (ADR-012). `agent_mute_during_conversation_ms`, which is the DURATION of the
 * same episodes this file counts, stays at the harness: it is the cost of the
 * bias, and §16.2 is right that only someone who knows no hold occurred can
 * price it.
 */

import type { CallEvent } from '@holdharmless/events';

export type DerivedMetrics = {
  /**
   * §16.3: "Gate closed on `HOLD_CUE`, then reopened without the channel
   * reaching `HOLD`." The measured price of §6.3's deliberately eager list.
   */
  gateFalseCloseCount: number;
  /**
   * One entry per false close: how long the gate stayed shut. The core's own
   * view of the cost, which is NOT the §16.2 metric of the same idea — this
   * measures the gate, and §16.2 measures what the far end actually experienced.
   * Both are kept because a disagreement between them is informative.
   */
  falseCloseDurationsMs: number[];
  /**
   * §16.3: `semantic.observed(HOLD_CUE)` → `gate.changed(closed)`. How fast the
   * bias acts; the other half of what §6.3 costs.
   */
  holdCueToGateMs: number[];
  /**
   * §16.3: `parties_used − partiesDetected`. Above zero means the hedge carried
   * the call. `parties_used` is the harness's (ADR-018) and is passed in;
   * `partiesDetected` is the core's belief and comes from this log. Null when
   * the harness did not report a party count, because a miss count computed
   * against an assumed denominator would be a number that cannot fail.
   */
  partyDetectionMissCount: number | null;
  partiesDetected: number;
  /** §16.3: from `prompt.loaded` with `hedged: true`. */
  hedgeAppliedCount: number;
  /**
   * Cue-driven suspicions still unresolved when the log ended. Reported rather
   * than folded into either count: a call that ends mid-episode is evidence of
   * neither a false close nor a correct one, and silently counting it as either
   * would move the headline figure for a reason nobody could see.
   */
  unresolvedCueEpisodes: number;
};

/** Milliseconds between two events, from their ISO timestamps. */
const gap = (from: CallEvent, to: CallEvent): number =>
  new Date(to.at).getTime() - new Date(from.at).getTime();

export function derivedMetrics(log: readonly CallEvent[]): DerivedMetrics {
  let gateFalseCloseCount = 0;
  const falseCloseDurationsMs: number[] = [];
  const holdCueToGateMs: number[] = [];
  let partiesDetected = 1;
  let partiesUsed: number | null = null;
  let hedgeAppliedCount = 0;

  /**
   * The episode a cue phrase opens.
   *
   * It runs from `hold.suspected{trigger:'hold_cue'}` to `hold.cleared`, and the
   * REASON on that event decides whether anything is charged:
   *
   *   `hold_confirmed`   the channel reached `HOLD`; the cue was right.
   *   `human_confirmed`  §5.5 decided a person is still there; the cue was filler.
   *
   * §16.3 words the condition as "reopened without the channel reaching `HOLD`",
   * and the reason field is exactly that answer, recorded by the component that
   * knows: `setChannel` clears with `hold_confirmed` on the way into `HOLD`, and
   * `clear('human_confirmed')` only fires while the channel is NOT `HOLD`. A
   * separate `reachedHold` flag was carried here at first and could not be made
   * to fire on any well-formed log — it was dead, and this project treats dead
   * code as a defect rather than as insurance.
   *
   * A charge also requires that the gate actually shut during the episode: a cue
   * spoken while the gate was already closed (inside `HOLD` or `IVR`, where
   * ADR-007 closes it anyway) muted nobody, and counting it would pad the figure
   * with episodes that had no victim.
   */
  let episode: { cueAt: CallEvent; gateClosedAt: CallEvent | null } | null = null;
  /** The most recent HOLD_CUE observation, for `hold_cue_to_gate_ms`. */
  let lastHoldCueObs: CallEvent | null = null;

  for (const e of log) {
    switch (e.t) {
      case 'semantic.observed':
        // Only an ACCEPTED observation is evidence (§6.4) — the same rule
        // `suspicion.onSemantic` applies, and applying a different one here
        // would time a gate closure against an observation that never reached it.
        if (e.obs.accepted && e.obs.winner === 'HOLD_CUE') lastHoldCueObs = e;
        break;

      case 'hold.suspected':
        if (e.trigger === 'hold_cue') episode = { cueAt: e, gateClosedAt: null };
        break;

      case 'gate.changed':
        if (e.to === 'closed') {
          if (episode && episode.gateClosedAt === null) episode.gateClosedAt = e;
          if (lastHoldCueObs) {
            holdCueToGateMs.push(gap(lastHoldCueObs, e));
            lastHoldCueObs = null;
          }
        }
        break;

      case 'hold.cleared':
        if (episode) {
          if (e.reason === 'human_confirmed' && episode.gateClosedAt) {
            gateFalseCloseCount++;
            falseCloseDurationsMs.push(gap(episode.gateClosedAt, e));
          }
          episode = null;
        }
        break;

      case 'party.changed':
        partiesDetected = Math.max(partiesDetected, e.newIndex);
        break;

      case 'prompt.loaded':
        if (e.hedged) hedgeAppliedCount++;
        break;

      case 'harness.telemetry':
        // The DENOMINATOR is the harness's, and only the denominator (ADR-018).
        if (e.metric === 'parties_used') partiesUsed = Math.max(partiesUsed ?? 0, e.value);
        break;

      default:
        break;
    }
  }

  return {
    gateFalseCloseCount,
    falseCloseDurationsMs,
    holdCueToGateMs,
    partiesDetected,
    partyDetectionMissCount: partiesUsed === null ? null : Math.max(0, partiesUsed - partiesDetected),
    hedgeAppliedCount,
    unresolvedCueEpisodes: episode === null ? 0 : 1,
  };
}

/** p90 as §20 uses it: the value below which 90% of the samples fall. */
export function p90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]!;
}
