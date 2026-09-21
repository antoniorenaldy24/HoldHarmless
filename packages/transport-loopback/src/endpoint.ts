/**
 * The far end of the loopback link — the socket the harness listens on.
 *
 * This is deliberately NOT the harness. It owns the wire and the playout queue;
 * the script engine, DTMF decoding, personas, and telemetry live in
 * apps/ivr-harness and plug in through onPlayed / sendAudio. Keeping the split
 * here means the transport's acceptance tests exercise the real queue without
 * dragging in a script engine.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { BYTES_PER_FRAME, FRAME_MS } from '@holdharmless/audio';
import { DelayLine, type NetworkProfile } from '@holdharmless/transport';
import { createPlayoutQueue, type PlayoutQueue } from './playout.js';
import { parseControl, type CoreToFar, type FarToCore } from './protocol.js';

type Outbound = { k: 'audio'; frame: Uint8Array } | { k: 'control'; msg: FarToCore };

export type LoopbackEndpointOptions = {
  port: number;
  host?: string;
  profile: NetworkProfile;
  /** PLAYOUT_DEPTH_MS, default 200. */
  playoutDepthMs?: number;
  /** Start the 20 ms drain automatically. Tests turn this off to load a queue. */
  autoDrain?: boolean;
  random?: () => number;
};

export interface FarEndSession {
  readonly playout: PlayoutQueue;
  /** Audio toward the core — the IVR, hold music, a representative. */
  sendAudio(frame: Uint8Array): void;
  /** Called for every frame that actually reaches the speaker at the far end. */
  onPlayed(handler: (frame: Uint8Array) => void): void;
  /** Called for every frame as it ARRIVES, before queueing. */
  onReceived(handler: (frame: Uint8Array, atMs: number) => void): void;
  onHangup(handler: () => void): void;
  startDrain(): void;
  stopDrain(): void;
  hangup(): void;
}

export class LoopbackEndpoint {
  readonly #wss: WebSocketServer;
  readonly #options: LoopbackEndpointOptions;
  readonly #sessionHandlers: ((s: FarEndSession) => void)[] = [];

  private constructor(wss: WebSocketServer, options: LoopbackEndpointOptions) {
    this.#wss = wss;
    this.#options = options;
    wss.on('connection', (ws) => this.#accept(ws));
  }

  static listen(options: LoopbackEndpointOptions): Promise<LoopbackEndpoint> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: options.port, host: options.host ?? '127.0.0.1' });
      wss.once('listening', () => resolve(new LoopbackEndpoint(wss, options)));
      wss.once('error', reject);
    });
  }

  /** The URL a LoopbackTransport should dial. */
  url(): string {
    const address = this.#wss.address();
    if (typeof address === 'string' || address === null) throw new Error('endpoint not listening');
    return `ws://${address.address}:${address.port}`;
  }

  onSession(handler: (session: FarEndSession) => void): void {
    this.#sessionHandlers.push(handler);
  }

  close(): Promise<void> {
    for (const client of this.#wss.clients) client.terminate();
    return new Promise((resolve) => this.#wss.close(() => resolve()));
  }

  #accept(ws: WebSocket): void {
    const { profile, random } = this.#options;

    const out = new DelayLine<Outbound>({
      profile,
      ...(random ? { random } : {}),
      deliver: (item) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (item.k === 'audio') ws.send(item.frame, { binary: true });
        else ws.send(JSON.stringify(item.msg));
      },
    });

    const playout = createPlayoutQueue({
      depthMs: this.#options.playoutDepthMs ?? 200,
      onMarkPlayed: (name) => out.push({ k: 'control', msg: { type: 'mark', name } }),
    });

    const playedHandlers: ((f: Uint8Array) => void)[] = [];
    const receivedHandlers: ((f: Uint8Array, at: number) => void)[] = [];
    const hangupHandlers: (() => void)[] = [];
    let drain: NodeJS.Timeout | null = null;

    const session: FarEndSession = {
      playout,
      sendAudio: (frame) => out.push({ k: 'audio', frame }),
      onPlayed: (h) => void playedHandlers.push(h),
      onReceived: (h) => void receivedHandlers.push(h),
      onHangup: (h) => void hangupHandlers.push(h),
      startDrain: () => {
        if (drain !== null) return;
        // One frame per tick at the frame cadence (§10.3).
        drain = setInterval(() => {
          const frame = playout.tick();
          if (frame !== null) for (const h of playedHandlers) h(frame);
        }, FRAME_MS);
      },
      stopDrain: () => {
        if (drain !== null) clearInterval(drain);
        drain = null;
      },
      hangup: () => {
        out.push({ k: 'control', msg: { type: 'hangup' } });
        setTimeout(() => ws.close(), (profile.oneWayDelayMs + profile.jitterMs) * 2 + 20);
      },
    };

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (data.length !== BYTES_PER_FRAME) return;
        const frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
        const at = performance.now();
        for (const h of receivedHandlers) h(frame, at);
        playout.push(frame);
        return;
      }

      const msg = parseControl<CoreToFar>(data.toString('utf8'));
      if (msg === null) return;
      switch (msg.type) {
        case 'mark':
          playout.mark(msg.name);
          break;
        case 'clear':
          out.push({ k: 'control', msg: { type: 'cleared', id: msg.id, marks: playout.clear() } });
          break;
        case 'hangup':
          for (const h of hangupHandlers) h();
          break;
      }
    });

    ws.on('close', () => {
      session.stopDrain();
      out.close();
    });

    if (this.#options.autoDrain ?? true) session.startDrain();
    for (const h of this.#sessionHandlers) h(session);
  }
}
