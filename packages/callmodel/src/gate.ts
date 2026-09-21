/**
 * Gate derivation — ADR-007.
 *
 * `gateIntent` is a PURE FUNCTION of the channel dimension and the
 * hold-suspicion flag. It is never stored, never set by hand, and never depends
 * on how far the work has progressed. Whether the agent may be heard depends
 * entirely on who is listening, not on whether it is mid-greeting or
 * mid-read-back. Deriving it makes it impossible for the two to disagree, and
 * lets holdSuspected — the fast signal — dominate channel, the slow one, with no
 * procedural ordering to get wrong.
 *
 * Note that `phase` is not a parameter. That absence is the design.
 */

import type { Channel, GateIntent, NavMode } from '@holdharmless/events';
import { assertNever } from './positions.js';

export function gateFor(channel: Channel, holdSuspected: boolean, navMode: NavMode): GateIntent {
  // Suspicion dominates. It flips within a few hundred milliseconds of a hold
  // cue, while the channel waits for confirmation that can take twenty seconds
  // on the acoustic path. Binding the gate to confirmation alone would leave that
  // whole window open to the agent talking over hold audio.
  if (holdSuspected) return 'closed';

  switch (channel) {
    case 'HUMAN':
      return 'open';
    case 'IVR':
      return navMode === 'dtmf' ? 'dtmf_only' : 'open';
    case 'HOLD':
    case 'TRANSFER':
    case 'DIALING':
    case 'CLOSED':
      return 'closed';
    default:
      return assertNever(channel, 'channel');
  }
}
