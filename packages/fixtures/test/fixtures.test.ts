/**
 * Acceptance criteria for module 1.9 (§21 week 1):
 *   "Record and replay with zero API calls; replay reproduces the identical
 *    event sequence; networkProfile recorded"
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AuthRequest } from '@holdharmless/events';
import { AgentTranscriptAssembler, type AgentMessage } from '@holdharmless/agent';
import { matchDisclosure } from '@holdharmless/detectors';
import {
  FixtureRecorder,
  FIXTURE_ROOT,
  audioFrames,
  firstDifference,
  loadFixture,
  listFixtures,
  play,
  ReplayDivergence,
  saveFixture,
  validateFixture,
  type Fixture,
  type PipelineFactory,
  type TimelineInput,
} from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const REQUEST: AuthRequest = {
  id: 'SYN-REQ-0009',
  patientRef: 'SYN-PT-0009',
  memberId: 'SYN-M-10001',
  patientDob: '1970-01-01',
  cptCode: '72148',
  icdCode: 'M54.16',
  providerNpi: '1234567890', // fails the NPI check digit, so cannot be a real NPI
  serviceDate: '2026-10-01',
  payerId: 'SYN-PAYER-1',
  payerEndpoint: 'ws://127.0.0.1:8081/call',
  clinicName: 'Riverside Synthetic Clinic',
  clinicCallbackPhone: '555-0142',
  priority: 'routine',
  clinicalSummary: 'Synthetic summary.',
  status: 'in_progress',
  attempts: 0,
};

const AGENT_TYPES = new Set(['reply.started', 'transcript.agent.delta', 'transcript.agent', 'reply.done']);

/**
 * A real pipeline from what exists in week 1: agent-turn finalization (§7.6)
 * feeding the disclosure detector. It arms a real timer — the grace wait —
 * which is what makes replaying it a test of the virtual clock and not only of
 * the file format.
 */
const transcriptPipeline = (graceMs: number, detect = true): PipelineFactory => (io) => {
  const assembler = new AgentTranscriptAssembler(
    (turn) => {
      io.emit({ t: 'turn.transcribed', speaker: 'agent', text: turn.text, partial: false, redactable: false, isClosing: false });
      if (detect && matchDisclosure(turn.text)) io.emit({ t: 'disclosure.delivered', partyIndex: 0, quote: turn.text });
    },
    () => {},
    io.schedule,
    graceMs,
  );
  return {
    onItem(item) {
      if (item.kind !== 'server') return;
      if (AGENT_TYPES.has(String(item.msg['type']))) assembler.handle(item.msg as unknown as AgentMessage);
      if (item.msg['type'] === 'transcript.user') {
        io.emit({ t: 'turn.transcribed', speaker: 'far_end', text: String(item.msg['text']), partial: false, redactable: true, isClosing: false });
      }
    },
    end: () => assembler.flush(),
  };
};

const srv = (msg: Record<string, unknown>): TimelineInput => ({ kind: 'server', msg });
const FRAME = Buffer.alloc(160, 0xff).toString('base64'); // 20 ms of μ-law silence

/**
 * A call as a live session would deliver it, including the Day-0 contaminated
 * shape: r2's reply.done arrives before its text, so the pipeline must wait.
 */
const SCRIPT: { afterMs: number; input: TimelineInput }[] = [
  { afterMs: 0, input: { kind: 'far_end_audio', frame: FRAME } },
  { afterMs: 5, input: srv({ type: 'transcript.user', text: 'Prior authorization, how can I help?' }) },
  { afterMs: 5, input: srv({ type: 'reply.started', reply_id: 'r1' }) },
  { afterMs: 2, input: srv({ type: 'transcript.agent.delta', reply_id: 'r1', delta: "Hi, I'm an AI assistant " }) },
  { afterMs: 2, input: srv({ type: 'transcript.agent.delta', reply_id: 'r1', delta: 'calling on behalf of Riverside.' }) },
  { afterMs: 2, input: { kind: 'agent_audio', frame: FRAME } },
  { afterMs: 2, input: srv({ type: 'reply.done', reply_id: 'r1', status: 'completed' }) },
  { afterMs: 5, input: srv({ type: 'reply.started', reply_id: 'r2' }) },
  { afterMs: 2, input: srv({ type: 'reply.done', reply_id: 'r2', status: 'completed' }) },
  { afterMs: 10, input: srv({ type: 'transcript.agent.delta', reply_id: 'r2', delta: 'I ' }) },
  { afterMs: 10, input: srv({ type: 'transcript.agent.delta', reply_id: 'r2', delta: 'need' }) },
  { afterMs: 10, input: srv({ type: 'transcript.agent.delta', reply_id: 'r2', delta: 'to' }) },
  { afterMs: 2, input: { kind: 'client', msg: { type: 'input.audio', audio: FRAME } } },
];
const GRACE_MS = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Blocks the event loop, as a GC pause or a loaded CI machine does. */
function stall(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* spin */ }
}

async function recordLive(stallBeforeStep?: number): Promise<Fixture> {
  const rec = new FixtureRecorder({
    id: 'SYN-FX-live',
    label: 'scripted live call',
    callId: 'SYN-CALL-0009',
    networkProfile: 'TELEPHONY',
    request: REQUEST,
    pipeline: transcriptPipeline(GRACE_MS),
  });
  for (const [k, step] of SCRIPT.entries()) {
    await sleep(step.afterMs);
    if (k === stallBeforeStep) stall(GRACE_MS * 2.5);
    rec.record(step.input);
  }
  await sleep(GRACE_MS * 3); // let the grace timer run out on the wall clock
  return rec.finish({ partiesUsed: 1, fieldsRequested: [], expectedStatus: 'approved' });
}

describe('record, then replay', () => {
  test('replay reproduces the identical event sequence', async () => {
    const fx = await recordLive();
    // What the LIVE run produced depends on the wall clock: a stall of more than
    // GRACE_MS - 10 ms between r2's deltas would split its turn in two. That is
    // not a failure — replaying it must reproduce the split — so only what no
    // stall can change is asserted about the live run itself.
    assert.ok(fx.events.some((e) => e.t === 'disclosure.delivered'), 'r1 is a disclosure');
    assert.ok(fx.events.some((e) => e.t === 'turn.transcribed' && e.text.startsWith('I')), "r2's text arrived after its reply.done");

    const replayed = play(fx, transcriptPipeline(GRACE_MS));
    assert.equal(firstDifference(fx.events, replayed), null);
  });

  test('a live run whose event loop stalled still replays identically', async () => {
    // Stall just before r2's "need" delta: the grace timer is overdue when the
    // delta is recorded, and live, the delta is still handled first.
    const needStep = SCRIPT.findIndex((st) => st.input.kind === 'server' && st.input.msg['delta'] === 'need');
    const fx = await recordLive(needStep);
    assert.equal(firstDifference(fx.events, play(fx, transcriptPipeline(GRACE_MS))), null);
  });

  test('two replays are identical to the millisecond, `at` included', async () => {
    const fx = await recordLive();
    assert.deepEqual(play(fx, transcriptPipeline(GRACE_MS)), play(fx, transcriptPipeline(GRACE_MS)));
  });

  test('a replayed event is stamped with the time it happened, not the time the replay ended', async () => {
    const fx = await recordLive();
    const start = Date.parse(fx.recordedAt);
    // r2's turn is emitted by the grace timer. Recorded mode: when it fired live.
    const fired = fx.timeline.filter((i) => i.kind === 'timer').at(-1)!;
    assert.equal(Date.parse(play(fx, transcriptPipeline(GRACE_MS)).at(-1)!.at), start + Math.floor(fired.atMs));
    // Virtual mode: GRACE_MS after the first r2 delta not followed by another
    // within GRACE_MS — the last one, unless the recording stalled.
    const deltas = fx.timeline.filter((i) => i.kind === 'server' && i.msg['reply_id'] === 'r2' && i.msg['type'] === 'transcript.agent.delta');
    const ends = deltas.find((d, k) => k === deltas.length - 1 || deltas[k + 1]!.atMs > d.atMs + GRACE_MS)!;
    const virtual = play(fx, transcriptPipeline(GRACE_MS), { timers: 'virtual' });
    assert.equal(Date.parse(virtual.at(-1)!.at), start + Math.floor(ends.atMs + GRACE_MS));
  });

  test('the live timer firing is recorded on the timeline', async () => {
    const fx = await recordLive();
    // At least r2's grace wait ran out; more if the loop stalled (see above).
    assert.ok(fx.timeline.filter((i) => i.kind === 'timer').length >= 1);
  });

  test('a changed pipeline is detected as a difference', async () => {
    const fx = await recordLive();
    const diff = firstDifference(fx.events, play(fx, transcriptPipeline(GRACE_MS, false)));
    assert.match(diff ?? '', /disclosure\.delivered/);
  });

  test('the recorded networkProfile is kept, and the audio frames recovered', async () => {
    const fx = await recordLive();
    assert.equal(fx.networkProfile, 'TELEPHONY');
    assert.equal(audioFrames(fx).length, 1);
    assert.equal(audioFrames(fx, 'agent_audio')[0]!.length, 160);
  });

  test('an event emitted after finish is refused', () => {
    let emitLater: (() => void) | undefined;
    const rec = new FixtureRecorder({
      id: 'SYN-FX-late', label: 'late', callId: 'c', networkProfile: 'CLEAN', request: REQUEST,
      pipeline: (io) => ({ onItem() { emitLater = () => io.emit({ t: 'dtmf.sent', digits: '1', reason: 'x' }); } }),
    });
    rec.record(srv({ type: 'session.ready' }));
    rec.finish({ partiesUsed: 1, fieldsRequested: [], expectedStatus: 'approved' });
    assert.throws(() => emitLater!(), /after the recording finished/);
  });
});

describe('a stalled event loop (the 1-in-80 failure, made deterministic)', () => {
  // Live: the grace timer was due at 60 ms, but the loop stalled; the next delta
  // was handled at 70 ms, BEFORE the overdue timer, which re-armed it. The
  // timer finally fired at 140 ms. Recorded exactly as a live run records it.
  const d = (atMs: number, delta: string) => ({ atMs, kind: 'server' as const, msg: { type: 'transcript.agent.delta', reply_id: 'r', delta } });
  const stalled: Fixture = {
    formatVersion: 1, id: 'SYN-FX-stall', label: '', networkProfile: 'TELEPHONY', recordedAt: '2026-09-22T00:00:00.000Z',
    request: REQUEST, groundTruth: { partiesUsed: 1, fieldsRequested: [], expectedStatus: 'approved' },
    timeline: [
      { atMs: 0, kind: 'server', msg: { type: 'reply.started', reply_id: 'r' } },
      { atMs: 0, kind: 'server', msg: { type: 'reply.done', reply_id: 'r', status: 'completed' } },
      d(0, 'I '),
      d(70, 'need'),
      // Timers armed: #0 on reply.done, #1 on "I ", #2 on "need" (each cancelling
      // the one before). #2 is the one that fired.
      { atMs: 140, kind: 'timer', id: 2 },
    ],
    events: [],
  };
  const text = (events: ReturnType<typeof play>) => events.map((e) => (e.t === 'turn.transcribed' ? e.text : e.t));

  test('recorded mode reproduces the live order', () => {
    assert.deepEqual(text(play(stalled, transcriptPipeline(GRACE_MS))), ['I need']);
  });

  test('virtual mode recomputes the timer, and so gives the answer a live run did NOT', () => {
    assert.deepEqual(text(play(stalled, transcriptPipeline(GRACE_MS), { timers: 'virtual' })), ['I']);
  });

  test('a pipeline that arms timers differently from the live run is reported as divergent', () => {
    const noTimers: PipelineFactory = () => ({ onItem() {} });
    assert.throws(() => play(stalled, noTimers), /armed only 0/);
  });

  test('a recorded firing of a timer the replay cancelled is divergent, not ignored', () => {
    const wrong: Fixture = { ...stalled, timeline: stalled.timeline.map((i) => (i.kind === 'timer' ? { ...i, id: 1 } : i)) };
    assert.throws(() => play(wrong, transcriptPipeline(GRACE_MS)), ReplayDivergence);
  });
});

describe('zero API calls', () => {
  test('a replay opens no socket and makes no request', async () => {
    const fx = await recordLive();
    const attempts: string[] = [];
    const origConnect = net.Socket.prototype.connect;
    const origFetch = globalThis.fetch;
    const g = globalThis as { WebSocket?: unknown };
    const origWs = g.WebSocket;
    net.Socket.prototype.connect = function (...args: unknown[]) { attempts.push(`net ${JSON.stringify(args[0])}`); throw new Error('network is forbidden in replay'); } as typeof origConnect;
    globalThis.fetch = (async (u: unknown) => { attempts.push(`fetch ${String(u)}`); throw new Error('network is forbidden in replay'); }) as typeof fetch;
    g.WebSocket = class { constructor(u: string) { attempts.push(`ws ${u}`); throw new Error('network is forbidden in replay'); } };
    try {
      play(fx, transcriptPipeline(GRACE_MS));
    } finally {
      net.Socket.prototype.connect = origConnect;
      globalThis.fetch = origFetch;
      g.WebSocket = origWs;
    }
    assert.deepEqual(attempts, []);
  });

  test('the player and its imports name no network module', () => {
    for (const f of ['player.ts', 'pipeline.ts', 'format.ts']) {
      const src = fs.readFileSync(path.join(HERE, '../src', f), 'utf8');
      assert.doesNotMatch(src, /from ['"](node:)?(net|http|https|tls|dgram|ws|undici)['"]|WebSocket\(|fetch\(/, f);
    }
  });
});

describe('the virtual clock', () => {
  const fx = (atMs: number[]): Fixture => ({
    formatVersion: 1, id: 'SYN-FX-clock', label: '', networkProfile: 'CLEAN', recordedAt: '2026-09-22T00:00:00.000Z',
    request: REQUEST, groundTruth: { partiesUsed: 1, fieldsRequested: [], expectedStatus: 'approved' },
    timeline: atMs.map((atMs) => ({ atMs, kind: 'server' as const, msg: { type: 'x' } })), events: [],
  });

  test('at equal time an item runs before a timer; timers run in the order armed', () => {
    const order: string[] = [];
    play(fx([0, 100]), (io) => {
      let n = 0;
      return {
        onItem() {
          order.push(`item@${io.nowMs()}`);
          if (n++ === 0) {
            io.schedule(() => order.push(`A@${io.nowMs()}`), 100);
            io.schedule(() => order.push(`B@${io.nowMs()}`), 100);
            io.schedule(() => order.push(`C@${io.nowMs()}`), 50);
          }
        },
      };
    }, { timers: 'virtual' });
    assert.deepEqual(order, ['item@0', 'C@50', 'item@100', 'A@100', 'B@100']);
  });

  test('a cancelled timer never fires; timers pending at the end still run', () => {
    const fired: string[] = [];
    play(fx([0]), (io) => ({
      onItem() {
        const cancel = io.schedule(() => fired.push('cancelled'), 10);
        cancel();
        io.schedule(() => fired.push('late'), 5000);
      },
    }), { timers: 'virtual' });
    assert.deepEqual(fired, ['late']);
  });

  test('a timer that re-arms itself forever is stopped', () => {
    assert.throws(
      () => play(fx([0]), (io) => ({ onItem() { const loop = () => { io.schedule(loop, 1); }; loop(); } }), { timers: 'virtual', maxTimerFirings: 1000 }),
      /re-arms itself forever/,
    );
  });

  test('a timeline that goes backwards is refused', () => {
    assert.throws(() => play(fx([10, 5]), () => ({ onItem() {} })), /goes backwards/);
  });
});

describe('fixtures on disk', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hh-fx-'));

  test('save then load round-trips exactly', async () => {
    const fx = await recordLive();
    const root = tmp();
    const dir = saveFixture(fx, root);
    assert.deepEqual(loadFixture(dir), fx);
    assert.deepEqual(listFixtures(root), ['SYN-FX-live']);
    assert.equal(firstDifference(fx.events, play(loadFixture(dir), transcriptPipeline(GRACE_MS))), null);
  });

  test('INV-12: a request that could be real is refused on save', async () => {
    const fx = await recordLive();
    const real = { ...fx, request: { ...fx.request, providerNpi: '1234567893' } }; // passes the check digit
    assert.throws(() => saveFixture(real, tmp()), /INV-12: request\.providerNpi/);
  });

  test('a hand-edited fixture is validated on load', async () => {
    const dir = saveFixture(await recordLive(), tmp());
    const metaFile = path.join(dir, 'fixture.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, networkProfile: 'FAST' }));
    assert.throws(() => loadFixture(dir), /networkProfile "FAST"/);
  });

  test('a truncated timeline is an error, not a shorter fixture', async () => {
    const dir = saveFixture(await recordLive(), tmp());
    const file = path.join(dir, 'timeline.jsonl');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, -20));
    assert.throws(() => loadFixture(dir), /timeline\.jsonl:\d+ is not valid JSON/);
  });

  test('validateFixture reports seq gaps', async () => {
    const fx = await recordLive();
    assert.match(validateFixture({ ...fx, events: fx.events.slice(1) }).join('\n'), /seq 2, expected 1/);
  });
});

describe('fixture data stays out of the repository (§6.6)', () => {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });

  test('the default data root is ignored by git', () => {
    for (const f of ['fixture.json', 'timeline.jsonl', 'events.jsonl']) {
      const probe = path.relative(ROOT, path.join(FIXTURE_ROOT, 'SYN-FX-any', f)).split(path.sep).join('/');
      assert.equal(git('check-ignore', '-q', probe).status, 0, `${probe} is not ignored`);
    }
  });

  test('nothing under packages/fixtures is tracked except code', () => {
    const tracked = git('ls-files', 'packages/fixtures').stdout.split('\n').filter(Boolean);
    const stray = tracked.filter((f) => !/^packages\/fixtures\/(src|test)\/[^/]+\.ts$|^packages\/fixtures\/package\.json$/.test(f));
    assert.deepEqual(stray, []);
  });
});
