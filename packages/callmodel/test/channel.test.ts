/**
 * §5.3's producers outside the gate controller — module 4.0, reply half.
 *
 * Until these existed, the only channel move in the code was `* → HOLD` on
 * confirmed PERIODIC. A call started for real stayed in DIALING, gate shut, for
 * its whole length; every test above the unit level set the channel by hand.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CallEventBody, SemanticObservation } from '@holdharmless/events';
import {
  HOLD_CONFIRM_MS,
  HOLD_TIMEOUT_MS,
  TRANSFER_TIMEOUT_MS,
  createChannelDriver,
  createGateController,
  type ChannelTimers,
} from '../src/index.js';

const semantic = (winner: SemanticObservation['winner'], accepted = true, seq = 1): SemanticObservation => ({
  at: '', seq, scores: { IVR_PROMPT: 0, HUMAN: 0, HOLD_CUE: 0 },
  winner, confidence: 0.9, effectiveMinWeight: 0.45, signalsAvailable: [], sourceDelta: '', accepted,
});

function manualTimers() {
  let now = 0;
  const pending: { at: number; fn: () => void; live: boolean }[] = [];
  const timers: ChannelTimers = {
    after(ms, fn) {
      const t = { at: now + ms, fn, live: true };
      pending.push(t);
      return () => { t.live = false; };
    },
  };
  return {
    timers,
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = pending.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        due.live = false;
        due.fn();
      }
      now = until;
    },
    live: () => pending.filter((t) => t.live).length,
  };
}

/** The controller and the driver, wired the way the call loop wires them. */
function rig(channel: 'DIALING' | 'IVR' | 'HUMAN' | 'HOLD' | 'TRANSFER' = 'DIALING') {
  const clock = manualTimers();
  const events: CallEventBody[] = [];
  let onEvent: (e: CallEventBody) => void = () => {};
  const gate = createGateController({ navMode: 'dtmf', channel, emit: (e) => { events.push(e); onEvent(e); } });
  const driver = createChannelDriver({ gate, timers: clock.timers });
  onEvent = (e) => driver.onControllerEvent(e);
  const say = (o: SemanticObservation) => { driver.onFarEndSpeech(); driver.onSemantic(o); gate.onSemantic(o); };
  const producers = () => events.filter((e) => e.t === 'channel.changed').map((e) => e.t === 'channel.changed' ? `${e.from}>${e.to}:${e.producer.kind}${e.producer.kind === 'timer' ? `/${e.producer.name}` : ''}` : '');
  return { gate, driver, clock, events, say, producers };
}

describe('the link (§5.3 rows 1-2)', () => {
  test('DIALING → IVR when the link is established, and the gate opens for DTMF', () => {
    const r = rig();
    r.driver.linkEstablished();
    assert.equal(r.gate.channel, 'IVR');
    assert.equal(r.gate.gate, 'dtmf_only');
    assert.deepEqual(r.producers(), ['DIALING>IVR:transport']);
  });

  test('DIALING → CLOSED when it is refused, with the cause', () => {
    const r = rig();
    r.driver.linkFailed('link_refused: ECONNREFUSED');
    assert.equal(r.gate.channel, 'CLOSED');
    const e = r.events.find((x) => x.t === 'channel.changed');
    assert.ok(e && e.t === 'channel.changed' && e.producer.kind === 'transport' && e.producer.cause.includes('ECONNREFUSED'));
  });

  test('a late link event does not drag a call back out of where it has got to', () => {
    const r = rig('HUMAN');
    r.driver.linkEstablished();
    r.driver.linkFailed('late');
    assert.equal(r.gate.channel, 'HUMAN');
  });

  test('any → CLOSED on transport.closed, and nothing moves after CLOSED', () => {
    const r = rig('HOLD');
    r.driver.transportClosed('far_end_hangup');
    assert.equal(r.gate.channel, 'CLOSED');
    r.say(semantic('HUMAN'));
    r.say(semantic('HUMAN'));
    assert.equal(r.gate.channel, 'CLOSED');
  });
});

describe('a person answering: semantic HUMAN, N=2 (§5.3, §6.5)', () => {
  for (const from of ['IVR', 'HOLD', 'TRANSFER'] as const) {
    test(`${from} → HUMAN on the second agreeing observation, not the first`, () => {
      const r = rig(from);
      r.say(semantic('HUMAN'));
      assert.equal(r.gate.channel, from, 'one is not two');
      r.say(semantic('HUMAN'));
      assert.equal(r.gate.channel, 'HUMAN');
      assert.equal(r.gate.gate, 'open');
    });
  }

  test('an unaccepted observation is not evidence: it does not count toward N', () => {
    const r = rig('HOLD');
    r.say(semantic('HUMAN'));
    r.say(semantic('HUMAN', false));
    assert.equal(r.gate.channel, 'HOLD');
  });

  test('…and it does not break a run either', () => {
    const r = rig('HOLD');
    r.say(semantic('HUMAN'));
    r.say(semantic('UNKNOWN', false));
    r.say(semantic('HUMAN'));
    assert.equal(r.gate.channel, 'HUMAN');
  });

  for (const between of ['IVR_PROMPT', 'HOLD_CUE'] as const) {
    test(`a disagreeing observation restarts the count — ${between}`, () => {
      const r = rig('HOLD');
      r.say(semantic('HUMAN'));
      r.say(semantic(between));
      r.say(semantic('HUMAN'));
      assert.equal(r.gate.channel, 'HOLD');
    });
  }

  test('evidence from one channel does not carry into the next', () => {
    // One HUMAN observation in HUMAN, then the acoustic layer confirms a hold.
    // Without the reset, the very next HUMAN observation — a voice-over on the
    // hold line — would count as the second and pull the call straight back out.
    const r = rig('HUMAN');
    r.say(semantic('HUMAN'));
    r.gate.setChannel('HOLD', { kind: 'acoustic', seq: 9 });
    r.say(semantic('HUMAN'));
    assert.equal(r.gate.channel, 'HOLD');
  });

  test('a person answering while suspicion stands widens the gate ONCE', () => {
    // "Please hold while we connect you" in the menu, then a representative.
    const r = rig('IVR');
    r.say(semantic('HOLD_CUE'));
    assert.equal(r.gate.gate, 'closed');
    r.say(semantic('HUMAN'));
    r.say(semantic('HUMAN'));
    assert.equal(r.gate.channel, 'HUMAN');
    assert.equal(r.gate.holdSuspected, false);
    const widenings = r.events.filter((e) => e.t === 'gate.changed' && e.from === 'closed');
    assert.deepEqual(widenings.map((e) => e.t === 'gate.changed' && e.to), ['open'], 'closed → open, not closed → dtmf_only → open');
  });
});

describe('back into a menu: semantic IVR_PROMPT, N=2, from HOLD only (§5.3)', () => {
  test('HOLD → IVR', () => {
    const r = rig('HOLD');
    r.say(semantic('IVR_PROMPT'));
    assert.equal(r.gate.channel, 'HOLD');
    r.say(semantic('IVR_PROMPT'));
    assert.equal(r.gate.channel, 'IVR');
  });

  test('a menu heard while a person is on the line is not a reason to leave them', () => {
    const r = rig('HUMAN');
    for (let i = 0; i < 4; i++) r.say(semantic('IVR_PROMPT'));
    assert.equal(r.gate.channel, 'HUMAN');
  });
});

describe('HOLD_CUE + HOLD_CONFIRM_MS: three seconds of NOTHING said after a cue', () => {
  test('a cue, then silence: HOLD at three seconds, produced by the timer', () => {
    const r = rig('HUMAN');
    r.say(semantic('HOLD_CUE'));
    r.clock.advance(HOLD_CONFIRM_MS - 1);
    assert.equal(r.gate.channel, 'HUMAN');
    r.clock.advance(1);
    assert.equal(r.gate.channel, 'HOLD');
    assert.deepEqual(r.producers(), ['HUMAN>HOLD:timer/HOLD_CONFIRM_MS']);
  });

  test('a cue while the representative keeps talking never reaches HOLD', () => {
    // "Let me check that… okay, so the member is…" — speech every half second.
    const r = rig('HUMAN');
    r.say(semantic('HOLD_CUE'));
    for (let t = 0; t < 10_000; t += 500) {
      r.clock.advance(500);
      r.driver.onFarEndSpeech();
    }
    assert.equal(r.gate.channel, 'HUMAN');
  });

  test('the three seconds count from the LAST word, not from the cue', () => {
    const r = rig('HUMAN');
    r.say(semantic('HOLD_CUE'));
    r.clock.advance(2_000);
    r.driver.onFarEndSpeech(); // "…please"
    r.clock.advance(2_000);
    assert.equal(r.gate.channel, 'HUMAN', 'four seconds after the cue, two after the last word');
    r.clock.advance(1_000);
    assert.equal(r.gate.channel, 'HOLD');
  });

  test('suspicion cleared before the timer fires: no hold', () => {
    const r = rig('HUMAN');
    r.say(semantic('HOLD_CUE'));
    r.say(semantic('HUMAN'));
    r.say(semantic('HUMAN'));
    assert.equal(r.gate.holdSuspected, false);
    r.clock.advance(HOLD_CONFIRM_MS * 2);
    assert.equal(r.gate.channel, 'HUMAN');
  });

  test('also from IVR — and never from TRANSFER, where §5.3 lists only the acoustic producer', () => {
    const ivr = rig('IVR');
    ivr.say(semantic('HOLD_CUE'));
    ivr.clock.advance(HOLD_CONFIRM_MS);
    assert.equal(ivr.gate.channel, 'HOLD');

    const tr = rig('TRANSFER');
    tr.say(semantic('HOLD_CUE'));
    tr.clock.advance(HOLD_CONFIRM_MS * 2);
    assert.equal(tr.gate.channel, 'TRANSFER');
  });

  test('with no cue at all, a pause in speech is just a pause', () => {
    const r = rig('HUMAN');
    r.driver.onFarEndSpeech();
    r.clock.advance(HOLD_CONFIRM_MS * 3);
    assert.equal(r.gate.channel, 'HUMAN');
  });

  test('a cleared cue leaves no timer behind for a LATER suspicion to inherit', () => {
    // Cue, cleared by a person; then hold music is suspected acoustically.
    // A timer left over from the cue would move the channel at three seconds
    // and name HOLD_CONFIRM_MS as the producer — for a hold no cue announced.
    const r = rig('HUMAN');
    r.say(semantic('HOLD_CUE'));
    r.say(semantic('HUMAN'));
    r.say(semantic('HUMAN'));
    r.gate.onAcoustic({
      at: '', seq: 2, scores: { SILENCE: 0, PERIODIC: 1, SPEECH_LIKE: 0 }, winner: 'PERIODIC', tier: 'provisional',
      confidence: 0.9, signalsAvailable: [], windowsMs: {}, accepted: true,
    });
    assert.equal(r.gate.holdSuspected, true);
    r.clock.advance(HOLD_CONFIRM_MS * 2);
    assert.equal(r.gate.channel, 'HUMAN');
  });

  test('suspicion from the acoustic layer does not start it: that path confirms itself', () => {
    const r = rig('HUMAN');
    r.gate.onAcoustic({
      at: '', seq: 1, scores: { SILENCE: 0, PERIODIC: 1, SPEECH_LIKE: 0 }, winner: 'PERIODIC', tier: 'provisional',
      confidence: 0.9, signalsAvailable: [], windowsMs: {}, accepted: true,
    });
    assert.equal(r.gate.holdSuspected, true);
    r.clock.advance(HOLD_CONFIRM_MS * 2);
    assert.equal(r.gate.channel, 'HUMAN');
  });
});

describe('the channel timeouts (§5.3, §5.7)', () => {
  test('HOLD → CLOSED at HOLD_TIMEOUT_MS, and not a moment before', () => {
    const r = rig('HUMAN');
    r.gate.setChannel('HOLD', { kind: 'acoustic', seq: 1 });
    r.clock.advance(HOLD_TIMEOUT_MS - 1);
    assert.equal(r.gate.channel, 'HOLD');
    r.clock.advance(1);
    assert.equal(r.gate.channel, 'CLOSED');
    assert.deepEqual(r.producers().at(-1), 'HOLD>CLOSED:timer/HOLD_TIMEOUT_MS');
  });

  test('TRANSFER → CLOSED at TRANSFER_TIMEOUT_MS', () => {
    const r = rig('HUMAN');
    r.driver.onNotifyTransfer(4);
    assert.equal(r.gate.channel, 'TRANSFER');
    r.clock.advance(TRANSFER_TIMEOUT_MS);
    assert.equal(r.gate.channel, 'CLOSED');
  });

  test('leaving the channel cancels its timeout', () => {
    const r = rig('HUMAN');
    r.gate.setChannel('HOLD', { kind: 'acoustic', seq: 1 });
    r.clock.advance(60_000);
    r.say(semantic('HUMAN'));
    r.say(semantic('HUMAN'));
    r.clock.advance(HOLD_TIMEOUT_MS);
    assert.equal(r.gate.channel, 'HUMAN');
  });

  test('notify_transfer moves the channel only from HUMAN', () => {
    const r = rig('IVR');
    r.driver.onNotifyTransfer(1);
    assert.equal(r.gate.channel, 'IVR');
  });

  test('stop() cancels everything', () => {
    const r = rig('HUMAN');
    r.say(semantic('HOLD_CUE'));
    r.driver.stop();
    assert.equal(r.clock.live(), 0);
    r.clock.advance(HOLD_TIMEOUT_MS);
    assert.equal(r.gate.channel, 'HUMAN');
  });

  test('…and nothing it is told afterwards moves the channel or starts a timer', () => {
    const r = rig('HOLD');
    r.driver.stop();
    r.say(semantic('HUMAN'));
    r.say(semantic('HUMAN'));
    assert.equal(r.gate.channel, 'HOLD');
    r.gate.setChannel('HUMAN', { kind: 'transport', cause: 'test' });
    r.say(semantic('HOLD_CUE'));
    assert.equal(r.clock.live(), 0);
  });
});
