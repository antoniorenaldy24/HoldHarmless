/**
 * Tools, wired — module 4.0, reply half, step 4.
 *
 * The handler (module 3.1), the effects (3.6), read-back integrity (3.5), the
 * escalation coordinator (3.4) and the phase machine (3.2) were each built and
 * tested alone. Nothing connected a `tool.call` from the session to any of
 * them, so on a live call every tool the model called would have gone
 * unanswered — and a model waiting on a tool result says nothing.
 *
 * WHAT GOES WHERE, and the one decision in it:
 *
 *   session tool.call  → handler: authorize, validate, execute (§8.7 order)
 *   handler outcome    → session.queueToolResult (held until reply.done, §8.8)
 *   capture / confirm  → the call loop's phase machine → phase.changed → the
 *                        configurator moves the session to the new position
 *   notify_transfer    → suspicion (ADR-019) and the channel driver's
 *                        `HUMAN → TRANSFER` row. NOT the disclosure tracker
 *                        directly: the loop's tracker already resets the party
 *                        on the channel change, and telling it twice counts a
 *                        phantom party — which INV-7 then compares against.
 *   send_dtmf          → the Audio Bridge's DTMF queue, logged as dtmf.sent
 *   escalate_to_human  → the phase (CLOSING, escalation) and the coordinator,
 *                        which keeps or replaces the model's summary (§8.6)
 *   phase escalations  → the coordinator: tier 1 asks the model, if the gate
 *                        lets it speak; otherwise tier 2 writes it now
 *
 * The closing sequence — `record_outcome` before `[[CLOSING]]`, the closing
 * turn's reply.done producing DONE, and the hangup — is step 5.
 */

import type { ReplyCause, ReplyProduct } from '@holdharmless/agent';
import { gateAdmitsProduct, type AuthRequest, type ToolName } from '@holdharmless/events';
import type { PhaseMachine } from '@holdharmless/callmodel';
import type { AudioBridge } from './audio-bridge.js';
import type { CallLoop } from './call.js';
import { createToolEffects } from './effects.js';
import { createEscalationCoordinator, type EscalationCause, type EscalationCoordinator } from './escalation.js';
import type { EventLog } from './log.js';
import { createReadbackIntegrity } from './readback.js';
import { createToolHandlers, type ToolHandlers, type ToolOutcome } from './tools.js';
import type { WorkQueue } from './work-queue.js';

/** The part of `AgentSession` the tool path uses. */
export interface AgentTools {
  onToolCall(f: (callId: string, name: ToolName, args: unknown) => void): void;
  queueToolResult(callId: string, result: unknown, isError?: boolean): void;
  createReply(cause: ReplyCause, oneShotInstructions?: string, produces?: ReplyProduct): Promise<void>;
}

export type ToolLinkDeps = {
  session: AgentTools;
  loop: CallLoop;
  bridge: AudioBridge;
  log: EventLog;
  request: AuthRequest;
  queue: WorkQueue;
  /** What the far end said recently, for §8.2's sanity check after a capture. */
  farEndSpeech: () => string;
  now?: () => number;
};

export interface ToolLink {
  readonly handlers: ToolHandlers;
  readonly escalation: EscalationCoordinator;
  /** The phase machine's escalation causes, mapped to §8.6's. */
  onPhaseEscalation(cause: 'readback_limit' | 'readback_reprompt' | 'phase_timeout' | 'tool'): void;
  /** Every reply.done. A completed turn is what tier 2 waits one of. */
  onReplyDone(status: 'completed' | 'interrupted'): void;
  stop(): void;
}

/** What the model is told when a tool is refused: the reason, which it can act on (§8.5). */
export function resultMessage(out: ToolOutcome): { result: unknown; isError: boolean } {
  return out.ok ? { result: out.result, isError: false } : { result: { ok: false, error: out.reason }, isError: true };
}

export function connectTools(deps: ToolLinkDeps): ToolLink {
  const { session, loop, log, request } = deps;
  let stopped = false;
  /** True while a tool call is being handled — which is always INSIDE a reply. */
  let inToolCall = false;
  /**
   * The seq of the tool.called now being handled (§3.3 rule 4). The handler
   * writes tool.called first, so it is the log's length at that moment; every
   * transition the call produces names it.
   */
  let toolSeq = 0;
  /** The phase machine, with each tool's transition attributed to its call. */
  const phase: PhaseMachine = {
    get state() {
      return loop.phase.state;
    },
    onToolAccepted: (name, args) => loop.phase.onToolAccepted(name, args, toolSeq),
    onChannelChange: (to, cause) => loop.phase.onChannelChange(to, cause),
    onClosingTurnComplete: (status) => loop.phase.onClosingTurnComplete(status),
    addHumanTime: (ms) => loop.phase.addHumanTime(ms),
    onRecoveryLimit: () => loop.phase.onRecoveryLimit(),
    reset: () => loop.phase.reset(),
  };
  /** Tier 1's instruction, held until the reply that carried the tool call ends. */
  let deferred: string | null = null;

  const ask = (instruction: string): void => {
    // Refused anyway (another reply outstanding, the socket gone): tier 2, at once.
    session.createReply('escalation_instruction', instruction).catch(() => escalation.onTurnComplete());
  };
  // ADR-022 condition 1. Suspicion is not checked beside it: the gate is
  // DERIVED from suspicion (gateFor), so a suspected hold is a closed gate.
  const mayAsk = (): boolean => gateAdmitsProduct(loop.gate.gate, 'speech');

  const escalation = createEscalationCoordinator({
    request,
    log: () => log.events(),
    emit: (body) => log.append(body),
    requestModelSummary: (instruction) => {
      // Checked here as well as in the session: the coordinator must know NOW
      // whether tier 1 is possible, and a refusal the session reports later
      // cannot be answered with "write it yourself, immediately".
      if (!mayAsk()) return false;
      // The third failed read-back arrives as a TOOL CALL, inside the model's
      // reply — and the session refuses a reply while one is active (ADR-022's
      // third condition). Asked now, tier 1 would be refused every time and
      // tier 2 would always write the summary. So the request waits for the
      // reply that carried the tool call to end.
      if (inToolCall) {
        deferred = instruction;
        return true;
      }
      ask(instruction);
      return true;
    },
  });

  const effects = createToolEffects({
    request,
    queue: deps.queue,
    phase,
    emit: (body) => log.append(body),
    sendDtmf: (digits, reason) => {
      log.append({ t: 'dtmf.sent', digits, reason });
      void deps.bridge.sendDtmf(digits);
    },
    setChannel: (to) => {
      if (to !== 'TRANSFER') return;
      // ADR-019: the gate closes on the ANNOUNCEMENT, before the audio changes.
      loop.gate.onToolCall('notify_transfer', toolSeq);
      loop.channels.onNotifyTransfer(toolSeq);
    },
    escalate: (reason, contextSummary) => {
      phase.onToolAccepted('escalate_to_human', { reason });
      escalation.onModelSummary(contextSummary);
    },
  });

  const handlers = createToolHandlers({
    state: () => {
      const call = loop.snapshot();
      return { channel: call.channel, phase: call.phase, call, request };
    },
    effects,
    emit: (body) => log.append(body),
    readback: createReadbackIntegrity({ emit: (body) => log.append(body) }),
    farEndSpeech: deps.farEndSpeech,
    ...(deps.now ? { now: deps.now } : {}),
  });

  session.onToolCall((callId, name, args) => {
    if (stopped) return;
    inToolCall = true;
    toolSeq = log.length;
    try {
      const { result, isError } = resultMessage(handlers.handle(log.callId, callId, name, args));
      session.queueToolResult(callId, result, isError);
    } finally {
      inToolCall = false;
    }
  });

  const CAUSE: Readonly<Record<'readback_limit' | 'readback_reprompt' | 'phase_timeout', EscalationCause>> = {
    readback_limit: 'readback_limit',
    readback_reprompt: 'readback_reprompt',
    phase_timeout: 'exchange_timeout',
  };

  return {
    handlers,
    escalation,
    onPhaseEscalation(cause): void {
      // 'tool' is the model's own escalate_to_human: its summary arrives with
      // the call, and asking it to write one would be asking twice.
      if (stopped || cause === 'tool') return;
      escalation.begin(CAUSE[cause]);
    },
    onReplyDone(status): void {
      if (stopped) return;
      if (deferred !== null) {
        // The reply that carried the tool call has ended: tier 1 can be asked
        // now — if the gate still lets the agent speak. This reply.done is not
        // the turn tier 2 waits for; that is the NEXT one.
        const instruction = deferred;
        deferred = null;
        if (mayAsk()) ask(instruction);
        else escalation.onTurnComplete();
        return;
      }
      // An interrupted reply was not a turn the model got to finish.
      if (status !== 'completed') return;
      escalation.onTurnComplete();
    },
    stop(): void {
      stopped = true;
    },
  };
}
