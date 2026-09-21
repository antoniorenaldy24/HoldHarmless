/**
 * LoopbackTransport — the core's side of the link, and the only CallTransport
 * implementation that exists (ADR-002).
 */

import WebSocket from 'ws';
import { BYTES_PER_FRAME } from '@holdharmless/audio';
import type { GateIntent } from '@holdharmless/events';
import {
  DelayLine,
  gateAdmits,
  gateTransitionRequiresClear,
  type AudioSource,
  type CallTransport,
  type NetworkProfile,
  type TransportCloseCause,
} from '@holdharmless/transport';
import { parseControl, type CoreToFar, type FarToCore } from './protocol.js';

type Outbound = { k: 'audio'; frame: Uint8Array } | { k: 'control'; msg: CoreToFar };

export type LoopbackTransportOptions = {
  /** Injectable for deterministic tests. */
  random?: () => number;
  /** How long clear() waits for the far end before resolving empty. */
  clearTimeoutMs?: number;
};

export class LoopbackTransport implements CallTransport {
  readonly kind = 'loopback' as const;

  #ws: WebSocket | null = null;
  #out: DelayLine<Outbound> | null = null;
  #gate: GateIntent = 'closed';
  #hangingUp = false;
  #nextClearId = 1;
  readonly #pendingClears = new Map<number, (marks: string[]) => void>();
  readonly #options: LoopbackTransportOptions;

  readonly #audioHandlers: ((f: Uint8Array) => void)[] = [];
  readonly #markHandlers: ((n: string) => void)[] = [];
  readonly #faultHandlers: ((k: string) => void)[] = [];
  readonly #closedHandlers: ((c: TransportCloseCause) => void)[] = [];

  constructor(options: LoopbackTransportOptions = {}) {
    this.#options = options;
  }

  dial(endpoint: string, profile: NetworkProfile): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(endpoint);
      ws.binaryType = 'nodebuffer';

      const random = this.#options.random;
      this.#out = new DelayLine<Outbound>({
        profile,
        ...(random ? { random } : {}),
        deliver: (item) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (item.k === 'audio') ws.send(item.frame, { binary: true });
          else ws.send(JSON.stringify(item.msg));
        },
      });

      ws.once('open', () => {
        this.#ws = ws;
        resolve();
      });
      ws.once('error', (err) => {
        if (this.#ws === null) reject(err);
      });

      ws.on('message', (data, isBinary) => this.#onMessage(data as Buffer, isBinary));

      ws.on('close', () => {
        this.#out?.close();
        // Resolve any clear still waiting, rather than leaving a promise that
        // never settles on a dead link.
        for (const done of this.#pendingClears.values()) done([]);
        this.#pendingClears.clear();

        if (this.#hangingUp) return;
        this.#emitClosed('link_drop');
      });
    });
  }

  #onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      if (data.length !== BYTES_PER_FRAME) {
        // §4.4: count it and move on. Never throw from a frame callback.
        for (const h of this.#faultHandlers) h('malformed_frame');
        return;
      }
      const frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
      for (const h of this.#audioHandlers) h(frame);
      return;
    }

    const msg = parseControl<FarToCore>(data.toString('utf8'));
    if (msg === null) {
      for (const h of this.#faultHandlers) h('malformed_frame');
      return;
    }

    switch (msg.type) {
      case 'mark':
        for (const h of this.#markHandlers) h(msg.name);
        break;
      case 'cleared': {
        const done = this.#pendingClears.get(msg.id);
        this.#pendingClears.delete(msg.id);
        done?.(msg.marks);
        break;
      }
      case 'hangup':
        this.#hangingUp = true;
        this.#emitClosed('far_end_hangup');
        this.#ws?.close();
        break;
    }
  }

  sendAudio(mulawFrame: Uint8Array, source: AudioSource): boolean {
    if (!gateAdmits(this.#gate, source)) return false;
    if (this.#out === null || this.#ws === null) return false;
    this.#out.push({ k: 'audio', frame: mulawFrame });
    return true;
  }

  clear(): Promise<string[]> {
    if (this.#out === null) return Promise.resolve([]);
    const id = this.#nextClearId++;
    return new Promise((resolve) => {
      this.#pendingClears.set(id, resolve);
      this.#out!.push({ k: 'control', msg: { type: 'clear', id } });

      const timeout = this.#options.clearTimeoutMs ?? 2000;
      setTimeout(() => {
        if (this.#pendingClears.delete(id)) resolve([]);
      }, timeout).unref();
    });
  }

  mark(name: string): Promise<void> {
    this.#out?.push({ k: 'control', msg: { type: 'mark', name } });
    return Promise.resolve();
  }

  applyGate(intent: GateIntent): void {
    const previous = this.#gate;
    this.#gate = intent;
    // The contract on CallTransport.applyGate: narrowing the gate always clears.
    if (gateTransitionRequiresClear(previous, intent)) void this.clear();
  }

  gate(): GateIntent {
    return this.#gate;
  }

  async hangup(): Promise<void> {
    if (this.#ws === null) return;
    this.#hangingUp = true;
    if (this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ type: 'hangup' } satisfies CoreToFar));
    }
    this.#out?.close();
    this.#ws.close();
  }

  #emitClosed(cause: TransportCloseCause): void {
    for (const h of this.#closedHandlers) h(cause);
  }

  onAudio(handler: (f: Uint8Array) => void): void {
    this.#audioHandlers.push(handler);
  }
  onMark(handler: (n: string) => void): void {
    this.#markHandlers.push(handler);
  }
  onFault(handler: (k: string) => void): void {
    this.#faultHandlers.push(handler);
  }
  onClosed(handler: (c: TransportCloseCause) => void): void {
    this.#closedHandlers.push(handler);
  }
}
