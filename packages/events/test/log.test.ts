/**
 * Acceptance criteria for module 1.1 (§21 week 1):
 *   "Types compile; EventLog appends and reads JSONL; a truncated final line is
 *    discarded without throwing"
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JsonlEventLog, parseJsonl } from '../src/log.js';
import { FINAL_STATUSES, PRODUCER_KINDS, isFinalStatus, isSynchronousEvent } from '../src/types.js';
import type { CallEvent } from '../src/types.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hh-events-'));

describe('JsonlEventLog', () => {
  test('appends and reads back in order', async () => {
    const log = new JsonlEventLog({ dir: tmp() });

    await log.append({ callId: 'c1', t: 'call.started', requestId: 'r1', attempts: 0, priority: 'routine', networkProfile: 'TELEPHONY' });
    await log.append({ callId: 'c1', t: 'channel.changed', from: 'DIALING', to: 'IVR', producer: { kind: 'transport', cause: 'link_established' } });
    await log.append({ callId: 'c1', t: 'dtmf.sent', digits: '2', reason: 'provider services' });

    const events = log.readSync('c1');
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.t), ['call.started', 'channel.changed', 'dtmf.sent']);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  });

  test('seq is monotonic PER callId, not global (§9.3)', async () => {
    const log = new JsonlEventLog({ dir: tmp() });

    await log.append({ callId: 'a', t: 'hold.tick', elapsedMs: 1000, rampStep: 0 });
    await log.append({ callId: 'b', t: 'hold.tick', elapsedMs: 1000, rampStep: 0 });
    await log.append({ callId: 'a', t: 'hold.tick', elapsedMs: 2000, rampStep: 0 });

    assert.deepEqual(log.readSync('a').map((e) => e.seq), [1, 2]);
    assert.deepEqual(log.readSync('b').map((e) => e.seq), [1]);
  });

  test('append returns the assigned seq', async () => {
    const log = new JsonlEventLog({ dir: tmp() });
    assert.equal(await log.append({ callId: 'c', t: 'hold.tick', elapsedMs: 0, rampStep: 0 }), 1);
    assert.equal(await log.append({ callId: 'c', t: 'hold.tick', elapsedMs: 20, rampStep: 0 }), 2);
  });

  test('async read yields the same events as readSync', async () => {
    const log = new JsonlEventLog({ dir: tmp() });
    await log.append({ callId: 'c', t: 'reference.captured', reference: 'REF-4417-B', kind: 'call_reference' });

    const collected: CallEvent[] = [];
    for await (const e of log.read('c')) collected.push(e);
    assert.deepEqual(collected, log.readSync('c'));
  });

  test('reading an unknown callId returns empty rather than throwing', async () => {
    const log = new JsonlEventLog({ dir: tmp() });
    assert.deepEqual(log.readSync('never-existed'), []);
    const collected: CallEvent[] = [];
    for await (const e of log.read('never-existed')) collected.push(e);
    assert.deepEqual(collected, []);
  });

  test('subscribers see every append, and one that throws does not break the writer', async () => {
    const log = new JsonlEventLog({ dir: tmp() });
    const seen: string[] = [];

    log.subscribe(() => {
      throw new Error('a misbehaving dashboard');
    });
    const unsubscribe = log.subscribe((e) => seen.push(e.t));

    await log.append({ callId: 'c', t: 'hold.tick', elapsedMs: 0, rampStep: 0 });
    unsubscribe();
    await log.append({ callId: 'c', t: 'hold.tick', elapsedMs: 20, rampStep: 0 });

    assert.deepEqual(seen, ['hold.tick']);
    assert.equal(log.readSync('c').length, 2, 'both appends must still have been written');
  });

  test('a truncated final line is discarded without throwing (acceptance 1.1)', async () => {
    const dir = tmp();
    const log = new JsonlEventLog({ dir });

    await log.append({ callId: 'c', t: 'call.started', requestId: 'r', attempts: 0, priority: 'routine', networkProfile: 'TELEPHONY' });
    await log.append({ callId: 'c', t: 'gate.changed', from: 'open', to: 'closed', channel: 'HOLD', holdSuspected: true, clearSent: true, producer: { kind: 'semantic', seq: 7 } });

    // Simulate a crash partway through writing a third record.
    fs.appendFileSync(log.fileFor('c'), '{"seq":3,"callId":"c","at":"2026-09-21T0');

    const events = log.readSync('c');
    assert.equal(events.length, 2, 'the truncated tail is dropped, the good records survive');
    assert.equal(events[1]?.t, 'gate.changed');
  });

  test('corruption in the MIDDLE throws rather than being silently dropped', () => {
    assert.throws(
      () => parseJsonl('{"seq":1,"t":"hold.tick"}\nNOT JSON\n{"seq":3,"t":"hold.tick"}\n'),
      /line 2 is unparseable and is not the final line/,
    );
  });

  test('blank lines are tolerated', () => {
    const events = parseJsonl('{"seq":1,"callId":"c","at":"x","t":"hold.tick"}\n\n');
    assert.equal(events.length, 1);
  });
});

describe('type-level guarantees', () => {
  test('the five synchronous event types are exactly §9.3’s list', () => {
    for (const t of ['channel.changed', 'phase.changed', 'gate.changed', 'outcome.written', 'safety.violation'] as const) {
      assert.equal(isSynchronousEvent(t), true, `${t} must be written synchronously`);
    }
    assert.equal(isSynchronousEvent('hold.tick'), false);
  });

  test('FINAL_STATUSES matches §9.1 and excludes the two non-final states', () => {
    assert.deepEqual([...FINAL_STATUSES], ['approved', 'denied', 'pending_info', 'escalated', 'escalated_resolved']);
    assert.equal(isFinalStatus('queued'), false);
    assert.equal(isFinalStatus('in_progress'), false);
    assert.equal(isFinalStatus('failed'), false, 'failed is final only after MAX_ATTEMPTS, which the Work Queue decides');
    assert.equal(isFinalStatus('escalated'), true);
  });

  test('the producer set is closed at six kinds (INV-21)', () => {
    assert.deepEqual([...PRODUCER_KINDS], ['acoustic', 'semantic', 'tool', 'timer', 'transport', 'session']);
  });
});
