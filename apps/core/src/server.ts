/**
 * The dashboard's API — §11, §12, §14, module 3.8.
 *
 * The dashboard is a reader (§11). It gets the LOG, not a rendered view, and
 * computes what it draws with `dashboardView` — the same function, in the same
 * package, that this file's tests exercise. Sending a pre-rendered view would
 * put a second copy of that derivation on the wire and let the two drift; and
 * sending the log is what lets the redaction toggle work without a round trip,
 * because redaction is a question about how to show what happened, not about
 * what happened.
 *
 * SERVER-SENT EVENTS, NOT A WEBSOCKET, and §12's diagram says "WS + REST". The
 * stream here is strictly one-way — events out, commands in over POST — and for
 * that SSE needs no dependency, no upgrade handshake, and no reconnect logic,
 * because `EventSource` reconnects by itself and replays from `Last-Event-ID`,
 * which this server honours. A WebSocket would be the right answer the moment
 * the dashboard needs to say something on the same channel; it does not.
 *
 * THE ONE COMMAND. §11 allows the dashboard to send exactly two kinds of thing:
 * "mark handled" on panel 8, and the §19.3 demo controls. The demo controls are
 * refused unless DEMO_MODE is on, because a panel not shown to judges is still
 * reachable by anyone who can reach the port.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuthRequest, CallEvent } from '@holdharmless/events';
import type { EventLog } from './log.js';
import type { WorkQueue } from './work-queue.js';

export type DemoControl = 'replay' | 'stop';

export type ServerOptions = {
  log: EventLog;
  queue: WorkQueue;
  /** Everything panel 1 shows. A function, because the queue mutates in place. */
  requests: () => readonly AuthRequest[];
  /** §19.3 controls are refused when this is false. */
  demoMode?: boolean;
  onDemoControl?: (control: DemoControl) => void;
  port?: number;
};

export interface DashboardServer {
  readonly port: number;
  close(): Promise<void>;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // The dashboard is served by Vite on another port during development.
    'access-control-allow-origin': '*',
  });
  res.end(payload);
};

const readBody = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export async function startDashboardServer(options: ServerOptions): Promise<DashboardServer> {
  const subscribers = new Set<http.ServerResponse>();

  const send = (res: http.ServerResponse, event: CallEvent): void => {
    // `id:` is what EventSource sends back as Last-Event-ID after a reconnect,
    // and `seq` is dense, so a reader that drops out misses nothing.
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const unsubscribe = options.log.subscribe((event) => {
    for (const res of subscribers) {
      try {
        send(res, event);
      } catch {
        subscribers.delete(res);
      }
    }
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end();
      return;
    }

    // Everything the dashboard needs to draw every panel, in one request.
    if (req.method === 'GET' && path === '/api/state') {
      // `source` tells the dashboard whether "now" means the wall clock. A
      // replay's events carry the ORIGINAL call's timestamps, so an elapsed
      // timer ticking against this machine's clock would be meaningless.
      json(res, 200, {
        callId: options.log.callId,
        source: options.demoMode ? 'replay' : 'live',
        log: options.log.events(),
        requests: options.requests(),
      });
      return;
    }

    if (req.method === 'GET' && path === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      // Open the stream with a comment line. Without a byte on the wire the
      // response headers may sit in a buffer — a proxy's, or the client's —
      // and a reader waiting for its first event waits for the first thing
      // that happens on the call, which on a quiet line is a long time.
      res.write(': stream open\n\n');

      // A reconnecting reader says where it got to; a fresh one gets nothing
      // here and calls /api/state for the history.
      const lastId = Number(req.headers['last-event-id']);
      if (Number.isFinite(lastId)) for (const event of options.log.since(lastId + 1)) send(res, event);
      subscribers.add(res);
      req.on('close', () => subscribers.delete(res));
      return;
    }

    // Panel 8's button, and the only state the dashboard may change (§11).
    const handled = /^\/api\/escalations\/([^/]+)\/handled$/.exec(path);
    if (req.method === 'POST' && handled) {
      void readBody(req).then((body) => {
        const requestId = decodeURIComponent(handled[1]!);
        if (!options.queue.get(requestId)) {
          json(res, 404, { ok: false, error: `no request ${requestId}` });
          return;
        }
        options.queue.markEscalationHandled(requestId, body['requeue'] === true);
        json(res, 200, { ok: true, status: options.queue.get(requestId)?.status });
      });
      return;
    }

    const demo = /^\/api\/demo\/([a-z]+)$/.exec(path);
    if (req.method === 'POST' && demo) {
      if (!options.demoMode) {
        // Not 404: the endpoint exists and is switched off, and saying so is
        // more useful than pretending the route was never built.
        json(res, 403, { ok: false, error: 'DEMO_MODE is off (§19.3)' });
        return;
      }
      const control = demo[1] as DemoControl;
      if (control !== 'replay' && control !== 'stop') {
        json(res, 400, { ok: false, error: `unknown demo control ${control}` });
        return;
      }
      options.onDemoControl?.(control);
      json(res, 200, { ok: true, control });
      return;
    }

    json(res, 404, { ok: false, error: `no route for ${req.method} ${path}` });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    async close(): Promise<void> {
      unsubscribe();
      for (const res of subscribers) res.end();
      subscribers.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
