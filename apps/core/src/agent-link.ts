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
import { createConfigurator, type Configurator } from './position-config.js';

/**
 * The part of `AgentSession` this file uses, and nothing more. Structural, so a
 * test can stand in for the real session without a socket — and so it is visible
 * at a glance which of the session's surfaces the media path depends on.
 */
export interface AgentMedia {
  sendAudio(mulawFrame: Uint8Array): void;
  onTranscriptDelta(f: (text: string) => void): void;
  onTurn(f: (speaker: 'agent' | 'far_end', text: string, isClosing: boolean) => void): void;
  onSpeechStarted(f: () => void): void;
  onReplyAudio(f: (bytes: Uint8Array) => void): void;
  onReplyStarted(f: () => void): void;
  onReplyDone(f: (status: 'completed' | 'interrupted') => void): void;
  /** Mutable fields only; resolves on session.updated (§7.1). */
  update(config: Partial<SessionConfig>): Promise<void>;
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
  createSession: (guard: () => ReplyGuardState) => AgentMedia;
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
  stop(): void;
}

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
  const session = deps.createSession(guard);

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
  });
  const live = loop;

  let stopped = false;

  // Step 3: the session is brought to every settled position. What moves the
  // position is in the log — channel and phase changes — and so is what changes
  // the prompt without moving it: a disclosure heard, a party reset.
  const configurator = createConfigurator({
    session,
    log: deps.log,
    read: () => ({
      call: live.snapshot(),
      request: deps.request,
      navMode: deps.navMode,
      disclosure: live.disclosure,
      holdSegmentMs: live.lastHoldSegmentMs,
    }),
    onFault: deps.onFault ?? ((err) => console.error('[call] session.update refused:', err)),
    ...(deps.defer ? { defer: deps.defer } : {}),
  });
  const unsubscribe = deps.log.subscribe((e) => {
    if (e.t === 'channel.changed') configurator.request(e.from);
    else if (e.t === 'phase.changed' || e.t === 'disclosure.delivered' || e.t === 'party.changed') configurator.request();
  });

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
    // §6.2's responsiveness signal. The loop decides whether a person could be
    // the one replying; this only reports that the agent spoke.
    if (!stopped) live.noteAgentSpoke();
  });

  session.onReplyDone((status) => {
    if (stopped) return;
    // An interrupted reply's queued tail must not play (§3's second trigger);
    // a completed one's last partial frame must not be held back.
    if (status === 'interrupted') void bridge.interrupt();
    else bridge.finishReply();
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

  return {
    loop: live,
    bridge,
    session,
    configurator,
    stop(): void {
      stopped = true;
      unsubscribe();
      configurator.stop();
      live.stop();
      bridge.stop();
    },
  };
}
