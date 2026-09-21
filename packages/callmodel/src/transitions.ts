/**
 * §5.3 and §5.4 as DATA.
 *
 * This is the reason §5 is two tables of producers rather than a diagram. A
 * model that enumerates transitions will always drift ahead of the mechanisms
 * that fire them, because drawing an arrow is easier than building the thing
 * that pulls it (K-6). Encoding every row with its producer makes three checks
 * mechanical rather than a matter of reading carefully:
 *
 *   INV-21  every transition names a producer from the closed set
 *   INV-17  every tool effect has a transition that produces it
 *   INV-11  every REACHABLE (channel, phase) pair has a defined exit — computed
 *           here by search over these rows, not listed by hand
 */

import type { Channel, ClosingKind, Phase, Producer, ToolName } from '@holdharmless/events';
import { positionId, type PositionId } from './positions.js';

export type ProducerKind = Producer['kind'];

export type ChannelTransition = {
  from: Channel | '*';
  to: Channel;
  producer: ProducerKind;
  /** When the producer is a tool, which one. */
  tool?: ToolName;
  /** The §5.3 wording, kept so a failing check can quote the row. */
  via: string;
};

export type PhaseTransition = {
  from: Phase | '*';
  to: Phase;
  producer: ProducerKind;
  tool?: ToolName;
  /** The channel this can fire in. Tools and reply.done only occur with a human. */
  inChannel?: Channel;
  closingKind?: ClosingKind;
  via: string;
};

// ---------------------------------------------------------------------------
// §5.3 — channel transitions. Phase is untouched by every row.
// ---------------------------------------------------------------------------

export const CHANNEL_TRANSITIONS: readonly ChannelTransition[] = [
  { from: 'DIALING', to: 'IVR', producer: 'transport', via: 'transport: link established' },
  { from: 'DIALING', to: 'CLOSED', producer: 'transport', via: 'transport: link refused or timed out' },

  { from: 'IVR', to: 'HUMAN', producer: 'semantic', via: 'semantic HUMAN, N=2' },
  { from: 'IVR', to: 'HOLD', producer: 'acoustic', via: 'acoustic PERIODIC confirmed' },
  { from: 'IVR', to: 'HOLD', producer: 'timer', via: 'HOLD_CUE + HOLD_CONFIRM_MS' },

  { from: 'HOLD', to: 'HUMAN', producer: 'semantic', via: 'semantic HUMAN, N=2' },
  { from: 'HOLD', to: 'IVR', producer: 'semantic', via: 'semantic IVR_PROMPT, N=2' },
  { from: 'HOLD', to: 'CLOSED', producer: 'timer', via: 'HOLD_TIMEOUT_MS' },

  { from: 'HUMAN', to: 'HOLD', producer: 'acoustic', via: 'acoustic PERIODIC confirmed' },
  { from: 'HUMAN', to: 'HOLD', producer: 'timer', via: 'HOLD_CUE + HOLD_CONFIRM_MS' },
  { from: 'HUMAN', to: 'TRANSFER', producer: 'tool', tool: 'notify_transfer', via: 'notify_transfer tool' },

  { from: 'TRANSFER', to: 'HUMAN', producer: 'semantic', via: 'semantic HUMAN, N=2' },
  { from: 'TRANSFER', to: 'HOLD', producer: 'acoustic', via: 'acoustic PERIODIC confirmed' },
  { from: 'TRANSFER', to: 'CLOSED', producer: 'timer', via: 'TRANSFER_TIMEOUT_MS' },

  { from: '*', to: 'CLOSED', producer: 'transport', via: 'transport.closed' },
  { from: '*', to: 'CLOSED', producer: 'timer', via: 're-prompt limit exhausted (§5.7)' },
];

// ---------------------------------------------------------------------------
// §5.4 — phase transitions.
// ---------------------------------------------------------------------------

export const PHASE_TRANSITIONS: readonly PhaseTransition[] = [
  {
    from: 'NOT_STARTED', to: 'EXCHANGE', producer: 'semantic', inChannel: 'HUMAN',
    via: 'channel became HUMAN for the first time',
  },
  {
    from: 'EXCHANGE', to: 'READBACK', producer: 'tool', tool: 'capture_auth_number', inChannel: 'HUMAN',
    via: 'capture_auth_number',
  },
  {
    from: 'READBACK', to: 'EXCHANGE', producer: 'tool', tool: 'confirm_readback', inChannel: 'HUMAN',
    via: 'confirm_readback(matched: false), readbackAttempts < 3',
  },
  {
    from: 'READBACK', to: 'CLOSING', producer: 'tool', tool: 'confirm_readback', inChannel: 'HUMAN',
    closingKind: 'wrapup', via: 'confirm_readback(matched: true)',
  },
  {
    from: '*', to: 'CLOSING', producer: 'tool', tool: 'escalate_to_human', inChannel: 'HUMAN',
    closingKind: 'escalation', via: 'escalate_to_human',
  },
  {
    from: 'READBACK', to: 'CLOSING', producer: 'timer', inChannel: 'HUMAN', closingKind: 'escalation',
    via: 'readbackAttempts reaches 3, or read-back re-prompt limit — deterministic fallback (§8.6 tier 2)',
  },
  {
    from: 'EXCHANGE', to: 'CLOSING', producer: 'timer', inChannel: 'HUMAN', closingKind: 'escalation',
    via: 'PHASE_TIMEOUT_EXCHANGE_MS of accumulated HUMAN time',
  },
  {
    from: 'CLOSING', to: 'DONE', producer: 'session', inChannel: 'HUMAN',
    via: "reply.done 'completed' on a closing-marked turn, with outcomeWritten",
  },
  {
    from: '*', to: 'DONE', producer: 'transport', inChannel: 'CLOSED',
    via: 'channel became CLOSED',
  },
];

// ---------------------------------------------------------------------------
// Atomic follow-ups.
//
// Two §5.4 rows fire in the SAME handler as a channel change, so the
// intermediate position is never a resting state and needs no policy of its own.
// Both are stated in the document; they are collected here because the search
// below must know about them, and because the Call Model must implement them
// atomically — if it ever did not, the intermediate would become reachable.
//
//   1. Entering HUMAN while NOT_STARTED -> EXCHANGE (§5.4 row 1; §5.5 "one
//      atomic operation"). This applies to EVERY entry into HUMAN, not only
//      IVR -> HUMAN: the most common path of all is IVR -> HOLD -> HUMAN, a queue
//      hold answered by a representative.
//   2. Entering CLOSED -> DONE (§5.4 "any -> DONE: channel became CLOSED").
// ---------------------------------------------------------------------------

export function settle(channel: Channel, phase: Phase): { channel: Channel; phase: Phase } {
  if (channel === 'HUMAN' && phase === 'NOT_STARTED') return { channel, phase: 'EXCHANGE' };
  if (channel === 'CLOSED') return { channel, phase: 'DONE' };
  return { channel, phase };
}

// ---------------------------------------------------------------------------
// Reachability — INV-11, evaluated over the cartesian product.
// ---------------------------------------------------------------------------

export type Edge = {
  from: PositionId;
  to: PositionId;
  kind: 'channel' | 'phase';
  producer: ProducerKind;
  via: string;
};

/** Every edge leaving a position, after atomic follow-ups are applied. */
export function edgesFrom(channel: Channel, phase: Phase): Edge[] {
  const here = positionId(channel, phase);
  const out: Edge[] = [];

  for (const t of CHANNEL_TRANSITIONS) {
    if (t.from !== '*' && t.from !== channel) continue;
    if (t.to === channel) continue;
    const next = settle(t.to, phase);
    out.push({ from: here, to: positionId(next.channel, next.phase), kind: 'channel', producer: t.producer, via: t.via });
  }

  for (const t of PHASE_TRANSITIONS) {
    if (t.from !== '*' && t.from !== phase) continue;
    if (t.inChannel !== undefined && t.inChannel !== channel) continue;
    // "any -> CLOSING" does not apply from NOT_STARTED: its producer is a tool,
    // and no tool that moves phase is permitted before a human is on the line.
    if (t.from === '*' && t.producer === 'tool' && phase === 'NOT_STARTED') continue;
    // A phase transition to where it already is changes nothing but closingKind.
    if (t.to === phase && t.closingKind === undefined) continue;
    const next = settle(channel, t.to);
    out.push({ from: here, to: positionId(next.channel, next.phase), kind: 'phase', producer: t.producer, via: t.via });
  }

  return out;
}

export const START: { channel: Channel; phase: Phase } = { channel: 'DIALING', phase: 'NOT_STARTED' };

/** Breadth-first search from the start position over both tables. */
export function reachablePositions(): Set<PositionId> {
  const seen = new Set<PositionId>([positionId(START.channel, START.phase)]);
  const queue: { channel: Channel; phase: Phase }[] = [START];

  while (queue.length > 0) {
    const { channel, phase } = queue.shift()!;
    for (const edge of edgesFrom(channel, phase)) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      const [c, p] = edge.to.split('/') as [Channel, Phase];
      queue.push({ channel: c, phase: p });
    }
  }
  return seen;
}

/** A terminal position is one with no way out. Only CLOSED/DONE may be terminal. */
export function deadEnds(): PositionId[] {
  return [...reachablePositions()].filter((id) => {
    if (id === 'CLOSED/DONE') return false;
    const [c, p] = id.split('/') as [Channel, Phase];
    return edgesFrom(c, p).filter((e) => e.to !== id).length === 0;
  });
}
