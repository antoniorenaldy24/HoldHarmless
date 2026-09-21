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

export type ControlMessage = TelemetryMessage | { type: 'hello'; callId: string | null };

/** Harness side: fans telemetry out to every connected core. */
export class ControlServer {
  readonly wss = new WebSocketServer({ noServer: true });
  private readonly backlog: TelemetryMessage[] = [];

  constructor() {
    this.wss.on('connection', (ws) => {
      // A core that connects after the call started still gets its telemetry:
      // ground truth reported before anyone listened is still ground truth.
      for (const m of this.backlog) ws.send(JSON.stringify(m));
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
