/**
 * What the eight panels show — §11, module 3.8.
 *
 * The dashboard holds no state and decides nothing (§11). Everything it draws
 * is derived here, from the event log, and this file is where that derivation
 * is tested. A panel that computed its own view would be a second opinion about
 * what happened on the call, and the log would stop being the source of truth
 * the moment the two disagreed.
 *
 * THE CHANNEL, PHASE AND GATE COME FROM `replay()`, the same function every
 * invariant is written against. That is deliberate and it is the whole argument
 * of panel 4: the gate timeline drawn over the channel timeline is only
 * evidence if it is the same derivation the checker audits. Two implementations
 * of "what was the gate at that moment" would eventually disagree, and the
 * panel would be showing the one nobody checks.
 *
 * REDACTION IS APPLIED HERE, not in the component. §19 asks for it to be on
 * during the presentation, and a mask applied at the edge of the screen is a
 * mask that the next component to be written will forget.
 */

import type {
  AcousticObservation,
  AuthRequest,
  CallEvent,
  Channel,
  ClosingKind,
  GateIntent,
  NetworkProfileName,
  Phase,
  SemanticObservation,
  ToolName,
  ToolRejectionReason,
} from '@holdharmless/events';
// The replay subpath, not the package root: the root reaches the transport
// package, which loads a Windows DLL, and this module is bundled for a browser.
import { replay } from '@holdharmless/invariants/replay';
import { escalationCards, type EscalationCard } from './escalation-tasks.js';

// Re-exported so the dashboard has one import for everything it draws, and so
// `@holdharmless/core/view` is a complete browser-safe surface on its own.
export type { EscalationCard };

export const REDACTED = '[redacted]';

export type DashboardOptions = {
  /** §19: masks turns the log flagged `redactable`. On during the demo. */
  redact: boolean;
  /** Requests for panel 1, in whatever order; this file sorts them. */
  requests: readonly AuthRequest[];
  /** Wall clock, for panel 2's elapsed timer. Injected so a test can hold it. */
  nowMs?: number;
};

/** One interval of a timeline. Panel 4 draws two of these on one axis. */
export type Span<T> = { value: T; fromMs: number; toMs: number | null; cause?: string };

export type ActiveCallPanel = {
  callId: string | null;
  channel: Channel;
  phase: Phase;
  closingKind?: ClosingKind;
  gate: GateIntent;
  holdSuspected: boolean;
  disclosedToCurrentParty: boolean;
  /** The CURRENT hold segment only (ADR-017), not the cumulative total. */
  holdSegmentMs: number;
  elapsedMs: number;
  profile: NetworkProfileName | null;
  ended: boolean;
};

export type TranscriptLine = {
  seq: number;
  atMs: number;
  speaker: 'agent' | 'far_end';
  text: string;
  partial: boolean;
  isClosing: boolean;
  redacted: boolean;
  /** The far end started speaking while the agent was mid-reply. */
  bargeIn: boolean;
};

export type ToolRow = {
  seq: number;
  toolCallId: string;
  name: ToolName;
  latencyMs: number | null;
  rejected: boolean;
  reason?: ToolRejectionReason;
  detail?: string;
  discarded: boolean;
};

export type CompliancePanel = {
  partiesDetected: number;
  disclosuresDelivered: number;
  disclosurePerParty: number[];
  overDisclosureCount: number;
  partyDetectionMissCount: number;
  gateFalseCloseCount: number;
  safetyViolations: { kind: string; detail: string }[];
  transportFaults: Record<string, number>;
  perceivedResponseMs: number[];
  billableSessionMinutes: number;
  invariantViolations: { id: string; detail: string }[];
};

export type ClassifierPanel = {
  acoustic: AcousticObservation | null;
  semantic: SemanticObservation | null;
  /** Set while a HOLD_CUE phrase is the reason the semantic layer fired. */
  holdCue: { phrase: string; transferHint: boolean; atMs: number } | null;
};

export type DashboardView = {
  profile: NetworkProfileName | null;
  queue: AuthRequest[];
  activeCall: ActiveCallPanel;
  classifier: ClassifierPanel;
  channelSpans: Span<Channel>[];
  gateSpans: Span<GateIntent>[];
  transcript: TranscriptLine[];
  tools: ToolRow[];
  compliance: CompliancePanel;
  escalations: EscalationCard[];
};

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** Expedited first, then by status: what to work on, top of the list. */
const QUEUE_ORDER: Record<string, number> = {
  in_progress: 0, queued: 1, escalated: 2, pending_info: 3,
  approved: 4, denied: 5, escalated_resolved: 6, failed: 7,
};

export function dashboardView(log: readonly CallEvent[], options: DashboardOptions): DashboardView {
  const states = replay(log);
  const startMs = log.length > 0 ? ms(log[0]!.at) : 0;
  const nowMs = options.nowMs ?? Date.now();
  const rel = (event: CallEvent) => ms(event.at) - startMs;

  const channelSpans: Span<Channel>[] = [];
  const gateSpans: Span<GateIntent>[] = [];
  const transcript: TranscriptLine[] = [];
  const toolsById = new Map<string, ToolRow>();
  const perceivedResponseMs: number[] = [];
  const transportFaults: Record<string, number> = {};
  const safetyViolations: { kind: string; detail: string }[] = [];
  const invariantViolations: { id: string; detail: string }[] = [];
  const disclosurePerParty: number[] = [];

  let acoustic: AcousticObservation | null = null;
  let semantic: SemanticObservation | null = null;
  let holdCue: ClassifierPanel['holdCue'] = null;
  let partiesDetected = 1;
  let overDisclosureCount = 0;
  let partyDetectionMissCount = 0;
  let gateFalseCloseCount = 0;
  let billableSessionMinutes = 0;
  let disclosedToCurrentParty = false;
  let closingKind: ClosingKind | undefined;
  let ended = false;
  let agentSpeaking = false;

  const openSpan = <T>(spans: Span<T>[], value: T, fromMs: number, cause?: string): void => {
    const last = spans[spans.length - 1];
    if (last && last.toMs === null) last.toMs = fromMs;
    if (last && last.value === value && last.toMs === fromMs) {
      // The same value resuming at the same instant is one span, not two: an
      // atomic group (§5.5) emits several events at one timestamp.
      last.toMs = null;
      return;
    }
    spans.push({ value, fromMs, toMs: null, ...(cause !== undefined ? { cause } : {}) });
  };

  for (const state of states) {
    const e = state.event;
    const atMs = rel(e);

    // The FIRST state carries the pre-call values, which is what opens both
    // timelines at their fail-safe defaults rather than at whatever came first.
    if (state.index === 0) {
      openSpan(channelSpans, state.channel, 0);
      openSpan(gateSpans, state.gate, 0);
    }

    switch (e.t) {
      case 'channel.changed':
        openSpan(channelSpans, e.to, atMs, e.producer.kind);
        break;
      case 'phase.changed':
        if (e.closingKind) closingKind = e.closingKind;
        break;
      case 'gate.changed':
        openSpan(gateSpans, e.to, atMs, e.producer.kind);
        break;
      case 'acoustic.observed':
        acoustic = e.obs;
        break;
      case 'semantic.observed':
        semantic = e.obs;
        if (e.obs.matchedPhrase !== undefined) {
          holdCue = { phrase: e.obs.matchedPhrase, transferHint: e.obs.transferHint === true, atMs };
        }
        break;
      case 'turn.transcribed': {
        // A far-end turn that lands while an agent turn is still partial is a
        // barge-in: §11 panel 5's marker, derived rather than flagged, because
        // the log records what happened and not what it meant.
        const bargeIn = e.speaker === 'far_end' && agentSpeaking;
        if (e.speaker === 'agent') agentSpeaking = e.partial;
        transcript.push({
          seq: e.seq,
          atMs,
          speaker: e.speaker,
          text: options.redact && e.redactable ? REDACTED : e.text,
          partial: e.partial,
          isClosing: e.isClosing,
          redacted: options.redact && e.redactable,
          bargeIn,
        });
        break;
      }
      case 'tool.called':
        toolsById.set(e.toolCallId, { seq: e.seq, toolCallId: e.toolCallId, name: e.name, latencyMs: null, rejected: false, discarded: false });
        break;
      case 'tool.returned': {
        const row = toolsById.get(e.toolCallId);
        if (row) row.latencyMs = e.latencyMs;
        break;
      }
      case 'tool.rejected': {
        const row = toolsById.get(e.toolCallId) ?? { seq: e.seq, toolCallId: e.toolCallId, name: e.name, latencyMs: null, rejected: false, discarded: false };
        row.rejected = true;
        row.reason = e.reason;
        row.detail = e.detail;
        toolsById.set(e.toolCallId, row);
        break;
      }
      case 'tool.result_discarded': {
        const row = toolsById.get(e.toolCallId);
        if (row) row.discarded = true;
        break;
      }
      case 'disclosure.delivered':
        disclosedToCurrentParty = true;
        disclosurePerParty[e.partyIndex - 1] = (disclosurePerParty[e.partyIndex - 1] ?? 0) + 1;
        if ((disclosurePerParty[e.partyIndex - 1] ?? 0) > 1) overDisclosureCount++;
        break;
      case 'party.changed':
        partiesDetected = Math.max(partiesDetected, e.newIndex);
        disclosedToCurrentParty = false;
        break;
      case 'safety.violation':
        safetyViolations.push({ kind: e.kind, detail: e.detail });
        break;
      case 'invariant.violated':
        invariantViolations.push({ id: e.id, detail: e.detail });
        break;
      case 'transport.fault':
        transportFaults[e.kind] = e.count;
        break;
      case 'harness.telemetry':
        if (e.metric === 'party_detection_miss_count') partyDetectionMissCount = e.value;
        if (e.metric === 'gate_false_close_count') gateFalseCloseCount = e.value;
        if (e.metric === 'billable_session_minutes') billableSessionMinutes = e.value;
        // NOT derived from this log. §16.1: a metric whose zero point the core
        // cannot observe is measured at the far end, and this one's zero point
        // is the moment the harness stopped playing the representative's line.
        // Computing it here from agent turns would produce a number that cannot
        // fail — which §16.1 says is not a metric.
        if (e.metric === 'perceived_response_ms') perceivedResponseMs.push(e.value);
        break;
      case 'call.ended':
      case 'call.dropped':
        ended = true;
        break;
      default:
        break;
    }
  }

  const last = states[states.length - 1];
  const endMs = log.length > 0 ? rel(log[log.length - 1]!) : 0;
  // A finished call's timelines stop at its last event; a live one runs to now.
  const edge = ended ? endMs : Math.max(endMs, nowMs - startMs);
  for (const spans of [channelSpans, gateSpans]) {
    const open = spans[spans.length - 1];
    if (open && open.toMs === null) open.toMs = edge;
  }

  // Read the same way channel, phase and gate are: `replay` reports the state
  // BEFORE each event, so taking the final entry's value misses what the final
  // event did — and the final event of a call that has just been answered is
  // precisely the one that ends the hold segment.
  const holdSegmentStartMs = lastHoldSegmentStart(states);

  return {
    profile: last?.profile ?? null,
    queue: [...options.requests].sort(
      (a, b) =>
        Number(b.priority === 'expedited') - Number(a.priority === 'expedited') ||
        (QUEUE_ORDER[a.status] ?? 9) - (QUEUE_ORDER[b.status] ?? 9) ||
        a.id.localeCompare(b.id),
    ),
    activeCall: {
      callId: log[0]?.callId ?? null,
      // `replay` reports the state BEFORE each event, so the final state is the
      // last entry's values with its own event applied — which is what the
      // event itself carries.
      channel: lastChannel(states),
      phase: lastPhase(states),
      ...(closingKind !== undefined ? { closingKind } : {}),
      gate: lastGate(states),
      holdSuspected: lastHoldSuspected(states),
      disclosedToCurrentParty,
      holdSegmentMs: holdSegmentStartMs === null ? 0 : Math.max(0, edge - (holdSegmentStartMs - startMs)),
      elapsedMs: edge,
      profile: last?.profile ?? null,
      ended,
    },
    classifier: { acoustic, semantic, holdCue },
    channelSpans,
    gateSpans,
    transcript,
    tools: [...toolsById.values()].sort((a, b) => a.seq - b.seq),
    compliance: {
      partiesDetected,
      disclosuresDelivered: disclosurePerParty.reduce((a, b) => a + (b ?? 0), 0),
      disclosurePerParty: [...disclosurePerParty].map((n) => n ?? 0),
      overDisclosureCount,
      partyDetectionMissCount,
      gateFalseCloseCount,
      safetyViolations,
      transportFaults,
      perceivedResponseMs,
      billableSessionMinutes,
      invariantViolations,
    },
    escalations: escalationCards(log, {
      statusOf: (requestId) => options.requests.find((r) => r.id === requestId)?.status,
    }),
  };
}

// `replay` gives the state BEFORE each event; the current state is that state
// with the last event applied. Reading it off the final event keeps one
// derivation rather than repeating replay's switch here.
function lastChannel(states: ReturnType<typeof replay>): Channel {
  for (let i = states.length - 1; i >= 0; i--) {
    const e = states[i]!.event;
    if (e.t === 'channel.changed') return e.to;
  }
  return states[states.length - 1]?.channel ?? 'DIALING';
}

function lastPhase(states: ReturnType<typeof replay>): Phase {
  for (let i = states.length - 1; i >= 0; i--) {
    const e = states[i]!.event;
    if (e.t === 'phase.changed') return e.to;
  }
  return states[states.length - 1]?.phase ?? 'NOT_STARTED';
}

function lastGate(states: ReturnType<typeof replay>): GateIntent {
  for (let i = states.length - 1; i >= 0; i--) {
    const e = states[i]!.event;
    if (e.t === 'gate.changed') return e.to;
  }
  return states[states.length - 1]?.gate ?? 'closed';
}

function lastHoldSegmentStart(states: ReturnType<typeof replay>): number | null {
  for (let i = states.length - 1; i >= 0; i--) {
    const e = states[i]!.event;
    // A person or a menu answering ends the segment (ADR-017).
    if (e.t === 'channel.changed' && (e.to === 'HUMAN' || e.to === 'IVR')) return null;
    if (e.t === 'hold.suspected') return e.atMs;
  }
  return states[states.length - 1]?.holdSegmentStartMs ?? null;
}

function lastHoldSuspected(states: ReturnType<typeof replay>): boolean {
  for (let i = states.length - 1; i >= 0; i--) {
    const e = states[i]!.event;
    if (e.t === 'hold.suspected') return true;
    if (e.t === 'hold.cleared') return false;
  }
  return false;
}
