/**
 * The dashboard API — §11, §12, module 3.8.
 *
 * Two things are worth testing here and the rest is plumbing: that the stream
 * is resumable (a reader that drops out misses nothing, which is the whole
 * reason the log has a dense `seq`), and that the dashboard can change exactly
 * the one thing §11 permits it to change, and nothing else.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthRequest } from '@holdharmless/events';
import { createEventLog, createWorkQueue, playDemoCall, startDashboardServer, DEMO_SCRIPT } from '../src/index.js';

const request = (over: Partial<AuthRequest> = {}): AuthRequest => ({
  id: 'R1', patientRef: 'p', memberId: 'm', patientDob: '1970-01-01',
  cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-01',
  payerId: 'payer', payerEndpoint: 'ws://x', clinicName: 'Clinic', clinicCallbackPhone: '555',
  priority: 'routine', clinicalSummary: 's', status: 'escalated', attempts: 1, ...over,
});

async function serve(over: { demoMode?: boolean; requests?: AuthRequest[] } = {}) {
  const requests = over.requests ?? [request()];
  const log = createEventLog({ callId: 'CALL-T' });
  const queue = createWorkQueue({ requests, emit: (b) => log.append(b) });
  const controls: string[] = [];
  const server = await startDashboardServer({
    log, queue,
    requests: () => requests,
    demoMode: over.demoMode ?? false,
    onDemoControl: (c) => controls.push(c),
  });
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  after(() => server.close());
  return { log, queue, server, url, controls, requests };
}

describe('the dashboard reads the log', () => {
  test('/api/state carries the log and the queue in one request', async () => {
    const s = await serve();
    s.log.append({ t: 'call.started', requestId: 'R1', attempts: 1, priority: 'routine', networkProfile: 'TELEPHONY' });
    const body = await (await fetch(s.url('/api/state'))).json() as { callId: string; log: unknown[]; requests: unknown[] };
    assert.equal(body.callId, 'CALL-T');
    assert.equal(body.log.length, 1);
    assert.equal(body.requests.length, 1);
    await s.server.close();
  });

  test('a reader that reconnects resumes from where it stopped, and misses nothing', async () => {
    // This is what the dense `seq` on the log is for. EventSource sends back
    // Last-Event-ID by itself; the test does by hand what the browser does.
    const s = await serve();
    for (let i = 0; i < 5; i++) s.log.append({ t: 'hold.tick', elapsedMs: i * 1000, rampStep: 1 });

    const res = await fetch(s.url('/api/stream'), { headers: { 'last-event-id': '1' } });
    const reader = res.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    const ids = [...chunk.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepEqual(ids, [2, 3, 4], 'everything after the last one it saw, and nothing it already had');
    await reader.cancel();
    await s.server.close();
  });

  test('a live append reaches an open stream', async () => {
    const s = await serve();
    const res = await fetch(s.url('/api/stream'));
    const reader = res.body!.getReader();
    s.log.append({ t: 'auth_number.captured', value: 'A472-91' });
    // The first read is the comment line that opens the stream, so read until
    // a data frame arrives rather than assuming which chunk it lands in.
    const decoder = new TextDecoder();
    let seen = '';
    for (let i = 0; i < 5 && !seen.includes('data:'); i++) {
      seen += decoder.decode((await reader.read()).value);
    }
    assert.match(seen, /auth_number.captured/);
    assert.match(seen, /A472-91/);
    await reader.cancel();
    await s.server.close();
  });
});

describe('the dashboard may change exactly one thing (§11)', () => {
  test('mark handled writes escalated_resolved', async () => {
    const s = await serve();
    const res = await fetch(s.url('/api/escalations/R1/handled'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requeue: false }),
    });
    assert.equal(res.status, 200);
    assert.equal(s.queue.get('R1')?.status, 'escalated_resolved');
    await s.server.close();
  });

  test('"handled — call again" is the only path back out of a final status', async () => {
    const s = await serve();
    await fetch(s.url('/api/escalations/R1/handled'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requeue: true }),
    });
    assert.equal(s.queue.get('R1')?.status, 'queued');
    assert.equal(s.queue.get('R1')?.attempts, 0);
    await s.server.close();
  });

  test('an unknown request is refused rather than silently accepted', async () => {
    const s = await serve();
    const res = await fetch(s.url('/api/escalations/nope/handled'), { method: 'POST' });
    assert.equal(res.status, 404);
    await s.server.close();
  });

  test('demo controls are refused when DEMO_MODE is off, and say why', async () => {
    const off = await serve({ demoMode: false });
    const refused = await fetch(off.url('/api/demo/replay'), { method: 'POST' });
    assert.equal(refused.status, 403);
    assert.match((await refused.json() as { error: string }).error, /DEMO_MODE/);
    assert.deepEqual(off.controls, []);
    await off.server.close();

    const on = await serve({ demoMode: true });
    assert.equal((await fetch(on.url('/api/demo/replay'), { method: 'POST' })).status, 200);
    assert.deepEqual(on.controls, ['replay']);
    await on.server.close();
  });

  test('there is no route for anything else', async () => {
    const s = await serve({ demoMode: true });
    assert.equal((await fetch(s.url('/api/queue/R1/status'), { method: 'POST' })).status, 404);
    assert.equal((await fetch(s.url('/api/demo/force'), { method: 'POST' })).status, 400);
    await s.server.close();
  });
});

describe('the stored call (§19.3)', () => {
  test('it plays through the real append path, in order, and can be stopped', () => {
    const log = createEventLog({ callId: 'CALL-D' });
    const timers: { fn: () => void; ms: number }[] = [];
    const player = playDemoCall({
      log,
      speed: 1,
      schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
      cancel: () => {},
    });
    // Fire the first half in time order, as setTimeout would.
    const ordered = [...timers].sort((a, b) => a.ms - b.ms);
    for (const t of ordered.slice(0, 10)) t.fn();
    assert.equal(log.length, 10);
    assert.equal(log.events()[0]?.t, 'call.started');
    assert.ok(log.events().every((e, i) => e.seq === i), 'seq is dense, so replay can point at an event');

    player.stop();
    for (const t of ordered.slice(10)) t.fn();
    assert.equal(log.length, 10, 'a stopped player appends nothing further');
  });

  test('the script is a call, not a list of events: it ends written, closed and DONE', () => {
    // A demo whose call never finishes would leave panel 2 running forever and
    // panel 7 with no cost — and nobody would notice until the rehearsal.
    const kinds = DEMO_SCRIPT.map((s) => s.body.t);
    assert.equal(kinds[0], 'call.started');
    assert.equal(kinds[kinds.length - 1], 'call.ended');
    assert.ok(kinds.includes('outcome.written'), 'ADR-015: the outcome is written before the closing');
    assert.ok(
      DEMO_SCRIPT.findIndex((s) => s.body.t === 'outcome.written') <
        DEMO_SCRIPT.findIndex((s) => s.body.t === 'turn.transcribed' && s.body.isClosing),
      'and before it, in time as well as in principle',
    );
    assert.ok(DEMO_SCRIPT.some((s) => s.body.t === 'phase.changed' && s.body.to === 'DONE'));
  });
});

describe('the log', () => {
  test('a reader that throws does not take the call with it', () => {
    // The dashboard is a reader (§11). A broken reader is a broken reader —
    // the append must still happen, the next subscriber must still be told,
    // and the failure must be visible rather than swallowed.
    const errors: unknown[] = [];
    const log = createEventLog({ callId: 'CALL-R', onSubscriberError: (e) => errors.push(e) });
    const quiet: number[] = [];
    log.subscribe(() => { throw new Error('reader exploded'); });
    log.subscribe((e) => quiet.push(e.seq));

    const event = log.append({ t: 'auth_number.captured', value: 'A472-91' });

    assert.equal(event.seq, 0, 'the append returned normally');
    assert.equal(log.length, 1, 'and the event is in the log');
    assert.deepEqual(quiet, [0], 'the second reader was still told');
    assert.equal(errors.length, 1, 'and the broken one was reported, not swallowed');
  });

  test('unsubscribing stops the notifications', () => {
    const log = createEventLog({ callId: 'CALL-R' });
    const seen: number[] = [];
    const off = log.subscribe((e) => seen.push(e.seq));
    log.append({ t: 'hold.tick', elapsedMs: 0, rampStep: 1 });
    off();
    log.append({ t: 'hold.tick', elapsedMs: 1000, rampStep: 1 });
    assert.deepEqual(seen, [0]);
    assert.equal(log.length, 2);
  });
});
