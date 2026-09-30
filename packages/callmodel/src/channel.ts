/**
 * The channel producers the gate controller does not own — §5.3, module 4.0.
 *
 * §5.3 has fourteen rows. Until module 4.0 exactly one of them had a producer
 * in the code: `* → HOLD` on two confirmed PERIODIC observations, inside the
 * gate controller. Every other channel move — the link coming up, a person
 * answering the menu, a representative returning from hold, the three timers,
 * the line closing — was a row in a table and nothing more. The consequence
 * was total: a call started for real sat in DIALING with the gate shut for its
 * whole length. Every test above the unit level set the channel by hand
 * (`setChannel('HUMAN', …)`), which is how it went unseen.
 *
 * This is the rest of the table. The gate controller keeps what it had —
 * suspicion, the gate, and the acoustic move into HOLD — and its own test still
 * says that inside HOLD, HUMAN observations do not reopen the gate: leaving hold
 * is a channel decision, taken here, not something suspicion undoes.
 *
 * HOLD_CUE + HOLD_CONFIRM_MS, AS BUILT. §5.3 names the pair and §13 says only
 * "from HOLD_CUE to the channel transition". Read literally — a cue, then three
 * seconds with suspicion still standing — it would move EVERY filler cue into
 * HOLD, because clearing suspicion takes two HUMAN observations and a sentence
 * is longer than three seconds. So the three seconds are three seconds in which
 * the far end SAID NOTHING: every far-end transcript delta re-arms the timer.
 * "Let me check that… okay, I have the member here" never reaches HOLD; "one
 * moment please" followed by music or silence does, three seconds after the
 * last word. A representative who says "let me check" and then types in
 * silence for three seconds is, for every purpose the channel serves, on hold.
 */

import type { Channel, Producer, SemanticObservation, CallEventBody } from '@holdharmless/events';
import type { GateController } from './suspicion.js';

/** §13. From HOLD_CUE — and the far end's last word after it — to the channel transition. */
export const HOLD_CONFIRM_MS = 3_000;
/** §13. 20 minutes: the only exit from a hold nobody leaves (§6.7). */
export const HOLD_TIMEOUT_MS = 1_200_000;
/** §13. The only exit from a transfer nobody answers (§5.7, decided 2026-09-23). */
export const TRANSFER_TIMEOUT_MS = 90_000;

/** How a timer is started. Injected so a test — or a replay — owns the clock. */
export interface ChannelTimers {
  after(ms: number, fn: () => void): () => void;
}

export const realTimers: ChannelTimers = {
  after(ms, fn) {
    const h = setTimeout(fn, ms);
    // A pending 20-minute hold timeout must not keep a finished process alive.
    h.unref?.();
    return () => clearTimeout(h);
  },
};

export type ChannelDriverOptions = {
  gate: GateController;
  timers?: ChannelTimers;
  /** §6.5: two agreeing observations before a channel moves. */
  confirmN?: number;
  holdConfirmMs?: number;
  holdTimeoutMs?: number;
  transferTimeoutMs?: number;
};

export interface ChannelDriver {
  /**
   * An accepted or unaccepted semantic observation. Called BEFORE the gate
   * controller sees it, so that a person answering while suspicion stands
   * moves the channel first and the gate widens once, not twice.
   */
  onSemantic(o: SemanticObservation): void;
  /** Any far-end transcript delta: the far end is speaking (re-arms HOLD_CONFIRM_MS). */
  onFarEndSpeech(): void;
  /** Every event the gate controller emits, in order — this is how the timers follow the channel. */
  onControllerEvent(e: CallEventBody): void;
  /** §5.3 `HUMAN → TRANSFER`: the notify_transfer tool, accepted. */
  onNotifyTransfer(toolSeq: number): void;
  /** §5.3 `DIALING → IVR`. */
  linkEstablished(): void;
  /** §5.3 `DIALING → CLOSED`. */
  linkFailed(cause: string): void;
  /** §5.3 `any → CLOSED` on transport.closed. */
  transportClosed(cause: string): void;
  /** Cancels every timer. Nothing moves afterwards. */
  stop(): void;
}

export function createChannelDriver(options: ChannelDriverOptions): ChannelDriver {
  const gate = options.gate;
  const timers = options.timers ?? realTimers;
  const confirmN = options.confirmN ?? 2;
  const holdConfirmMs = options.holdConfirmMs ?? HOLD_CONFIRM_MS;
  const holdTimeoutMs = options.holdTimeoutMs ?? HOLD_TIMEOUT_MS;
  const transferTimeoutMs = options.transferTimeoutMs ?? TRANSFER_TIMEOUT_MS;

  let humanRun = 0;
  let ivrRun = 0;
  let cancelConfirm: (() => void) | null = null;
  let cancelTimeout: (() => void) | null = null;
  let stopped = false;

  /**
   * CLOSED is terminal without a guard here: no producer below has a row out
   * of it — each checks the channel it leaves from, as §5.3 lists it — and the
   * timers are disarmed on entering it. A guard repeating that would be a
   * second statement of one fact, and mutation testing showed it untestable.
   */
  const move = (to: Channel, producer: Producer): void => {
    if (stopped || gate.channel === to) return;
    gate.setChannel(to, producer);
  };

  const disarmConfirm = (): void => {
    cancelConfirm?.();
    cancelConfirm = null;
  };
  /**
   * The confirm timer is live ONLY while a cue's suspicion stands in IVR or
   * HUMAN: it is armed by that suspicion alone, and disarmed by suspicion
   * clearing and by any channel change. So when it fires, the conditions hold
   * by construction and are not re-checked — re-checking made the arming rules
   * untestable, since a wrong arming was then silently caught at the fire.
   */
  const armConfirm = (): void => {
    disarmConfirm();
    cancelConfirm = timers.after(holdConfirmMs, () => {
      cancelConfirm = null;
      move('HOLD', { kind: 'timer', name: 'HOLD_CONFIRM_MS' });
    });
  };
  const disarmTimeout = (): void => {
    cancelTimeout?.();
    cancelTimeout = null;
  };

  return {
    onSemantic(o: SemanticObservation): void {
      if (stopped || !o.accepted) return; // UNKNOWN is not evidence (§6.4)
      const producer: Producer = { kind: 'semantic', seq: o.seq };
      switch (o.winner) {
        case 'HUMAN': {
          ivrRun = 0;
          humanRun++;
          const c = gate.channel;
          // IVR → HUMAN, HOLD → HUMAN, TRANSFER → HUMAN: the same producer, N=2.
          if (humanRun >= confirmN && (c === 'IVR' || c === 'HOLD' || c === 'TRANSFER')) move('HUMAN', producer);
          return;
        }
        case 'IVR_PROMPT': {
          humanRun = 0;
          ivrRun++;
          // HOLD → IVR only. A menu heard while a person is on the line is not
          // a reason to leave them; a menu heard on hold is where the call went.
          if (ivrRun >= confirmN && gate.channel === 'HOLD') move('IVR', producer);
          return;
        }
        default:
          humanRun = 0;
          ivrRun = 0;
      }
    },

    onFarEndSpeech(): void {
      if (stopped || cancelConfirm === null) return;
      armConfirm(); // three seconds of NOTHING said, counted from the last word
    },

    onControllerEvent(e: CallEventBody): void {
      if (stopped) return;
      switch (e.t) {
        case 'hold.suspected':
          if (e.trigger === 'hold_cue' && (gate.channel === 'IVR' || gate.channel === 'HUMAN')) armConfirm();
          return;
        case 'hold.cleared':
          disarmConfirm();
          return;
        case 'channel.changed':
          // Evidence counted in one channel says nothing about the next.
          humanRun = 0;
          ivrRun = 0;
          disarmConfirm();
          disarmTimeout();
          if (e.to === 'HOLD') {
            cancelTimeout = timers.after(holdTimeoutMs, () => {
              cancelTimeout = null;
              move('CLOSED', { kind: 'timer', name: 'HOLD_TIMEOUT_MS' });
            });
          } else if (e.to === 'TRANSFER') {
            cancelTimeout = timers.after(transferTimeoutMs, () => {
              cancelTimeout = null;
              move('CLOSED', { kind: 'timer', name: 'TRANSFER_TIMEOUT_MS' });
            });
          }
          return;
        default:
          return;
      }
    },

    onNotifyTransfer(toolSeq: number): void {
      if (gate.channel !== 'HUMAN') return;
      move('TRANSFER', { kind: 'tool', seq: toolSeq, name: 'notify_transfer' });
    },

    linkEstablished(): void {
      if (gate.channel === 'DIALING') move('IVR', { kind: 'transport', cause: 'link_established' });
    },

    linkFailed(cause: string): void {
      if (gate.channel === 'DIALING') move('CLOSED', { kind: 'transport', cause });
    },

    transportClosed(cause: string): void {
      move('CLOSED', { kind: 'transport', cause });
    },

    stop(): void {
      stopped = true;
      disarmConfirm();
      disarmTimeout();
    },
  };
}
