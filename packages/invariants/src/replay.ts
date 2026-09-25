/**
 * Replay — the state the log implies at each event.
 *
 * Its own module, and not because runtime.ts was long. Every invariant is
 * written against this function, and so is the dashboard: panel 4 draws the
 * gate timeline over the channel timeline, and that is only evidence if it is
 * the SAME derivation the checker audits. Two implementations would eventually
 * disagree and the panel would be showing the one nobody checks.
 *
 * Which means this file has to be importable from a browser. `runtime.ts`
 * reaches the transport package for two gate helpers, and the transport package
 * loads a Windows DLL through `node:module` — so a dashboard importing the
 * checker would drag koffi into the bundle. The split keeps one derivation and
 * one import graph each.
 */

import type { CallEvent, Channel, GateIntent, NetworkProfileName, Phase } from '@holdharmless/events';

// ---------------------------------------------------------------------------
// Replay: the state implied by the log at each event.
// ---------------------------------------------------------------------------

export type ReplayState = {
  index: number;
  event: CallEvent;
  /** State BEFORE this event is applied. */
  channel: Channel;
  phase: Phase;
  gate: GateIntent;
  holdSuspected: boolean;
  /**
   * When the current hold SEGMENT began — the zero point for holdDurationMs
   * (ADR-017). Distinct from holdSuspected: suspicion clears when HOLD is
   * confirmed, but the segment runs until a person or a menu answers.
   */
  holdSegmentStartMs: number | null;
  profile: NetworkProfileName | null;
};

export function replay(log: readonly CallEvent[]): ReplayState[] {
  let channel: Channel = 'DIALING';
  let phase: Phase = 'NOT_STARTED';
  // Matches the transport's fail-safe default: nothing is heard until the Call
  // Model derives an open gate.
  let gate: GateIntent = 'closed';
  let holdSuspected = false;
  let holdSegmentStartMs: number | null = null;
  let profile: NetworkProfileName | null = null;

  const out: ReplayState[] = [];
  log.forEach((event, index) => {
    out.push({ index, event, channel, phase, gate, holdSuspected, holdSegmentStartMs, profile });
    switch (event.t) {
      case 'call.started':
        profile = event.networkProfile as NetworkProfileName;
        break;
      case 'network.profile_changed':
        profile = event.to;
        break;
      case 'channel.changed':
        channel = event.to;
        // A person or a menu answering ends the hold segment.
        if (event.to === 'HUMAN' || event.to === 'IVR') holdSegmentStartMs = null;
        break;
      case 'phase.changed':
        phase = event.to;
        break;
      case 'gate.changed':
        // Deliberately does NOT update holdSuspected. That flag has one source in
        // the log — hold.suspected / hold.cleared — and INV-1 checks each
        // gate.changed against it, rather than letting the audited event define
        // the input it is audited against.
        gate = event.to;
        break;
      case 'hold.suspected':
        holdSuspected = true;
        holdSegmentStartMs ??= event.atMs;
        break;
      case 'hold.cleared':
        holdSuspected = false;
        break;
      default:
        break;
    }
  });
  return out;
}

