/**
 * Per-position configuration — §5.6 (policy) and §5.7 (silence recovery).
 *
 * TWO DELIBERATE DEPARTURES FROM THE §12.5 SKETCH, both resolving a conflict the
 * document has with itself in favor of the decision record:
 *
 *   1. No `gate` field. §12.5 lists one; ADR-007 says the gate "is never stored,
 *      never set by hand". A stored copy beside gateFor() is two sources for one
 *      fact, and INV-1 exists precisely because two sources drift. The gate is
 *      gateFor(channel, holdSuspected, navMode) and nothing else.
 *
 *   2. TOOL_ALLOWLIST is DERIVED from this table rather than declared beside it.
 *      §12.5 declares both; §8.7 says "the table lives in §5.6 as a column, so
 *      there is one source of truth". A second declaration is a second truth.
 */

import type { ClosingKind, ToolName } from '@holdharmless/events';
import { positionId, type PositionId } from './positions.js';

export type TranscriptionMode = 'min_latency' | 'balanced' | 'max_accuracy';

export type AfterLimit =
  | { kind: 'close'; cause: 'unresponsive' }
  | { kind: 'phase'; to: 'CLOSING'; closingKind: ClosingKind }
  | { kind: 'phase'; to: 'DONE' }
  /**
   * No further action: the channel's own timeout is the only exit. Used by HOLD
   * after its three ramp steps. It replaced 'hold_probe_once' in v1.3, when the
   * one spoken probe during hold was removed (§6.7): it fired where the gate is
   * always closed, and making it audible would have tied the gate to something
   * other than who is listening (ADR-007).
   */
  | { kind: 'await_timeout' };

export type PositionPolicy = {
  interruptResponse: boolean;
  /** Only where a mis-detection is most expensive (ADR-011). Omitted elsewhere. */
  interruptionDelayMs?: number;
  transcriptionMode: TranscriptionMode;
  /** Silence before the recovery action (§5.7). */
  silenceTimeoutMs?: number;
  /** HUMAN/EXCHANGE only: a shorter timeout while the party has not been told. */
  silenceTimeoutBeforeDisclosureMs?: number;
  rePromptLimit?: number;
  afterLimit?: AfterLimit;
  /** Phase timeout — the backstop for tool-driven transitions (§5.4). */
  phaseTimeoutMs?: number;
  tools: readonly ToolName[];
  /** The §5.7 action, as prose, for the dashboard and for failing checks. */
  silenceAction?: string;
};

const HUMAN_EXCHANGE_TOOLS = [
  'get_auth_request',
  'capture_auth_number',
  'capture_reference',
  'notify_transfer',
  'escalate_to_human',
] as const satisfies readonly ToolName[];

const HUMAN_READBACK_TOOLS = [
  'confirm_readback',
  'capture_reference',
  'notify_transfer',
  'escalate_to_human',
] as const satisfies readonly ToolName[];

const HUMAN_CLOSING_TOOLS = [
  'record_outcome',
  'capture_reference',
  'notify_transfer',
  'escalate_to_human',
] as const satisfies readonly ToolName[];

/**
 * §5.6 says HOLD and TRANSFER apply to "any" phase: policy there is channel-
 * driven because those channels preserve whatever phase was current. Expanded
 * into one row per phase, because the table is keyed by position.
 */
const holdPolicy: PositionPolicy = {
  interruptResponse: false,
  transcriptionMode: 'balanced',
  silenceTimeoutMs: 8000,
  rePromptLimit: 3,
  afterLimit: { kind: 'await_timeout' },
  tools: [],
  silenceAction: 'raise semantic sensitivity one step (max 3), then nothing until HOLD_TIMEOUT_MS',
};

/**
 * IVR, in EVERY phase — a correction to §5.6 and §18, found by search.
 *
 * §18 states "IVR with a later phase cannot occur: phase leaves NOT_STARTED only
 * when the channel becomes HUMAN". The reachability search in transitions.ts
 * shows otherwise: HUMAN -> HOLD -> IVR is a path through §5.3's own rows, and
 * INV-13 forbids the channel change from touching the phase. So a representative
 * who says "hold on" and lands the agent in another department's menu produces
 * IVR/EXCHANGE, IVR/READBACK or IVR/CLOSING — positions §5.6 had no row for.
 *
 * The fix is the reasoning §18 already applies to HOLD and TRANSFER: those
 * channels preserve whatever phase was current, so their policy is channel-driven.
 * IVR is the same kind of channel and gets the same treatment. The phase rides
 * along untouched and is resumed when a human answers.
 */
const ivrPolicy: PositionPolicy = {
  interruptResponse: false,
  transcriptionMode: 'min_latency',
  silenceTimeoutMs: 6000,
  rePromptLimit: 3,
  afterLimit: { kind: 'close', cause: 'unresponsive' },
  tools: ['send_dtmf'],
  silenceAction: 'repeat navigation',
};

/**
 * Any channel with phase DONE — also found by search.
 *
 * CLOSING -> DONE is produced by reply.done while a human is still on the line
 * (ADR-015), and the line stays open until the hangup completes. In that window
 * the channel can still move, so HUMAN/DONE, HOLD/DONE, IVR/DONE and
 * TRANSFER/DONE are all reachable, however briefly.
 *
 * The work is finished, so this policy does nothing: no tools, and above all no
 * silence recovery — a recovery timer here would have the agent start a new turn
 * on a call it has already closed. The exit is the ordinary `* -> CLOSED` row on
 * transport.closed, which the Call Model triggers by hanging up on entering DONE.
 */
const awaitingClosePolicy: PositionPolicy = {
  interruptResponse: false,
  transcriptionMode: 'balanced',
  tools: [],
};

const transferPolicy: PositionPolicy = {
  interruptResponse: false,
  transcriptionMode: 'balanced',
  silenceTimeoutMs: 4000,
  rePromptLimit: 1,
  afterLimit: { kind: 'close', cause: 'unresponsive' },
  tools: [],
  silenceAction: 'ask whether still connected',
};

export const POSITION_POLICY: Readonly<Partial<Record<PositionId, PositionPolicy>>> = {
  'DIALING/NOT_STARTED': {
    interruptResponse: false,
    transcriptionMode: 'balanced',
    tools: [],
  },

  'IVR/NOT_STARTED': ivrPolicy,
  'IVR/EXCHANGE': ivrPolicy,
  'IVR/READBACK': ivrPolicy,
  'IVR/CLOSING': ivrPolicy,
  'IVR/DONE': awaitingClosePolicy,

  'HOLD/NOT_STARTED': holdPolicy,
  'HOLD/EXCHANGE': holdPolicy,
  'HOLD/READBACK': holdPolicy,
  'HOLD/CLOSING': holdPolicy,
  'HOLD/DONE': awaitingClosePolicy,

  // No TRANSFER/NOT_STARTED. §5.6 says TRANSFER applies to "any" phase, but the
  // search shows NOT_STARTED is unreachable there: TRANSFER is entered only by
  // notify_transfer, a tool permitted only once a human is on the line, by which
  // time the phase has left NOT_STARTED. A row for an unreachable position is
  // not harmless — it is a claim that the position can occur.
  'TRANSFER/EXCHANGE': transferPolicy,
  'TRANSFER/READBACK': transferPolicy,
  'TRANSFER/CLOSING': transferPolicy,
  'TRANSFER/DONE': awaitingClosePolicy,

  'HUMAN/EXCHANGE': {
    interruptResponse: true,
    interruptionDelayMs: 700,
    transcriptionMode: 'max_accuracy',
    silenceTimeoutMs: 3000,
    silenceTimeoutBeforeDisclosureMs: 2500,
    rePromptLimit: 2,
    afterLimit: { kind: 'close', cause: 'unresponsive' },
    phaseTimeoutMs: 480_000,
    tools: HUMAN_EXCHANGE_TOOLS,
    silenceAction: 'deliver the opening (undisclosed) or offer the next item (disclosed)',
  },

  'HUMAN/READBACK': {
    interruptResponse: true,
    interruptionDelayMs: 800,
    transcriptionMode: 'max_accuracy',
    silenceTimeoutMs: 3000,
    rePromptLimit: 2,
    afterLimit: { kind: 'phase', to: 'CLOSING', closingKind: 'escalation' },
    phaseTimeoutMs: 180_000,
    tools: HUMAN_READBACK_TOOLS,
    silenceAction: 'repeat the read-back',
  },

  'HUMAN/CLOSING': {
    interruptResponse: true,
    transcriptionMode: 'balanced',
    silenceTimeoutMs: 2000,
    rePromptLimit: 2,
    afterLimit: { kind: 'phase', to: 'DONE' },
    phaseTimeoutMs: 120_000,
    tools: HUMAN_CLOSING_TOOLS,
    silenceAction: 'continue the closing sequence',
  },

  'HUMAN/DONE': awaitingClosePolicy,

  'CLOSED/DONE': {
    interruptResponse: false,
    transcriptionMode: 'balanced',
    tools: [],
  },
};

export function policyFor(id: PositionId): PositionPolicy | undefined {
  return POSITION_POLICY[id];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * What each tool does to the call model (§12.5). `none` means the tool's
 * side effects live elsewhere — record_outcome sets outcomeWritten and nothing
 * else, because if accepting it ended the call the agent would be past the
 * closing before it had spoken one (ADR-015).
 */
export const TOOL_EFFECT: Readonly<
  Record<ToolName, { channel?: 'TRANSFER'; phase?: 'READBACK' | 'CLOSING' | 'BY_ARGUMENT'; none?: true }>
> = {
  send_dtmf: { none: true },
  get_auth_request: { none: true },
  capture_reference: { none: true },
  record_outcome: { none: true },
  capture_auth_number: { phase: 'READBACK' },
  confirm_readback: { phase: 'BY_ARGUMENT' },
  notify_transfer: { channel: 'TRANSFER' },
  escalate_to_human: { phase: 'CLOSING' },
};

/** Derived, never declared — §8.7's one source of truth. */
export const TOOL_ALLOWLIST: Readonly<Partial<Record<PositionId, readonly ToolName[]>>> = Object.fromEntries(
  Object.entries(POSITION_POLICY).map(([id, policy]) => [id, policy!.tools]),
);

export function toolsAllowedAt(channel: Parameters<typeof positionId>[0], phase: Parameters<typeof positionId>[1]): readonly ToolName[] {
  return POSITION_POLICY[positionId(channel, phase)]?.tools ?? [];
}
