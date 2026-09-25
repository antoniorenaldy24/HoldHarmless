/**
 * The dashboard's only connection to the system — §11, module 3.8.
 *
 * It fetches the log once and then follows it. What it does NOT do is compute
 * anything: `dashboardView` in apps/core turns the log into what the panels
 * draw, and it is imported here rather than reimplemented, so the screen and
 * the invariant checker are reading the same derivation. A dashboard with its
 * own idea of what the gate was doing is a dashboard that can be confidently
 * wrong.
 *
 * `EventSource` handles reconnection itself and sends `Last-Event-ID`, which
 * the server honours from the log's dense `seq` — so a reader that drops out
 * comes back with the events it missed rather than a hole.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthRequest, CallEvent } from '@holdharmless/events';
import { dashboardView, type DashboardView } from '@holdharmless/core/view';

export type Connection = 'connecting' | 'live' | 'offline';

export type LiveLog = {
  view: DashboardView;
  connection: Connection;
  eventCount: number;
  markHandled: (requestId: string, requeue: boolean) => Promise<void>;
  replay: () => Promise<void>;
};

const EMPTY_VIEW = (requests: readonly AuthRequest[], redact: boolean): DashboardView =>
  dashboardView([], { redact, requests });

export function useLiveLog(redact: boolean): LiveLog {
  const [log, setLog] = useState<CallEvent[]>([]);
  const [requests, setRequests] = useState<AuthRequest[]>([]);
  const [source, setSource] = useState<'live' | 'replay'>('live');
  const [connection, setConnection] = useState<Connection>('connecting');
  // A live call moves the elapsed timer and the hold segment even between
  // events, so the view is recomputed on a slow tick as well as on arrival.
  const [tick, setTick] = useState(() => Date.now());
  const seen = useRef(new Set<number>());

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      const body = (await res.json()) as { log: CallEvent[]; requests: AuthRequest[]; source?: 'live' | 'replay' };
      setSource(body.source ?? 'live');
      seen.current = new Set(body.log.map((e) => e.seq));
      setLog(body.log);
      setRequests(body.requests);
    } catch {
      setConnection('offline');
    }
  }, []);

  useEffect(() => {
    void load();
    const source = new EventSource('/api/stream');
    source.onopen = () => setConnection('live');
    source.onerror = () => setConnection('offline');
    source.onmessage = (message) => {
      setConnection('live');
      const event = JSON.parse(message.data as string) as CallEvent;
      // The server replays from Last-Event-ID after a reconnect, and /api/state
      // may already have carried the same events: seq is what makes them one.
      if (seen.current.has(event.seq)) return;
      seen.current.add(event.seq);
      setLog((current) => [...current, event].sort((a, b) => a.seq - b.seq));
      // A status may have changed with it (panel 1, panel 8's resolved state).
      if (event.t === 'outcome.written') void load();
    };
    const timer = window.setInterval(() => setTick(Date.now()), 500);
    return () => {
      source.close();
      window.clearInterval(timer);
    };
  }, [load]);

  const view = useMemo(() => {
    if (log.length === 0) return EMPTY_VIEW(requests, redact);
    // A replay's events carry the original call's timestamps, so "now" is its
    // last event, not this machine's clock. Ticking wall time against them
    // would report a two-minute call as however long ago it was recorded.
    const nowMs = source === 'replay' ? Date.parse(log[log.length - 1]!.at) : tick;
    return dashboardView(log, { redact, requests, nowMs });
  }, [log, requests, redact, tick, source]);

  const markHandled = useCallback(
    async (requestId: string, requeue: boolean) => {
      await fetch(`/api/escalations/${encodeURIComponent(requestId)}/handled`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requeue }),
      });
      await load();
    },
    [load],
  );

  const replay = useCallback(async () => {
    await fetch('/api/demo/replay', { method: 'POST' });
    seen.current = new Set();
    setLog([]);
    await load();
  }, [load]);

  return { view, connection, eventCount: log.length, markHandled, replay };
}
