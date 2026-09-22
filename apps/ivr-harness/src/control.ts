/**
 * The control channel — §10.4. A second WebSocket, opened alongside the audio
 * link, on which the harness reports what the core cannot observe.
 *
 * Sequence ownership: the harness never assigns `seq`. It sends
 * { metric, value, detail, atMs }; the core numbers it on receipt.
 *
 * Time base: atMs is `Date.now()`. Both processes share one host clock
 * (ADR-001), so the core can compare it with its own timestamps directly.
 */

import { WebSocketServer, WebSocket } from 'ws';

export type TelemetryMessage = {
  type: 'telemetry';
  callId: string;
  metric: string;
  value: number;
  detail?: string;
  atMs: number;
};

/**
 * A-30's probe. The core sends a ping stamped with its own clock; the harness
 * answers with its clock at the moment it handled it. ADR-001 says both
 * processes share one host clock, so telemetry needs no offset estimation —
 * this is what turns that sentence into a number.
 */
export type TimePing = { type: 'time.ping'; id: number; coreMs: number };
export type TimePong = { type: 'time.pong'; id: number; coreMs: number; harnessMs: number };

export type ControlMessage = TelemetryMessage | TimePing | TimePong | { type: 'hello'; callId: string | null };

export type ClockComparison = {
  samples: number;
  /** Estimated harness-minus-core offset per sample, after removing half the round trip. */
  offsetsMs: number[];
  spreadMs: number;
  medianOffsetMs: number;
  maxRoundTripMs: number;
};

/** Harness side: fans telemetry out to every connected core. */
export class ControlServer {
  readonly wss = new WebSocketServer({ noServer: true });
  private readonly backlog: TelemetryMessage[] = [];

  constructor() {
    this.wss.on('connection', (ws) => {
      // A core that connects after the call started still gets its telemetry:
      // ground truth reported before anyone listened is still ground truth.
      for (const m of this.backlog) ws.send(JSON.stringify(m));
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as ControlMessage;
          if (msg.type !== 'time.ping') return;
          // Answered inline, with no queueing of our own: any delay we add here
          // is measured as clock offset and would slander the clock.
          const pong: TimePong = { type: 'time.pong', id: msg.id, coreMs: msg.coreMs, harnessMs: Date.now() };
          ws.send(JSON.stringify(pong));
        } catch {
          /* not ours */
        }
      });
    });
  }

  report(callId: string, metric: string, value: number, detail?: string): TelemetryMessage {
    const msg: TelemetryMessage = { type: 'telemetry', callId, metric, value, atMs: Date.now(), ...(detail !== undefined ? { detail } : {}) };
    this.backlog.push(msg);
    const text = JSON.stringify(msg);
    for (const ws of this.wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(text);
    return msg;
  }

  close(): void {
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}

/**
 * The harness clock minus the core clock for one exchange, with half the round
 * trip removed — the standard one-sample estimate. Pure, so the arithmetic can
 * be checked against known numbers instead of against a clock that agrees with
 * itself: on one host, returning a constant zero would pass every threshold.
 */
export function clockOffsetMs(coreSentMs: number, harnessMs: number, coreReceivedMs: number): number {
  const roundTrip = coreReceivedMs - coreSentMs;
  return harnessMs - (coreSentMs + roundTrip / 2);
}

/** Largest minus smallest. Pure, for the same reason as clockOffsetMs. */
export function spreadOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values) - Math.min(...values);
}

/**
 * A-30, from the core: N round trips, each estimating the harness clock minus
 * the core clock with half the round trip removed. On one host the offsets are
 * scheduling noise around zero; the SPREAD is the figure that matters, because
 * a constant offset could be corrected and a varying one could not.
 */
export function compareClocks(ws: WebSocket, samples = 100, timeoutMs = 10_000): Promise<ClockComparison> {
  return new Promise((resolve, reject) => {
    const offsets: number[] = [];
    let maxRtt = 0;
    let id = 0;
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`clock comparison timed out after ${offsets.length} of ${samples} samples`));
    }, timeoutMs);

    const send = () => ws.send(JSON.stringify({ type: 'time.ping', id: ++id, coreMs: Date.now() } satisfies TimePing));

    function onMessage(raw: unknown): void {
      let msg: ControlMessage;
      try {
        msg = JSON.parse(String(raw)) as ControlMessage;
      } catch {
        return;
      }
      if (msg.type !== 'time.pong') return;
      const now = Date.now();
      const rtt = now - msg.coreMs;
      maxRtt = Math.max(maxRtt, rtt);
      offsets.push(clockOffsetMs(msg.coreMs, msg.harnessMs, now));
      if (offsets.length < samples) {
        send();
        return;
      }
      clearTimeout(timer);
      ws.off('message', onMessage);
      const sorted = [...offsets].sort((a, b) => a - b);
      resolve({
        samples: offsets.length,
        offsetsMs: offsets,
        spreadMs: spreadOf(sorted),
        medianOffsetMs: sorted[Math.floor(sorted.length / 2)]!,
        maxRoundTripMs: maxRtt,
      });
    }

    ws.on('message', onMessage);
    send();
  });
}

/** Core side. */
export function connectControl(url: string, onTelemetry: (m: TelemetryMessage) => void): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as ControlMessage;
        if (msg.type === 'telemetry') onTelemetry(msg);
      } catch {
        /* not ours */
      }
    });
  });
}
