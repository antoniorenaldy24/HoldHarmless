/**
 * Agent-turn finalization (§7.6). Each case reproduces a message order seen in
 * a Day-0 log; the logs themselves are not committed, so the orders are
 * restated here as they were observed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentTranscriptAssembler,
  joinDelta,
  type AgentMessage,
  type AgentTurn,
  type LateMaterial,
  type Scheduler,
} from '../src/index.js';

/** A scheduler the test fires by hand. */
function manualScheduler() {
  const timers = new Set<{ fn: () => void; ms: number }>();
  const schedule: Scheduler = (fn, ms) => {
    const t = { fn, ms };
    timers.add(t);
    return () => timers.delete(t);
  };
  const fireAll = () => { for (const t of [...timers]) { timers.delete(t); t.fn(); } };
  return { schedule, fireAll, pending: () => timers.size };
}

function run(messages: AgentMessage[], sched = manualScheduler()) {
  const turns: AgentTurn[] = [];
  const late: LateMaterial[] = [];
  const a = new AgentTranscriptAssembler((t) => turns.push(t), (l) => late.push(l), sched.schedule);
  for (const m of messages) a.handle(m);
  return { turns, late, sched, a };
}

const started = (id: string): AgentMessage => ({ type: 'reply.started', reply_id: id });
const delta = (id: string, d: string): AgentMessage => ({ type: 'transcript.agent.delta', reply_id: id, delta: d });
const final = (id: string, text: string): AgentMessage => ({ type: 'transcript.agent', reply_id: id, text });
const done = (id: string, status = 'completed'): AgentMessage => ({ type: 'reply.done', reply_id: id, status });

describe('agent transcript finalization', () => {
  test('E2 shape: deltas and no final — the synthetic final is emitted on reply.done', () => {
    const { turns } = run([started('r1'), delta('r1', "I'm "), delta('r1', 'an '), delta('r1', 'AI '), delta('r1', 'assistant.'), done('r1')]);
    assert.deepEqual(turns, [{ replyId: 'r1', text: "I'm an AI assistant.", source: 'deltas', status: 'completed' }]);
  });

  test('e-auth2 shape: a final with ZERO deltas is still a turn', () => {
    const { turns } = run([started('r1'), final('r1', 'Please go ahead.'), done('r1')]);
    assert.deepEqual(turns, [{ replyId: 'r1', text: 'Please go ahead.', source: 'api_final', status: 'completed' }]);
  });

  test('when both exist, the API final wins', () => {
    const { turns } = run([started('r1'), delta('r1', 'Got '), delta('r1', 'it'), final('r1', 'Got it, thank you.'), done('r1')]);
    assert.equal(turns[0]!.text, 'Got it, thank you.');
    assert.equal(turns[0]!.source, 'api_final');
  });

  test('an interrupted reply still emits what was transmitted (§7.6)', () => {
    const { turns } = run([started('r1'), delta('r1', 'calling on behalf of '), done('r1', 'interrupted')]);
    assert.equal(turns[0]!.status, 'interrupted');
    assert.equal(turns[0]!.text, 'calling on behalf of');
  });

  test('a tool-call-only reply emits nothing', () => {
    const { turns, sched } = run([started('r1'), done('r1')]);
    sched.fireAll();
    assert.deepEqual(turns, []);
  });

  test('e-reply.CONTAMINATED shape: all text after reply.done is waited for, then emitted once', () => {
    const { turns, sched, a } = run([started('r1'), done('r1'), started('r2'), delta('r1', 'I '), delta('r1', 'need'), delta('r1', 'to')]);
    assert.deepEqual(turns, [], 'nothing emitted while text is still arriving');
    assert.equal(sched.pending(), 1, 'one grace timer, re-armed by each late delta');
    a.handle(delta('r1', 'check'));
    sched.fireAll();
    assert.deepEqual(turns, [{ replyId: 'r1', text: 'I need to check', source: 'deltas', status: 'completed' }]);
  });

  test('a final arriving after reply.done ends the wait at once', () => {
    const { turns, sched } = run([started('r1'), done('r1'), delta('r1', 'I '), final('r1', 'I need to check the status of a claim.')]);
    assert.equal(turns[0]!.text, 'I need to check the status of a claim.');
    assert.equal(sched.pending(), 0);
  });

  test('interleaved replies do not mix: deltas are filed by reply_id', () => {
    const { turns } = run([
      started('r1'), delta('r1', 'first '),
      started('r2'), delta('r2', 'second '),
      delta('r1', 'reply'), done('r1'),
      delta('r2', 'reply'), done('r2'),
    ]);
    assert.deepEqual(turns.map((t) => [t.replyId, t.text]), [['r1', 'first reply'], ['r2', 'second reply']]);
  });

  test('material after emission is reported as late, never re-emitted', () => {
    const { turns, late } = run([started('r1'), delta('r1', 'Hello.'), done('r1'), delta('r1', ' again'), final('r1', 'Hello again.')]);
    assert.equal(turns.length, 1);
    assert.deepEqual(late.map((l) => l.kind), ['delta', 'final']);
  });

  test('flush emits a reply that is done but still waiting', () => {
    const { turns, a } = run([started('r1'), done('r1'), delta('r1', 'bye')]);
    a.flush();
    assert.equal(turns[0]!.text, 'bye');
  });
});

describe('joinDelta', () => {
  test('keeps the spacing the API sent', () => assert.equal(joinDelta('Got ', 'it, '), 'Got it, '));
  test('inserts a space when neither side has one', () => assert.equal(joinDelta('need', 'to'), 'need to'));
  test('does not double a leading space', () => assert.equal(joinDelta('need', ' to'), 'need to'));
  test('an empty side is untouched', () => assert.equal(joinDelta('', 'I '), 'I '));
});
