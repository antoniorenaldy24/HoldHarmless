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
 *
 * What this does NOT do yet: configure the session per position (prompts,
 * policy, tools) — step 3 — or handle tools and the phase machine — step 4. A
 * call wired with this alone hears and speaks, under the gate, and does not yet
 * know what to say.
 */

import type { ReplyGuardState } from '@holdharmless/agent';
import type { CallTransport } from '@holdharmless/transport';
import type { AuthRequest, NavMode, NetworkProfileName } from '@holdharmless/events';
import { createAudioBridge, type AudioBridge, type AudioBridgeOptions } from './audio-bridge.js';
import { startCallLoop, type CallLoop, type TranscriptSource } from './call.js';
import type { EventLog } from './log.js';

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
  bridge?: Omit<AudioBridgeOptions, 'transport'>;
};

export interface Call {
  readonly loop: CallLoop;
  readonly bridge: AudioBridge;
  readonly session: AgentMedia;
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
    // §4: the bridge must flush before the transport hears of a narrowing.
    gateTarget: bridge,
  });
  const live = loop;

  let stopped = false;

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
  });

  return {
    loop: live,
    bridge,
    session,
    stop(): void {
      stopped = true;
      live.stop();
      bridge.stop();
    },
  };
}
