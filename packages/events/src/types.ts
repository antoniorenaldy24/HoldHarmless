/**
 * Shared entity and event types — SSOT §9.1 and §9.3.
 *
 * This package is the bottom of the dependency graph: it imports nothing and
 * everything imports it. That is deliberate, because §3.3 rule 4 makes the core
 * the only assigner of `seq`, and a type that several packages disagree about
 * would make that rule unenforceable.
 */

// ---------------------------------------------------------------------------
// The two call dimensions — §5.1
// ---------------------------------------------------------------------------

/** Who or what is on the line. Produced by audio evidence and transport events. */
export type Channel = 'DIALING' | 'IVR' | 'HOLD' | 'TRANSFER' | 'HUMAN' | 'CLOSED';

/** How far the work has progressed. Produced by tool calls and timers. */
export type Phase = 'NOT_STARTED' | 'EXCHANGE' | 'READBACK' | 'CLOSING' | 'DONE';

/** Which kind of ending the closing phase is performing. */
export type ClosingKind = 'wrapup' | 'escalation';

/** Derived, never stored — see gateFor() in packages/callmodel (ADR-007). */
export type GateIntent = 'open' | 'closed' | 'dtmf_only';

export type NavMode = 'dtmf' | 'speech';

export type NetworkProfileName = 'CLEAN' | 'TELEPHONY' | 'DEGRADED';

// ---------------------------------------------------------------------------
// Tools — §8.1
// ---------------------------------------------------------------------------

export type ToolName =
  | 'send_dtmf'
  | 'get_auth_request'
  | 'capture_auth_number'
  | 'confirm_readback'
  | 'notify_transfer'
  | 'capture_reference'
  | 'escalate_to_human'
  | 'record_outcome';

// ---------------------------------------------------------------------------
// Entities — §9.1
// ---------------------------------------------------------------------------

export type AuthRequestStatus =
  | 'queued'
  | 'in_progress'
  | 'approved'
  | 'denied'
  | 'pending_info'
  | 'escalated'          // final
  | 'escalated_resolved' // final; set by a human
  | 'failed';            // final after MAX_ATTEMPTS

export const FINAL_STATUSES = [
  'approved',
  'denied',
  'pending_info',
  'escalated',
  'escalated_resolved',
] as const satisfies readonly AuthRequestStatus[];

export type FinalStatus = (typeof FINAL_STATUSES)[number];

export function isFinalStatus(s: AuthRequestStatus): s is FinalStatus {
  return (FINAL_STATUSES as readonly AuthRequestStatus[]).includes(s);
}

/** Every AuthRequest must be synthetic, including in fixtures (`INV-12`). */
export type AuthRequest = {
  id: string;
  patientRef: string;          // synthetic pseudonym
  memberId: string;
  patientDob: string;          // ISO date
  cptCode: string;
  icdCode: string;
  providerNpi: string;
  serviceDate: string;         // ISO date
  payerId: string;
  /** Harness WebSocket URL. Where an E.164 number would sit in a carrier build. */
  payerEndpoint: string;
  clinicName: string;          // renders <CLINIC_NAME>
  clinicCallbackPhone: string; // renders <CLINIC_CALLBACK_PHONE>
  priority: 'routine' | 'expedited';
  /** <= 300 chars, validated once at record creation (ADR-016). */
  clinicalSummary: string;
  status: AuthRequestStatus;
  attempts: number;
  lastReference?: string;      // renders <LAST_REFERENCE>; survives across calls
};

export type Outcome = {
  status: Exclude<AuthRequestStatus, 'queued' | 'in_progress' | 'escalated_resolved'>;
  authNumber?: string;
  denialReason?: string;
  missingInfo?: string[];
  reference?: string;
  notes?: string;
};

export type Call = {
  id: string;
  requestId: string;
  transport: 'loopback';
  navMode: NavMode;
  networkProfile: NetworkProfileName;
  startedAt: string;
  endedAt?: string;

  channel: Channel;
  phase: Phase;
  closingKind?: ClosingKind;

  holdSuspected: boolean;
  /** epoch ms; the zero point for holdDurationMs (ADR-017) */
  holdSuspectedAt?: number;
  holdDurationMs: number;   // current segment only
  cumulativeHoldMs: number; // reporting only; never used in a decision
  humanChannelMs: number;   // accumulated HUMAN time; drives phase timeouts

  disclosedToCurrentParty: boolean;
  partiesDetected: number;      // internal estimate — compared, never trusted
  disclosuresDelivered: number; // from the §7.6 detector

  capturedAuthNumber?: string;
  readbackAttempts: number;     // written only by confirm_readback(matched:false)
  rePromptCounts: Record<string, number>; // keyed by position id
  holdRampSteps: number;        // capped at 3
  pendingContextCorrection: boolean;
  discardedToolResults: string[];

  sessionId?: string;
  outcomeWritten: boolean;
  billableSessionMs: number;
  outcome?: Outcome;
};

// ---------------------------------------------------------------------------
// Classifier observations — §9.2
// ---------------------------------------------------------------------------

export type AcousticClass = 'SILENCE' | 'PERIODIC' | 'SPEECH_LIKE';
export type SemanticClass = 'IVR_PROMPT' | 'HUMAN' | 'HOLD_CUE';

export type AcousticObservation = {
  at: string;
  seq: number;
  scores: Record<AcousticClass, number>;
  winner: AcousticClass | 'UNKNOWN';
  tier: 'provisional' | 'confirmed';
  confidence: number;
  signalsAvailable: string[];
  windowsMs: Record<string, number>;
  accepted: boolean;
};

export type SemanticObservation = {
  at: string;
  seq: number;
  scores: Record<SemanticClass, number>;
  winner: SemanticClass | 'UNKNOWN';
  confidence: number;
  /** after any hold ramp; never below MIN_WEIGHT_FLOOR (§6.7) */
  effectiveMinWeight: number;
  signalsAvailable: string[];
  sourceDelta: string;
  matchedPhrase?: string;
  transferHint?: boolean;
  accepted: boolean;
};

// ---------------------------------------------------------------------------
// Events — §9.3
// ---------------------------------------------------------------------------

/**
 * Every channel.changed and phase.changed names what produced it. That is what
 * makes INV-21 checkable, and it is why this is a closed tagged union rather
 * than a string: a transition invented in code without a table row in §5.3/§5.4
 * cannot name a producer, so it cannot compile.
 *
 * The `session` kind exists because the transition to DONE is produced by
 * reply.done — a producer class a tool-and-observation-only taxonomy would have
 * missed, and forcing that transition onto a tool is the mistake ADR-015 exists
 * to prevent.
 */
export type Producer =
  | { kind: 'acoustic'; seq: number }
  | { kind: 'semantic'; seq: number }
  | { kind: 'tool'; seq: number; name: ToolName }
  | { kind: 'timer'; name: string }
  | { kind: 'transport'; cause: string }
  | { kind: 'session'; event: 'reply.done' | 'session.ready' | 'session.resumed' };

export const PRODUCER_KINDS = [
  'acoustic',
  'semantic',
  'tool',
  'timer',
  'transport',
  'session',
] as const satisfies readonly Producer['kind'][];

export type DropCause = 'far_end_hangup' | 'link_drop' | 'timeout' | 'unresponsive';

export type SafetyViolationKind =
  | 'audio_during_hold'
  | 'auth_number_mismatch'
  | 'disclosure_skipped'
  | 'closing_before_outcome';

export type ToolRejectionReason = 'state_not_allowed' | 'validation_failed' | 'idempotent_replay';

export type TransportFaultKind =
  | 'malformed_frame'
  | 'jitter_overflow'
  | 'jitter_underflow'
  | 'playout_overflow';

/** What a reply may put on the line. ADR-022 condition 1 compares it to the gate. */
export type ReplyProduct = 'speech' | 'dtmf';

/**
 * ADR-022 condition 1, as §5.7's decision refined it: not "the gate is open"
 * but "the gate admits what the reply is permitted to produce".
 *
 * Its companion `gateFor` lives in `packages/callmodel`, and this one does not,
 * for a reason worth stating. THREE places must apply this rule — the session
 * that refuses a reply, INV-4 that audits the log, and the Call Model that
 * decides — and `events` is the only package all three already depend on. It
 * used to live inside the session, where INV-4 could not reach it, and INV-4
 * went on enforcing the rule this decision replaced: "the gate is open, with no
 * exceptions". An invariant that cannot see the rule it enforces enforces the
 * old one.
 */
export function gateAdmitsProduct(gate: GateIntent, produces: ReplyProduct): boolean {
  if (gate === 'open') return true;
  // The refinement in one line: DTMF passes a dtmf_only gate, speech does not.
  return gate === 'dtmf_only' && produces === 'dtmf';
}

export type CallEventBody =
  | { t: 'call.started'; requestId: string; attempts: number; priority: string; networkProfile: string }
  | { t: 'channel.changed'; from: Channel; to: Channel; producer: Producer }
  | { t: 'phase.changed'; from: Phase; to: Phase; producer: Producer; closingKind?: ClosingKind }
  | {
      t: 'gate.changed';
      from: GateIntent;
      to: GateIntent;
      channel: Channel;
      holdSuspected: boolean;
      clearSent: boolean;
      producer: Producer;
    }
  | {
      t: 'hold.suspected';
      trigger: 'hold_cue' | 'periodic_provisional' | 'notify_transfer' | 'reconnect';
      atMs: number;
    }
  | {
      /**
       * Added in v1.3. hold.suspected had no counterpart, so the moment §5.5
       * clears suspicion — HUMAN confirmed at N=2, or the channel confirming
       * HOLD — was recorded only as a side field of gate.changed. That made the
       * gate derivation's second input observable solely through the very event
       * INV-1 exists to audit: delete a gate.changed and its input vanished with
       * it, leaving a stale gate that looked consistent. Found by the INV-1
       * mutation test.
       */
      t: 'hold.cleared';
      reason: 'human_confirmed' | 'hold_confirmed' | 'reconnected';
    }
  | {
      t: 'prompt.loaded';
      files: string[];
      hedged: boolean;
      disclosureIncluded: boolean;
      substitutions: string[];
    }
  | {
      t: 'reply.requested';
      /**
       * 'hold_probe' was removed in v1.3 by decision (§6.7): it fired in HOLD,
       * where the gate is always closed, so it was billed and inaudible. Its
       * absence from this union is what now makes logging one impossible.
       */
      cause: 'silence_recovery' | 'escalation_instruction';
      instructions?: string;
      /**
       * What this reply is permitted to produce. Added in v1.3 with §5.7's
       * decision: ADR-022's first condition became "the gate admits what the
       * reply is permitted to produce", and IVR silence recovery is the case it
       * was refined for — a reply whose effect is a send_dtmf call, requested
       * while the gate is `dtmf_only`. Without this field INV-4 can only ask
       * whether the gate was open, which is the rule the decision replaced.
       */
      produces: ReplyProduct;
    }
  | { t: 'disclosure.delivered'; partyIndex: number; quote: string }
  | { t: 'party.changed'; reason: 'transfer' | 'long_hold' | 'ivr_return'; newIndex: number }
  | { t: 'acoustic.observed'; obs: AcousticObservation }
  | { t: 'semantic.observed'; obs: SemanticObservation }
  | { t: 'dtmf.sent'; digits: string; reason: string }
  | { t: 'dtmf.decoded'; digits: string; windowsUsed: number }
  | {
      t: 'turn.transcribed';
      speaker: 'agent' | 'far_end';
      text: string;
      partial: boolean;
      redactable: boolean;
      /** Not optional: the runtime half of the outcome-before-closing guarantee. */
      isClosing: boolean;
    }
  | { t: 'tool.called'; toolCallId: string; name: ToolName; args: unknown }
  | { t: 'tool.returned'; toolCallId: string; name: ToolName; result: unknown; latencyMs: number }
  | { t: 'tool.rejected'; toolCallId: string; name: ToolName; reason: ToolRejectionReason; detail: string }
  | { t: 'tool.result_discarded'; toolCallId: string; name: ToolName }
  | { t: 'auth_number.captured'; value: string; spokenForm?: string }
  | { t: 'auth_number.suspect'; value: string; detail: string }
  | { t: 'reference.captured'; reference: string; kind: string }
  | {
      t: 'outcome.written';
      writer: 'tool_handler' | 'call_model';
      status: AuthRequestStatus;
      skipped: boolean;
      reason?: string;
    }
  | {
      t: 'safety.violation';
      kind: SafetyViolationKind;
      detail: string;
      frameCount?: number;
      durationMs?: number;
      /**
       * Added in v1.3. INV-15 pairs a safety.violation with a tool.rejected "for
       * the same toolCallId", but the event had no such field, so the invariant
       * named a mechanism that could not exist (K-4).
       */
      toolCallId?: string;
    }
  | {
      /**
       * Added in v1.3. The context summary for an escalation, whoever wrote it.
       *
       * INV-9 accepts "a valid escalate_to_human call, OR a deterministic §8.6
       * summary" as evidence, and §8.1 says the summary "lives in the event log
       * keyed by callId". No event carried the deterministic one, so INV-9 could
       * only ever check half of what it names. Emitting one event for both paths
       * also gives panel 8 a single thing to read.
       */
      t: 'escalation.summary';
      source: 'model' | 'deterministic';
      urgency: 'EXPEDITED' | 'Routine';
      summary: string;
    }
  | {
      /**
       * Added in v1.3. INV-16 requires the network profile "in force" for every
       * transition and metric, and §19.3 can switch it mid-call. Derived from
       * call.started plus this event, rather than stamped onto every event —
       * the same reason the gate is derived rather than stored.
       */
      t: 'network.profile_changed';
      from: NetworkProfileName;
      to: NetworkProfileName;
    }
  | { t: 'invariant.violated'; id: string; detail: string }
  | { t: 'harness.telemetry'; metric: string; value: number; detail?: string }
  | { t: 'transport.fault'; kind: TransportFaultKind; count: number }
  | { t: 'hold.tick'; elapsedMs: number; rampStep: number }
  | { t: 'session.resumed'; sessionId: string; gapMs: number }
  /**
   * §15's beyond-window path: a NEW session replaced the old one, and the
   * conversation history did not carry over. Added in v1.3 when A-8 found that
   * resume is refused in every form tried, so this — not session.resumed — is
   * the event a real disconnect produces.
   */
  | { t: 'session.replaced'; previousSessionId: string; sessionId: string; gapMs: number; reason: string }
  | { t: 'call.dropped'; cause: DropCause }
  | { t: 'call.ended'; outcome: Outcome };

export type CallEvent = { seq: number; callId: string; at: string } & CallEventBody;

export type EventType = CallEventBody['t'];

/**
 * Written synchronously, because a crash between the state change and its record
 * would leave the log disagreeing with reality — and the log is the runtime
 * source of truth (ADR-012).
 */
export const SYNCHRONOUS_EVENTS = [
  'channel.changed',
  'phase.changed',
  'gate.changed',
  'outcome.written',
  'safety.violation',
] as const satisfies readonly EventType[];

export function isSynchronousEvent(t: EventType): boolean {
  return (SYNCHRONOUS_EVENTS as readonly EventType[]).includes(t);
}
