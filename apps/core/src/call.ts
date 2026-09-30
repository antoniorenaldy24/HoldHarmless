/**
 * The call loop — the module §21 never scheduled.
 *
 * Thirty-four modules build components; not one assembles them. Module 4.5 asks
 * for "fifteen full runs", which presumes a call that runs, and no module makes
 * one. This is that module, and it is numbered 4.0 rather than 4.6 because it
 * belongs before everything in week 4: A-12, A-14, A-20, A-27, A-31 and A-32 all
 * need a call before they can be measured, and until now the acoustic classifier
 * had no production caller at all (§6.8).
 *
 * WHAT THIS WIRES, and the rules that decide the wiring:
 *
 * 1. OBSERVATIONS ARE LOGGED BEFORE THEY ARE ACTED ON, and the gate is acted on
 *    before it is logged. Not the same rule in two directions — two rules:
 *
 *    An observation is the CAUSE of whatever the Call Model does next. Writing
 *    it first means a `gate.changed` can never appear in the log without the
 *    `acoustic.observed` or `semantic.observed` that produced it; the other
 *    order can lose the cause and leave a gate change no reader can explain.
 *
 *    The gate is the opposite case. `recompute` in the gate controller calls
 *    `applyGate` and then emits, because narrowing the gate is ADR-007's second
 *    layer against leakage and must not wait on a log write. A gate applied but
 *    unlogged is a safe call with an incomplete record; a gate logged but
 *    unapplied would be the reverse, and the reverse is the one that leaks.
 *
 *    Neither order was written down before module 4.0. `log.ts` claimed §9.3
 *    required the first; §9.3 is the event schema and requires nothing of the
 *    kind. Both are now stated in §9.3.
 *
 * 2. THE GATE IS DERIVED, NEVER SET. ADR-007: `gateFor(channel, holdSuspected,
 *    navMode)`. Nothing here calls `applyGate`; the gate controller owns the
 *    transport and recomputes on every input. A second writer would make INV-1
 *    unauditable.
 *
 * 3. SILENCE IS PUSHED AS SILENCE. §6.8 records the trap: `createSignalWindows`
 *    keeps its window by timestamp, so an absence of frames is not a pause — it
 *    is fewer samples over the same ratio. The far end's stream is continuous,
 *    so every frame that arrives is pushed, and that is enough; nothing here may
 *    skip quiet frames as an optimization.
 *
 * 4. THE AGENT'S OWN SPEECH IS REPORTED ONLY WHERE A PERSON COULD BE REPLYING.
 *    §6.2's highest-weighted HUMAN signal is responsiveness, and in speech
 *    navigation the MENU answers the agent too — measured to make a four-word
 *    menu opening read HUMAN. So `noteAgentSpoke` fires on `HUMAN` and
 *    `TRANSFER` and never while navigating an IVR.
 *
 * 5. THE CHANNEL MOVES BY ITS OWN PRODUCERS (§5.3), and the phase follows in
 *    the same handler. Until module 4.0's reply half only `* → HOLD` had a
 *    producer; a real call sat in DIALING with the gate shut. `channel.ts` in
 *    callmodel is the rest of the table, wired here.
 *
 * WHAT THIS DOES NOT DO YET, stated rather than implied: it does not drive the
 * Work Queue, redial, or the closing sequence, and it does not load prompts or
 * push per-position session updates. Those are the reply half; this is the
 * observation half — audio in, classifiers, suspicion, gate out — which is what
 * A-27 needs and what §6.8 named as missing. The reply half follows, and until
 * it lands nothing here should be read as "the system runs a call".
 */

import { BYTES_PER_FRAME, FRAME_MS, muLaw } from '@holdharmless/audio';
import { createAcousticClassifier, createSemanticClassifier } from '@holdharmless/classifier';
import {
  createChannelDriver,
  createDisclosureTracker,
  createGateController,
  createPhaseMachine,
  type ChannelDriver,
  type ChannelTimers,
  type DisclosureTracker,
  type GateController,
  type GateTarget,
  type PhaseMachine,
} from '@holdharmless/callmodel';
import type { AuthRequest, Call, CallEventBody, Channel, NavMode, NetworkProfileName } from '@holdharmless/events';
import type { CallTransport, NetworkProfile } from '@holdharmless/transport';
import type { EventLog } from './log.js';

/**
 * Where transcripts come from.
 *
 * Injected rather than taken from the agent session, for one reason that is not
 * convenience: A-27 measures what §6.3's phrase list costs, and running it
 * against live ASR measures the list AND the recognizer together. A source that
 * delivers exactly what the far end said isolates the list, and is an upper
 * bound on how well it can do. The live source is the confirmation, not the
 * measurement — and the two disagreeing is itself a finding.
 */
export interface TranscriptSource {
  /** Far-end text as it arrives. Deltas, not whole turns (§6.2 reads deltas). */
  onFarEndDelta(handler: (text: string, atMs: number) => void): void;
  /**
   * The far end finished a turn.
   *
   * NOT optional, and the reason is a latch. The semantic classifier
   * accumulates deltas into one utterance and matches §6.3's phrases against
   * the whole of it; `endTurn()` is what clears the buffer. An assembly that
   * never calls it leaves "let me check" in the buffer for the rest of the
   * call, so EVERY later observation reads `HOLD_CUE`, `humanRun` never reaches
   * N=2, suspicion never clears and the gate never reopens. The agent is mute
   * from the first cue phrase to the end of the call.
   *
   * Nothing in the classifier's tests could catch that, because they push one
   * utterance at a time. It appears only when the parts are wired together,
   * which is what module 4.0 is for.
   *
   * It also feeds `turnLengthVariance` (§6.2), which needs three completed
   * turns before it is available at all.
   */
  onFarEndTurnEnd(handler: (text: string, atMs: number) => void): void;
}

export type CallLoopDeps = {
  request: AuthRequest;
  log: EventLog;
  transport: CallTransport;
  transcripts: TranscriptSource;
  navMode: NavMode;
  networkProfile: NetworkProfileName;
  /** Milliseconds since the call began. Injected so a replay can drive it. */
  nowMs?: () => number;
  /**
   * What the gate controller drives. The transport by default; the Audio Bridge
   * once the reply half is wired, because the bridge must flush its own pacing
   * buffer BEFORE the transport hears of a narrowing (§4) — and it can only do
   * that if it is the thing the controller calls.
   */
  gateTarget?: GateTarget;
  /**
   * The §5.3 timers (HOLD_CONFIRM_MS, HOLD_TIMEOUT_MS, TRANSFER_TIMEOUT_MS).
   * Real timers by default; a test or a replay passes its own clock.
   */
  timers?: ChannelTimers;
  /**
   * Epoch milliseconds, for `holdSuspectedAt` — which is epoch by contract
   * (§9.3, `hold.suspected.atMs`), unlike `nowMs`, which is call-relative.
   */
  epochMs?: () => number;
  /** Overridable for tests; the classifiers are otherwise built here. */
  acoustic?: ReturnType<typeof createAcousticClassifier>;
  semantic?: ReturnType<typeof createSemanticClassifier>;
};

export interface CallLoop {
  readonly gate: GateController;
  /**
   * The phase dimension (§5.4). Moved here by exactly two things: the channel
   * entering HUMAN or CLOSED — applied in the same handler as the
   * channel.changed that caused it (§5.3's atomic follow-ups) — and whatever
   * the caller hands it: tools, reply.done, the phase timeout.
   */
  readonly phase: PhaseMachine;
  /** §5.3's producers the gate controller does not own. */
  readonly channels: ChannelDriver;
  /**
   * Who has been told (ADR-017, ADR-018). Follows every channel change in the
   * same handler, so a party reset is in force before anything can be said to
   * the new party; the caller reports the agent's turns to it.
   */
  readonly disclosure: DisclosureTracker;
  /**
   * The hold segment that most recently ENDED, in ms, measured from the moment
   * suspicion began rather than from the confirmed channel change (ADR-017) —
   * the latter would under-report by the confirmation delay, up to twenty
   * seconds on the acoustic path, against a five-second threshold.
   */
  readonly lastHoldSegmentMs: number;
  /**
   * The call as §12.1's `Call`, assembled from the parts that own each field.
   * A snapshot, never stored: every field has exactly one owner, and a stored
   * copy would be a second.
   */
  snapshot(): Call;
  /**
   * Dials, and produces `DIALING → IVR` or `DIALING → CLOSED` from the result.
   * Resolves either way; a refused link is a call outcome, not an exception.
   */
  dial(endpoint: string, profile: NetworkProfile): Promise<boolean>;
  /**
   * Frames PUSHED TO THE ACOUSTIC LAYER — not frames received.
   *
   * The distinction is the §6.8 trap itself. A loop that skipped quiet frames
   * would still receive them, so a counter incremented on arrival would look
   * healthy while the pause-ratio signal starved. Incremented next to the push
   * and nowhere else.
   */
  readonly framesObserved: number;
  /**
   * The agent spoke. §6.2's responsiveness signal, and the Call Model is the
   * only caller that knows whether a person could be the one replying.
   */
  noteAgentSpoke(): void;
  /** Ends the loop: unsubscribes and stops feeding the classifiers. */
  stop(): void;
}

export function startCallLoop(deps: CallLoopDeps): CallLoop {
  const t0 = Date.now();
  const nowMs = deps.nowMs ?? (() => Date.now() - t0);
  const acoustic = deps.acoustic ?? createAcousticClassifier();
  const semantic = deps.semantic ?? createSemanticClassifier();

  deps.log.append({
    t: 'call.started',
    requestId: deps.request.id,
    attempts: deps.request.attempts + 1,
    priority: deps.request.priority,
    networkProfile: deps.networkProfile,
  });

  // The controller owns the transport (ADR-007). Every event it produces is
  // written here, in the order it produced them, and nothing else writes a
  // gate.changed or a channel.changed.
  const epochMs = deps.epochMs ?? Date.now;
  const startedAt = new Date(epochMs()).toISOString();
  const phase = createPhaseMachine({ emit: (body) => deps.log.append(body) });
  const disclosure = createDisclosureTracker({ emit: (body) => deps.log.append(body) });
  let channels: ChannelDriver | null = null;
  let gateRef: GateController | null = null;

  // A hold SEGMENT spans consecutive HOLD and TRANSFER channels, and starts
  // when suspicion began — which the controller still holds at the moment it
  // emits the channel change into HOLD, and clears only after.
  let segmentStartedAt: number | undefined;
  let lastHoldSegmentMs = 0;
  const holdLike = (c: Channel) => c === 'HOLD' || c === 'TRANSFER';
  const followSegment = (from: Channel, to: Channel): void => {
    if (holdLike(to) && segmentStartedAt === undefined) segmentStartedAt = gateRef?.holdSuspectedAt ?? epochMs();
    if (holdLike(from) && !holdLike(to) && segmentStartedAt !== undefined) {
      lastHoldSegmentMs = epochMs() - segmentStartedAt;
      segmentStartedAt = undefined;
    }
  };

  /**
   * What the controller produced, in its order. Two things follow a
   * channel.changed, and both in THIS handler, before control returns:
   *
   *   1. §5.3's atomic follow-ups — entering HUMAN while NOT_STARTED moves the
   *      phase to EXCHANGE, entering CLOSED moves it to DONE. Done anywhere
   *      later, HUMAN/NOT_STARTED would be a resting state: no policy, no
   *      tools, no prompt, and `positionalPromptName` throws on it.
   *   2. the channel timers, which start and stop with the channel.
   */
  const onController = (body: CallEventBody): void => {
    deps.log.append(body);
    if (body.t === 'channel.changed') {
      phase.onChannelChange(body.to);
      followSegment(body.from, body.to);
      // ADR-017's reset list, with the segment that just ended.
      disclosure.onChannelChange(body.from, body.to, lastHoldSegmentMs);
    }
    channels?.onControllerEvent(body);
  };

  const gate = createGateController({
    navMode: deps.navMode,
    transport: deps.gateTarget ?? deps.transport,
    emit: onController,
    ...(deps.epochMs ? { now: deps.epochMs } : {}),
  });
  gateRef = gate;
  const driver = createChannelDriver({ gate, ...(deps.timers ? { timers: deps.timers } : {}) });
  channels = driver;

  let framesObserved = 0;
  let stopped = false;

  deps.transport.onAudio((frame) => {
    if (stopped) return;
    // Every frame, quiet ones included: see rule 3 in the header. The counter
    // sits on this line so it cannot say a frame was observed that was not.
    framesObserved++;
    const observation = acoustic.push(muLaw.decode(frame), nowMs());
    if (!observation) return;
    // §9.3: written before it is acted on.
    deps.log.append({ t: 'acoustic.observed', obs: observation });
    gate.onAcoustic(observation);
  });

  deps.transcripts.onFarEndDelta((text, atMs) => {
    if (stopped) return;
    // Any word from the far end, classified or not, is the far end speaking:
    // HOLD_CONFIRM_MS counts three seconds of silence after a cue, not three
    // seconds after it (see channel.ts).
    driver.onFarEndSpeech();
    const observation = semantic.push(text, atMs);
    if (!observation) return;
    deps.log.append({ t: 'semantic.observed', obs: observation });
    // The channel first: a person answering while suspicion stands moves the
    // channel, and then the controller clears suspicion — one widening, not two.
    driver.onSemantic(observation);
    gate.onSemantic(observation);
  });

  deps.transport.onClosed((cause) => {
    if (stopped) return;
    driver.transportClosed(cause);
  });

  deps.transcripts.onFarEndTurnEnd((text, atMs) => {
    if (stopped) return;
    void atMs;
    deps.log.append({
      t: 'turn.transcribed',
      speaker: 'far_end',
      text,
      partial: false,
      // §11: what the far end said may carry member identifiers, so the panel
      // decides whether to show it. The decision is not taken here.
      redactable: true,
      isClosing: false,
    });
    // The latch this prevents is described on `onFarEndTurnEnd`.
    semantic.endTurn();
  });

  return {
    gate,
    phase,
    channels: driver,
    disclosure,
    get lastHoldSegmentMs() {
      return lastHoldSegmentMs;
    },
    snapshot(): Call {
      const p = phase.state;
      return {
        id: deps.log.callId,
        requestId: deps.request.id,
        transport: 'loopback',
        navMode: deps.navMode,
        networkProfile: deps.networkProfile,
        startedAt,
        channel: gate.channel,
        phase: p.phase,
        ...(p.closingKind ? { closingKind: p.closingKind } : {}),
        holdSuspected: gate.holdSuspected,
        ...(gate.holdSuspectedAt !== undefined ? { holdSuspectedAt: gate.holdSuspectedAt } : {}),
        holdDurationMs: gate.holdDurationMs(),
        humanChannelMs: p.humanChannelMs,
        disclosedToCurrentParty: disclosure.disclosedToCurrentParty,
        partiesDetected: disclosure.partiesDetected,
        disclosuresDelivered: disclosure.disclosuresDelivered,
        ...(p.capturedAuthNumber !== undefined ? { capturedAuthNumber: p.capturedAuthNumber } : {}),
        readbackAttempts: p.readbackAttempts,
        outcomeWritten: p.outcomeWritten,
        // Owned by parts not wired into the loop yet — silence recovery, the
        // tool layer, session recovery, billing (steps 4 and 5). Reported as
        // their starting values, not invented, and none is read by a prompt.
        cumulativeHoldMs: 0,
        rePromptCounts: {},
        holdRampSteps: 0,
        pendingContextCorrection: false,
        discardedToolResults: [],
        billableSessionMs: 0,
      };
    },
    async dial(endpoint: string, profile: NetworkProfile): Promise<boolean> {
      try {
        await deps.transport.dial(endpoint, profile);
      } catch (err) {
        driver.linkFailed(`link_refused: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
      driver.linkEstablished();
      return true;
    },
    get framesObserved() {
      return framesObserved;
    },

    noteAgentSpoke(): void {
      // §6.2, and the comment on `noteAgentSpoke` in the classifier: the menu
      // answers the agent in speech navigation, and reporting that as agent
      // speech made a four-word menu opening read HUMAN. Channel is the test.
      const channel: Channel = gate.channel;
      if (channel !== 'HUMAN' && channel !== 'TRANSFER') return;
      semantic.noteAgentSpoke(nowMs());
    },

    stop(): void {
      stopped = true;
      driver.stop();
    },
  };
}

/** μ-law frames from a chunk of bytes, for a caller feeding recorded audio. */
export function framesOf(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i + BYTES_PER_FRAME <= bytes.length; i += BYTES_PER_FRAME) {
    out.push(bytes.slice(i, i + BYTES_PER_FRAME));
  }
  return out;
}

export { FRAME_MS };
