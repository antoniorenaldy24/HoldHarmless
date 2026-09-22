/**
 * Hold suspicion and the gate — §5.5, §6.5, ADR-007, module 2.3.
 *
 * This is where the two classifier layers become one decision: may the agent be
 * heard right now. It owns `holdSuspected` and nothing else about the call; the
 * gate itself is never stored, only derived (gateFor) and pushed to the
 * transport whenever either input changes.
 *
 * THE ASYMMETRY IS THE DESIGN (§6.5: "suspect fast, confirm slowly").
 *
 *   suspect   N=1  — one hold cue, one provisional PERIODIC, one notify_transfer,
 *                    or a session reconnect. Any of them closes the gate at once.
 *   confirm   N=2  — two agreeing semantic HUMAN observations reopen it; two
 *                    agreeing confirmed PERIODIC observations move the channel
 *                    to HOLD (where the gate stays closed anyway).
 *
 * Suspicion is cheap and reversible; being heard over hold audio is neither.
 *
 * COUNTERS FREEZE WHILE SUSPECTED (§6.5's note, "the single most consequential
 * line"): an unannounced hold is confirmed only by a 20-second window, and a
 * silence counter running through it would end the call as unresponsive at
 * about nine seconds. A-28 is exactly this scenario.
 */

import type {
  AcousticObservation,
  CallEventBody,
  Channel,
  GateIntent,
  NavMode,
  Producer,
  SemanticObservation,
} from '@holdharmless/events';
import { gateFor } from './gate.js';

export type SuspicionTrigger = 'hold_cue' | 'periodic_provisional' | 'notify_transfer' | 'reconnect';
export type ClearReason = 'human_confirmed' | 'hold_confirmed' | 'reconnected';

/** Just enough of CallTransport to drive the gate; the real one satisfies it. */
export interface GateTarget {
  applyGate(intent: GateIntent): void;
}

export type GateControllerOptions = {
  navMode: NavMode;
  channel?: Channel;
  transport?: GateTarget;
  /** Every event this controller produces, in order, for the core to number. */
  emit?: (event: CallEventBody) => void;
  /** Two agreeing observations before a confirmation counts (§6.5). */
  confirmN?: number;
  now?: () => number;
};

export interface GateController {
  readonly gate: GateIntent;
  readonly channel: Channel;
  readonly holdSuspected: boolean;
  /** Epoch ms of the instant suspicion began — the zero point for holdDurationMs. */
  readonly holdSuspectedAt: number | undefined;
  /** §5.5: counters do not advance while suspicion holds. */
  readonly countersFrozen: boolean;

  onAcoustic(observation: AcousticObservation): void;
  onSemantic(observation: SemanticObservation): void;
  onToolCall(name: string): void;
  /** §15: a session gap is treated as a hold until the session is back. */
  setConnection(state: 'lost' | 'restored'): void;
  setChannel(channel: Channel, producer: Producer): void;
  setNavMode(navMode: NavMode): void;
  holdDurationMs(): number;
}

export function createGateController(options: GateControllerOptions): GateController {
  const emit = options.emit ?? (() => {});
  const now = options.now ?? Date.now;
  const confirmN = options.confirmN ?? 2;

  let channel: Channel = options.channel ?? 'DIALING';
  let navMode = options.navMode;
  let holdSuspected = false;
  let suspectedAt: number | undefined;
  let gate: GateIntent = gateFor(channel, holdSuspected, navMode);
  let humanRun = 0;
  let periodicRun = 0;

  /**
   * Recomputes the gate and pushes it to the transport if it moved.
   *
   * `clearSent` is true whenever the gate NARROWS. The transport's contract
   * (ADR-007) is that any narrowing also issues clear(), so this records what
   * the transport is guaranteed to have done rather than asking it.
   */
  const recompute = (producer: Producer): void => {
    const next = gateFor(channel, holdSuspected, navMode);
    if (next === gate) return;
    const from = gate;
    gate = next;
    const narrowing = rank(next) < rank(from);
    options.transport?.applyGate(next);
    emit({ t: 'gate.changed', from, to: next, channel, holdSuspected, clearSent: narrowing, producer });
  };

  const suspect = (trigger: SuspicionTrigger, producer: Producer): void => {
    if (holdSuspected) return;
    holdSuspected = true;
    suspectedAt = now();
    humanRun = 0;
    emit({ t: 'hold.suspected', trigger, atMs: suspectedAt });
    recompute(producer);
  };

  const clear = (reason: ClearReason, producer: Producer): void => {
    if (!holdSuspected) return;
    holdSuspected = false;
    suspectedAt = undefined;
    emit({ t: 'hold.cleared', reason });
    recompute(producer);
  };

  // The transport starts closed and the controller starts wherever the call
  // does, so the initial gate has to be pushed rather than waited for. Without
  // this the first agent audio of every call is dropped silently — which an
  // A-11 measurement reads as a perfect score, because nothing was ever audible.
  options.transport?.applyGate(gate);

  return {
    get gate() {
      return gate;
    },
    get channel() {
      return channel;
    },
    get holdSuspected() {
      return holdSuspected;
    },
    get holdSuspectedAt() {
      return suspectedAt;
    },
    get countersFrozen() {
      return holdSuspected;
    },

    onAcoustic(o: AcousticObservation): void {
      if (!o.accepted) return; // UNKNOWN is not evidence (§6.4)
      if (o.winner !== 'PERIODIC') {
        periodicRun = 0;
        return;
      }
      // Provisional PERIODIC suspects at N=1; only CONFIRMED periodic, twice,
      // moves the channel — the 20-second autocorrelation window is what makes
      // the second tier mean anything (§6.1).
      suspect('periodic_provisional', { kind: 'acoustic', seq: o.seq });
      if (o.tier !== 'confirmed') return;
      periodicRun++;
      if (periodicRun >= confirmN && channel !== 'HOLD') {
        this.setChannel('HOLD', { kind: 'acoustic', seq: o.seq });
      }
    },

    onSemantic(o: SemanticObservation): void {
      if (!o.accepted) return;
      const producer: Producer = { kind: 'semantic', seq: o.seq };
      if (o.winner === 'HOLD_CUE') {
        humanRun = 0;
        suspect('hold_cue', producer);
        return;
      }
      if (o.winner === 'HUMAN') {
        humanRun++;
        // N=2, and only outside HOLD: leaving the channel is a separate
        // decision the Call Model makes, not something suspicion undoes.
        if (humanRun >= confirmN && holdSuspected && channel !== 'HOLD') {
          clear('human_confirmed', producer);
        }
        return;
      }
      humanRun = 0; // IVR_PROMPT is not evidence of a person
    },

    onToolCall(name: string): void {
      // ADR-019: a transfer is announced by the tool, and the gate closes on
      // the announcement rather than waiting for the audio to change.
      if (name === 'notify_transfer') suspect('notify_transfer', { kind: 'tool', seq: 0, name: 'notify_transfer' });
    },

    setConnection(state: 'lost' | 'restored'): void {
      const producer: Producer = { kind: 'session', event: 'session.resumed' };
      if (state === 'lost') suspect('reconnect', producer);
      else clear('reconnected', producer);
    },

    setChannel(next: Channel, producer: Producer): void {
      if (next === channel) return;
      const from = channel;
      channel = next;
      emit({ t: 'channel.changed', from, to: next, producer });
      // Entering HOLD, suspicion has done its job: the channel now holds the
      // gate closed by itself (§5.5). One handler, no interleaving.
      if (next === 'HOLD' && holdSuspected) {
        holdSuspected = false;
        suspectedAt = undefined;
        emit({ t: 'hold.cleared', reason: 'hold_confirmed' });
      }
      if (next !== 'HOLD') periodicRun = 0;
      recompute(producer);
    },

    setNavMode(next: NavMode): void {
      if (next === navMode) return;
      navMode = next;
      recompute({ kind: 'transport', cause: 'nav_mode_changed' });
    },

    holdDurationMs(): number {
      return suspectedAt === undefined ? 0 : now() - suspectedAt;
    },
  };
}

/** open > dtmf_only > closed: how much a gate admits, for narrowing checks. */
function rank(intent: GateIntent): number {
  return intent === 'open' ? 2 : intent === 'dtmf_only' ? 1 : 0;
}

// ---------------------------------------------------------------------------

/**
 * Silence and re-prompt counters that stop while the gate is shut for hold —
 * §6.5. A-28 is the test: ten unannounced holds, and zero calls ended before
 * the channel reaches HOLD.
 */
export interface RecoveryCounters {
  /** Milliseconds of silence accumulated; frozen while suspicion holds. */
  silenceMs(): number;
  rePrompts(): number;
  /** Advances the silence clock, unless frozen. Returns the new total. */
  advance(elapsedMs: number): number;
  /** The far end spoke: silence resets, re-prompts do not. */
  noteActivity(): void;
  /** A re-prompt was delivered: the silence clock restarts. */
  noteRePrompt(): void;
  reset(): void;
}

export function createRecoveryCounters(frozen: () => boolean): RecoveryCounters {
  let silence = 0;
  let rePrompts = 0;
  return {
    silenceMs: () => silence,
    rePrompts: () => rePrompts,
    advance(elapsedMs: number): number {
      if (!frozen()) silence += elapsedMs;
      return silence;
    },
    noteActivity(): void {
      silence = 0;
    },
    noteRePrompt(): void {
      rePrompts++;
      silence = 0;
    },
    reset(): void {
      silence = 0;
      rePrompts = 0;
    },
  };
}
