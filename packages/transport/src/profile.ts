/**
 * Network profiles — §4.5.
 *
 * Without deliberate delay the loopback link is effectively instantaneous, every
 * latency figure in §4.2 becomes fiction, and the jitter buffer has nothing to
 * buffer. The transport therefore applies a profile in both directions.
 *
 * Honesty boundary: these values model documented telephony behavior. They are
 * not a measurement of any specific network (§1.7).
 */

import type { NetworkProfileName } from '@holdharmless/events';

export type NetworkProfile = {
  oneWayDelayMs: number;
  /** Applied as +/- uniform per frame. */
  jitterMs: number;
  lossRate: number;
  reorderRate: number;
};

export const PROFILES: Record<NetworkProfileName, NetworkProfile> = {
  /** Unit tests only. A figure produced under CLEAN must never be reported (INV-16). */
  CLEAN: { oneWayDelayMs: 0, jitterMs: 0, lossRate: 0, reorderRate: 0 },
  /** Every measurement and the demo. */
  TELEPHONY: { oneWayDelayMs: 25, jitterMs: 8, lossRate: 0, reorderRate: 0 },
  /** Robustness runs — exercises the §4.4 fault paths. */
  DEGRADED: { oneWayDelayMs: 60, jitterMs: 25, lossRate: 0.01, reorderRate: 0 },
};

export function profileByName(name: NetworkProfileName): NetworkProfile {
  return PROFILES[name];
}
