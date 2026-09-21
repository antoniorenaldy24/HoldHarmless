/**
 * The transport contract — §12.3.
 *
 * This interface is the whole of §1.7's claim. `clear()` and `mark()` are on it
 * because a carrier platform requires them, not because loopback needs them —
 * which is why the loopback implementation honors them faithfully rather than
 * stubbing them out. `dial(endpoint, profile)` takes a string so a carrier
 * implementation can pass an E.164 number where this one passes a URL, and
 * nothing above the transport notices.
 *
 * ADR-002: no transport-specific concept appears above packages/transport.
 */

import type { GateIntent } from '@holdharmless/events';
import type { NetworkProfile } from './profile.js';

export type AudioSource = 'agent' | 'dtmf';
export type TransportCloseCause = 'far_end_hangup' | 'link_drop' | 'timeout';

export interface CallTransport {
  readonly kind: 'loopback' | 'twilio';

  /** endpoint is a harness URL for loopback, an E.164 number for a carrier. */
  dial(endpoint: string, profile: NetworkProfile): Promise<void>;

  /** Frames are dropped when the gate forbids them. Returns true when sent. */
  sendAudio(mulawFrame: Uint8Array, source: AudioSource): boolean;

  /** Empties the far-end playout queue; resolves with marks for discarded media. */
  clear(): Promise<string[]>;
  mark(name: string): Promise<void>;

  /**
   * Called by the Call Model only, with the derived value (ADR-007).
   *
   * CONTRACT: a transition from 'open' to anything else ALSO issues clear().
   * Closing the gate stops future frames; it does not stop what the far end has
   * already queued, and AssemblyAI emits reply.audio faster than real time, so
   * seconds of speech can be sitting in that queue (ADR-007, "Why layer 2 needs
   * clear"). Because this is guaranteed by the transport, the Call Model can
   * record `clearSent: true` on gate.changed without a return value to inspect.
   */
  applyGate(intent: GateIntent): void;
  gate(): GateIntent;

  hangup(): Promise<void>;

  onAudio(handler: (mulawFrame: Uint8Array) => void): void;
  onMark(handler: (name: string) => void): void;
  onFault(handler: (kind: string) => void): void;
  onClosed(handler: (cause: TransportCloseCause) => void): void;
}

/**
 * INV-2 in one function: which sources a gate admits.
 *
 *   open       agent yes, dtmf yes
 *   dtmf_only  agent no,  dtmf yes
 *   closed     agent no,  dtmf no
 *
 * Exhaustive over GateIntent — adding a fourth gate value is a compile error
 * here until someone decides what it admits.
 */
export function gateAdmits(intent: GateIntent, source: AudioSource): boolean {
  switch (intent) {
    case 'open':
      return true;
    case 'dtmf_only':
      return source === 'dtmf';
    case 'closed':
      return false;
  }
}

/** True when moving from `from` to `to` must flush agent audio already queued. */
export function gateTransitionRequiresClear(from: GateIntent, to: GateIntent): boolean {
  return gateAdmits(from, 'agent') && !gateAdmits(to, 'agent');
}
