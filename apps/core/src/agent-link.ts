/**
 * The media path between the far end and the agent — module 4.0, reply half,
 * step 2.
 *
 * `startCallLoop` hears the far end and drives the gate. This connects the other
 * party in the conversation: the AssemblyAI session. Everything it wires is a
 * rule already written somewhere, and each is named where it is applied:
 *
 *   far end  ──audio──►  session            (every frame; the agent must hear it all)
 *   session  ──audio──►  Audio Bridge       (paced, gated — §4, ADR-007)
 *   session  ──text───►  semantic layer     (deltas, and turn ends: the latch, §6.8)
 *   session  ──events─►  interruption       (§3's two remaining clear triggers)
 *   gate     ──state──►  session guard      (ADR-022: read at every createReply)
 *   position ──update─►  session            (prompt + policy per position — step 3)
 *   agent    ──turns──►  disclosure tracker (§7.6: set by observation only)
 *
 * What this does NOT do yet: handle tools — step 4 — or close the call — step
 * 5. A call wired with this knows what to say at every position and hears and
 * speaks under the gate; it cannot yet act on what it hears.
 */

import type { ReplyGuardState, SessionConfig } from '@holdharmless/agent';
import type { ChannelTimers } from '@holdharmless/callmodel';
import type { CallTransport } from '@holdharmless/transport';
import type { AuthRequest, NavMode, NetworkProfileName } from '@holdharmless/events';
import { createAudioBridge, type AudioBridge, type AudioBridgeOptions } from './audio-bridge.js';
import { startCallLoop, type CallLoop, type TranscriptSource } from './call.js';
import type { EventLog } from './log.js';
import { createConfigurator, positionConfig, type Configurator, type PositionInputs } from './position-config.js';
import { createClosingSequence, type CallEnd, type ClosingSequence } from './closing.js';
import { connectTools, type AgentTools, type ToolLink } from './tool-link.js';
import type { WorkQueue } from './work-queue.js';

/**
 * The part of `AgentSession` this file uses, and nothing more. Structural, so a
 * test can stand in for the real session without a socket — and so it is visible
 * at a glance which of the session's surfaces the media path depends on.
 */
export interface AgentMedia extends AgentTools {
  sendAudio(mulawFrame: Uint8Array): void;
  onTranscriptDelta(f: (text: string) => void): void;
  onTurn(f: (speaker: 'agent' | 'far_end', text: string, isClosing: boolean) => void): void;
  onSpeechStarted(f: () => void): void;
  onReplyAudio(f: (bytes: Uint8Array) => void): void;
  onReplyStarted(f: () => void): void;
  onReplyDone(f: (status: 'completed' | 'interrupted') => void): void;
  /** Mutable fields only; resolves on session.updated (§7.1). */
  update(config: Partial<SessionConfig>): Promise<void>;
  /** session.end, then close — never a bare close (§15). */
  end(): Promise<void>;
}

/**
 * The session's far-end transcripts, as the call loop wants them.
 *
 * `transcript.user.delta` carries deltas and `transcript.user` closes the turn
 * (§7.1). The turn end is not optional: without it the semantic layer's buffer
 * never clears and one cue phrase mutes the agent for the rest of the call.
 */
export function sessionTranscripts(session: AgentMedia, nowMs: () => number): TranscriptSource {
  return {
    onFarEndDelta(h) {
      session.onTranscriptDelta((text) => h(text, nowMs()));
    },
    onFarEndTurnEnd(h) {
      session.onTurn((speaker, text) => {
        if (speaker === 'far_end') h(text, nowMs());
      });
    },
  };
}

export type CallDeps = {
  request: AuthRequest;
  /** Where record_outcome writes (INV-18 is enforced there). Must hold `request`. */
  queue: WorkQueue;
  log: EventLog;
  transport: CallTransport;
  navMode: NavMode;
  networkProfile: NetworkProfileName;
  /**
   * Builds the session, given the guard it must consult. A factory rather than
   * a session because of an ordering knot: the session's guard reads the gate,
   * the gate lives in the call loop, and the call loop reads the session's
   * transcripts. The factory is called once the guard can be answered.
   */
  createSession: (guard: () => ReplyGuardState, isClosing: () => boolean) => AgentMedia;
  nowMs?: () => number;
  epochMs?: () => number;
  timers?: ChannelTimers;
  bridge?: Omit<AudioBridgeOptions, 'transport'>;
  /** A session.update the server refused. The call carries on; this must be seen. */
  onFault?: (err: unknown) => void;
  /** Where the configurator's coalesced work runs; `queueMicrotask` by default. */
  defer?: (fn: () => void) => void;
};

export interface Call {
  readonly loop: CallLoop;
  readonly bridge: AudioBridge;
  readonly session: AgentMedia;
  readonly configurator: Configurator;
  readonly tools: ToolLink;
  readonly closing: ClosingSequence;
  /** Resolves when the line has closed and the call's end is fully written. */
  readonly finished: Promise<CallEnd>;
  stop(): void;
}

/** How many completed far-end turns §8.2's sanity check looks back over. */
const RECENT_FAR_END_TURNS = 3;

export function startCall(deps: CallDeps): Call {
  const t0 = Date.now();
  const nowMs = deps.nowMs ?? (() => Date.now() - t0);
  const bridge = createAudioBridge({ transport: deps.transport, ...deps.bridge });

  // The knot, untied: the guard reads a loop that exists by the time any reply
  // can be requested. Until then it answers with the transport's fail-safe
  // default — a closed gate — so nothing can be said before the call is wired.
  let loop: CallLoop | null = null;
  const guard = (): ReplyGuardState =>
    loop ? { gateIntent: loop.gate.gate, holdSuspected: loop.gate.holdSuspected } : { gateIntent: 'closed', holdSuspected: false };
  // The same knot for §7.6: the session asks whether the reply it is producing
  // is closing, and the tracker that knows is built after it.
  let closingRef: ClosingSequence | null = null;
  const session = deps.createSession(guard, () => closingRef?.isClosing() ?? false);
  // The phase machine is built inside the loop and the coordinator after it;
  // the escalation callback is bound once both exist.
  let tools: ToolLink | null = null;

  loop = startCallLoop({
    request: deps.request,
    log: deps.log,
    transport: deps.transport,
    transcripts: sessionTranscripts(session, nowMs),
    navMode: deps.navMode,
    networkProfile: deps.networkProfile,
    nowMs,
    ...(deps.epochMs ? { epochMs: deps.epochMs } : {}),
    ...(deps.timers ? { timers: deps.timers } : {}),
    // §4: the bridge must flush before the transport hears of a narrowing.
    gateTarget: bridge,
    onEscalation: (cause) => tools?.onPhaseEscalation(cause),
  });
  const live = loop;

  let stopped = false;

  // What the far end said lately: the turn in progress and the last few
  // completed ones. A number is usually said a turn or two before the model
  // gets round to capturing it.
  const recentTurns: string[] = [];
  let currentTurn = '';
  session.onTranscriptDelta((text) => {
    currentTurn = text;
  });
  session.onTurn((speaker, text) => {
    if (speaker !== 'far_end') return;
    recentTurns.push(text);
    if (recentTurns.length > RECENT_FAR_END_TURNS) recentTurns.shift();
    currentTurn = '';
  });

  // Step 4: the session's tool calls reach the handlers, and their effects
  // reach the phase, the channel, the keypad and the escalation procedure.
  const toolLink = connectTools({
    session,
    loop: live,
    bridge,
    log: deps.log,
    request: deps.request,
    queue: deps.queue,
    farEndSpeech: () => [...recentTurns, currentTurn].join(' '),
    now: nowMs,
  });
  tools = toolLink;

  // Step 3: the session is brought to every settled position. What moves the
  // position is in the log — channel and phase changes — and so is what changes
  // the prompt without moving it: a disclosure heard, a party reset.
  const readInputs = (): PositionInputs => ({
    call: live.snapshot(),
    request: deps.request,
    navMode: deps.navMode,
    disclosure: live.disclosure,
    holdSegmentMs: live.lastHoldSegmentMs,
  });
  const configurator = createConfigurator({
    session,
    log: deps.log,
    read: readInputs,
    onFault: deps.onFault ?? ((err) => console.error('[call] session.update refused:', err)),
    ...(deps.defer ? { defer: deps.defer } : {}),
  });
  const unsubscribe = deps.log.subscribe((e) => {
    if (e.t === 'channel.changed') configurator.request(e.from);
    else if (e.t === 'phase.changed' || e.t === 'disclosure.delivered' || e.t === 'party.changed') configurator.request();
  });

  // Step 5: the closing detector, DONE, the hangup, and the outcome when the
  // line closes without one.
  const closing = createClosingSequence({
    loop: live,
    bridge,
    transport: deps.transport,
    log: deps.log,
    request: deps.request,
    queue: deps.queue,
    markersAt: () => positionConfig(readInputs()).bundle?.markerOrder ?? [],
    endSession: () => session.end(),
    onFinished: () => call.stop(),
    ...(deps.timers ? { timers: deps.timers } : {}),
  });
  closingRef = closing;

  // The agent hears EVERYTHING the far end sends, whatever the gate says. The
  // gate governs what the agent may SAY; muting what it hears would leave it
  // answering a conversation it only half followed.
  deps.transport.onAudio((frame) => {
    if (!stopped) session.sendAudio(frame);
  });

  session.onReplyAudio((bytes) => {
    if (!stopped) bridge.pushAgentAudio(bytes);
  });

  session.onReplyStarted(() => {
    if (stopped) return;
    // §7.6: a reply is closing or not from the moment it starts being generated.
    closing.onReplyStarted();
    // §6.2's responsiveness signal. The loop decides whether a person could be
    // the one replying; this only reports that the agent spoke.
    live.noteAgentSpoke();
  });

  session.onReplyDone((status) => {
    if (stopped) return;
    // An interrupted reply's queued tail must not play (§3's second trigger);
    // a completed one's last partial frame must not be held back.
    if (status === 'interrupted') void bridge.interrupt();
    else bridge.finishReply();
    toolLink.onReplyDone(status);
    // Last: a closing reply's completion can produce DONE, which starts the hangup.
    closing.onReplyDone(status);
  });

  session.onSpeechStarted(() => {
    // §3's third and earliest trigger. It also fires on speech that is not an
    // interruption — a backchannel — which is what A-14 measures together with
    // interruption_delay (ADR-011). Applied here as §3 specifies; A-14 decides
    // whether it holds.
    if (!stopped) void bridge.interrupt();
  });

  session.onTurn((speaker, text, isClosing) => {
    if (stopped || speaker !== 'agent') return;
    deps.log.append({
      t: 'turn.transcribed',
      speaker: 'agent',
      text,
      partial: false,
      // The agent reads numbers back, so its turns can carry identifiers too.
      redactable: true,
      isClosing,
    });
    // §7.6: disclosedToCurrentParty becomes true when the agent SAID it, never
    // because a prompt told it to. The tracker logs disclosure.delivered, and
    // that reconfigures the session without DISCLOSURE.txt.
    live.disclosure.onAgentTurn(text);
  });

  const call: Call = {
    loop: live,
    bridge,
    session,
    configurator,
    tools: toolLink,
    closing,
    finished: closing.finished,
    stop(): void {
      stopped = true;
      unsubscribe();
      configurator.stop();
      toolLink.stop();
      closing.stop();
      live.stop();
      bridge.stop();
    },
  };
  return call;
}
