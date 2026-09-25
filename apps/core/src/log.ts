/**
 * The event log — ADR-012, §9.3, module 3.8.
 *
 * "The log is the runtime source of truth." Until now every part of the system
 * emitted `CallEventBody` into whatever array its caller supplied, which is fine
 * for a test and is not a log: nothing stamped a sequence number, nothing gave
 * events a time, and nothing could be read by a second reader. This is that
 * one place.
 *
 * THREE PROPERTIES, and each of them is load-bearing somewhere else.
 *
 * 1. `seq` is dense and starts at zero. Every invariant is written against
 *    `replay()`, which walks the log in order and reports the sequence number
 *    of the event that broke a rule; a gap would make that report point at the
 *    wrong event.
 *
 * 2. Appending is synchronous and so is notifying subscribers. §9.3 lists the
 *    events that must be written before the state they describe is acted on —
 *    a crash between the state change and its record would leave the log
 *    disagreeing with reality, and the log is what everything else believes.
 *
 * 3. A subscriber that throws does not break the append. The dashboard is a
 *    reader; a reader that falls over must not take the call with it.
 */

import type { CallEvent, CallEventBody } from '@holdharmless/events';

export type EventLogOptions = {
  callId: string;
  /** Injected so a replay can carry its own clock rather than wall time. */
  now?: () => Date;
  /** Surfaces a subscriber that threw, without letting it reach the caller. */
  onSubscriberError?: (error: unknown) => void;
};

export interface EventLog {
  readonly callId: string;
  /**
   * `at` overrides the clock. A replay supplies the CALL's own timestamps, so
   * every duration on the dashboard is the duration that call had — a replay
   * played at 8x must not report a twenty-second silence as two and a half.
   */
  append(body: CallEventBody, at?: string): CallEvent;
  /** Everything so far, oldest first. A copy: the log is not handed out. */
  events(): CallEvent[];
  /** Events from `fromSeq` onward, for a reader that reconnected. */
  since(fromSeq: number): CallEvent[];
  subscribe(handler: (event: CallEvent) => void): () => void;
  readonly length: number;
}

export function createEventLog(options: EventLogOptions): EventLog {
  const now = options.now ?? (() => new Date());
  const entries: CallEvent[] = [];
  const handlers = new Set<(event: CallEvent) => void>();

  return {
    callId: options.callId,

    append(body: CallEventBody, at?: string): CallEvent {
      const event: CallEvent = { seq: entries.length, callId: options.callId, at: at ?? now().toISOString(), ...body };
      entries.push(event);
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (error) {
          // A reader that throws is a broken reader, not a broken call.
          options.onSubscriberError?.(error);
        }
      }
      return event;
    },

    events(): CallEvent[] {
      return [...entries];
    },

    since(fromSeq: number): CallEvent[] {
      return entries.slice(Math.max(0, fromSeq));
    },

    subscribe(handler: (event: CallEvent) => void): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    get length(): number {
      return entries.length;
    },
  };
}
