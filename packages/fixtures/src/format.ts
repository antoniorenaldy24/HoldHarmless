/**
 * Fixture format — ADR-021, §12.8.
 *
 * A fixture is everything needed to re-run a call offline: the complete
 * AssemblyAI message stream in both directions, the audio in both directions,
 * the events the live run produced, and the network profile in force. All of it
 * on one timeline, in milliseconds from the start of recording.
 *
 * ONE DELIBERATE DEPARTURE FROM THE §12.8 SKETCH. §12.8 has `audio: Uint8Array[]`
 * beside `events: CallEvent[]`: audio with no timing. A classifier replayed on
 * that array could not be aligned with the session messages it arrived between,
 * which is the alignment calibration (§6.6) needs. Audio frames are therefore
 * timeline items like everything else; `audioFrames()` recovers the §12.8 view.
 */

import type { AuthRequest, AuthRequestStatus, CallEvent, NetworkProfileName } from '@holdharmless/events';

export const FIXTURE_FORMAT_VERSION = 1;

export type TimelineItem =
  /** AssemblyAI server -> client, verbatim (including reply.audio). */
  | { atMs: number; kind: 'server'; msg: Record<string, unknown> }
  /** Client -> AssemblyAI server, verbatim (including input.audio). */
  | { atMs: number; kind: 'client'; msg: Record<string, unknown> }
  /** μ-law frame received from the far end — what the agent heard. Base64. */
  | { atMs: number; kind: 'far_end_audio'; frame: string }
  /** μ-law frame sent to the far end — what the agent said, after the gate. Base64. */
  | { atMs: number; kind: 'agent_audio'; frame: string }
  /**
   * A pipeline timer that FIRED during the live run. `id` is the timer's arm
   * order (0, 1, 2, ...). Recorded because the wall clock is an input like any
   * other: if the event loop stalls, a message can be recorded after the moment
   * a timer was due and still be handled before it. A replay that recomputed
   * timer times from the timeline would then fire the timer first and diverge.
   * Recording when timers actually fired removes the guess.
   */
  | { atMs: number; kind: 'timer'; id: number };

export type GroundTruth = {
  partiesUsed: number;
  authNumber?: string;
  fieldsRequested: string[];
  expectedStatus: AuthRequestStatus;
};

export type Fixture = {
  formatVersion: typeof FIXTURE_FORMAT_VERSION;
  id: string;
  label: string;
  /** A fixture captured under CLEAN cannot be compared with one under TELEPHONY (§12.8, INV-16). */
  networkProfile: NetworkProfileName;
  recordedAt: string;
  /** Synthetic by INV-12, checked on save and on load. */
  request: AuthRequest;
  groundTruth: GroundTruth;
  timeline: TimelineItem[];
  /** The events the live run produced, in seq order. */
  events: CallEvent[];
};

export function audioFrames(fx: Fixture, kind: 'far_end_audio' | 'agent_audio' = 'far_end_audio'): Uint8Array[] {
  return fx.timeline.flatMap((i) => (i.kind === kind ? [Uint8Array.from(Buffer.from(i.frame, 'base64'))] : []));
}
