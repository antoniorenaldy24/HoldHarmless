/**
 * The call loop — module 4.0, the module §21 never scheduled.
 *
 * Until this existed, `createAcousticClassifier` had no production caller: only
 * its own tests and a measurement script. §6.8 recorded that as a risk, and the
 * two traps it named are the first two tests here, because a wiring bug of
 * either kind is silent — the classifier keeps returning observations, they are
 * simply the wrong ones.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BYTES_PER_FRAME, FRAME_MS, MULAW_SILENCE, muLaw } from '@holdharmless/audio';
import { PROFILES, gateAdmits } from '@holdharmless/transport';
import type { AudioSource, CallTransport } from '@holdharmless/transport';
import type { AuthRequest, GateIntent, SemanticObservation } from '@holdharmless/events';
import { createEventLog, startCallLoop, type TranscriptSource } from '../src/index.js';

const request = (over: Partial<AuthRequest> = {}): AuthRequest => ({
  id: 'R1', patientRef: 'p', memberId: 'm', patientDob: '1970-01-01',
  cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-01',
  payerId: 'payer', payerEndpoint: 'ws://x', clinicName: 'Clinic', clinicCallbackPhone: '555',
  priority: 'routine', clinicalSummary: 's', status: 'in_progress', attempts: 0, ...over,
});

/** A transport that records what the loop did to it. Nothing here is mocked
 *  away that the loop depends on: the gate is stored and enforced exactly as
 *  the real one enforces it, through `gateAdmits`. */
function fakeTransport() {
  let intent: GateIntent = 'closed';
  const gates: GateIntent[] = [];
  const sent: { frame: Uint8Array; source: AudioSource }[] = [];
  let onAudio: ((f: Uint8Array) => void) | null = null;
  const t: CallTransport = {
    kind: 'loopback',
    dial: async () => {},
    sendAudio(frame, source) {
      if (!gateAdmits(intent, source)) return false;
      sent.push({ frame, source });
      return true;
    },
    clear: async () => [],
    mark: async () => {},
    applyGate(next) { intent = next; gates.push(next); },
    gate: () => intent,
    hangup: async () => {},
    onAudio(h) { onAudio = h; },
    onMark() {},
    onFault() {},
    onClosed() {},
  };
  return { t, gates, sent, feed: (f: Uint8Array) => onAudio?.(f), get intent() { return intent; } };
}

function transcriptSource() {
  let delta: ((text: string, atMs: number) => void) | null = null;
  let end: ((text: string, atMs: number) => void) | null = null;
  const src: TranscriptSource = {
    onFarEndDelta(h) { delta = h; },
    onFarEndTurnEnd(h) { end = h; },
  };
  return {
    src,
    /** One complete far-end turn: the delta, then the turn boundary. */
    say(text: string, atMs: number) {
      delta?.(text, atMs);
      end?.(text, atMs);
    },
    /** A partial, with no turn boundary — the far end is still talking. */
    partial: (text: string, atMs: number) => delta?.(text, atMs),
  };
}

const loud = (): Uint8Array => new Uint8Array(BYTES_PER_FRAME).fill(0x20);
const quiet = (): Uint8Array => new Uint8Array(BYTES_PER_FRAME).fill(MULAW_SILENCE);

function rig(over: { navMode?: 'dtmf' | 'speech' } = {}) {
  const tp = fakeTransport();
  const ts = transcriptSource();
  const log = createEventLog({ callId: 'CALL-L' });
  let ms = 0;
  const loop = startCallLoop({
    request: request(),
    log,
    transport: tp.t,
    transcripts: ts.src,
    navMode: over.navMode ?? 'dtmf',
    networkProfile: 'TELEPHONY',
    nowMs: () => ms,
  });
  return {
    loop, log, tp, ts,
    advance: (by: number) => { ms += by; },
    /** Feeds `n` frames of the given audio, advancing the clock as the wire would. */
    feed(frame: () => Uint8Array, n: number) {
      for (let i = 0; i < n; i++) {
        tp.feed(frame());
        ms += FRAME_MS;
      }
    },
    kinds: () => log.events().map((e) => e.t),
  };
}

// ---------------------------------------------------------------------------
// The two traps §6.8 named
// ---------------------------------------------------------------------------

describe('the acoustic layer is fed, and fed correctly (§6.8)', () => {
  test('it has a caller at all — which until module 4.0 it did not', () => {
    const r = rig();
    r.feed(loud, 30);
    assert.ok(r.loop.framesObserved >= 30);
    assert.ok(r.kinds().includes('acoustic.observed'), 'observations reach the log');
  });

  test('QUIET frames reach the CLASSIFIER, or the pause-ratio signal never sees a pause', () => {
    // §6.8's trap, and the one that would be invisible: `createSignalWindows`
    // keeps its window by timestamp, so skipping silent frames does not shorten
    // the window — it leaves fewer samples over which the same ratio is
    // computed, and the ratio that separates speech from hold music is the
    // ratio of PAUSE. A loop that fed only audible frames would report a pause
    // ratio near zero on ordinary speech, which is the hold-music value.
    //
    // Asserted against a SPY, not against the loop's own counter: the first
    // version of this test counted `framesObserved`, which a loop that skipped
    // silent frames would still increment. It measured the counter, not the
    // wiring, and the mutation that skips quiet frames survived it.
    const pushed: number[] = [];
    const spy = {
      push: (pcm: Int16Array) => { pushed.push(pcm.reduce((a, b) => a + Math.abs(b), 0)); return null; },
      reset: () => {},
    };
    const tp = fakeTransport();
    const ts = transcriptSource();
    let ms = 0;
    startCallLoop({
      request: request(),
      log: createEventLog({ callId: 'CALL-Q' }),
      transport: tp.t, transcripts: ts.src,
      navMode: 'dtmf', networkProfile: 'TELEPHONY', nowMs: () => ms,
      acoustic: spy as never,
    });
    for (let i = 0; i < 25; i++) { tp.feed(loud()); ms += FRAME_MS; }
    for (let i = 0; i < 25; i++) { tp.feed(quiet()); ms += FRAME_MS; }

    assert.equal(pushed.length, 50, 'every frame reached the classifier');
    assert.equal(pushed.slice(25).filter((energy) => energy === 0).length, 25, 'and the silent ones were silent');
  });
});

// ---------------------------------------------------------------------------
// The two ordering rules (§9.3)
// ---------------------------------------------------------------------------

describe('the ordering rules (§9.3, written down in module 4.0)', () => {
  test('an ACOUSTIC observation is logged before the suspicion it causes', () => {
    // The semantic side had this test and the acoustic side did not, so the
    // mutation that reverses the acoustic order survived the first pass.
    //
    // Driven by a classifier that emits EXACTLY ONE observation, because real
    // audio emits one every 250 ms and then the event before `hold.suspected`
    // is the PREVIOUS observation's — which is also an `acoustic.observed`, so
    // the assertion passes under the mutation too. It measured nothing. With a
    // single observation the two orderings are [observed, suspected] and
    // [suspected, observed], and no reading confuses them.
    let emitted = false;
    const oneShot = {
      push: () => {
        if (emitted) return null;
        emitted = true;
        return {
          at: new Date().toISOString(), seq: 0,
          scores: { SILENCE: 0.02, PERIODIC: 0.95, SPEECH_LIKE: 0.03 },
          winner: 'PERIODIC' as const, tier: 'provisional' as const, confidence: 0.95,
          signalsAvailable: ['rms', 'pauseRatio'], windowsMs: { rms: 250, pauseRatio: 2000 },
          accepted: true,
        };
      },
      reset: () => {},
    };
    const tp = fakeTransport();
    const ts = transcriptSource();
    const log = createEventLog({ callId: 'CALL-O' });
    const loop = startCallLoop({
      request: request(), log, transport: tp.t, transcripts: ts.src,
      navMode: 'dtmf', networkProfile: 'TELEPHONY', nowMs: () => 0,
      acoustic: oneShot as never,
    });
    loop.gate.setChannel('HUMAN', { kind: 'transport', cause: 'test' });
    tp.feed(loud());

    const kinds = log.events().map((e) => e.t);
    const observed = kinds.indexOf('acoustic.observed');
    const suspected = kinds.indexOf('hold.suspected');
    assert.ok(observed >= 0 && suspected >= 0, `both were logged: ${kinds.join(', ')}`);
    assert.ok(observed < suspected, `the observation at ${observed} must precede the suspicion at ${suspected}`);
  });

  test('an observation is logged BEFORE the gate change it causes', () => {
    // Otherwise a gate.changed can appear with no cause in the log, and
    // `replay()` reports the sequence number of an event whose reason is gone.
    const r = rig();
    // ADR-007 keeps the gate closed in DIALING whatever suspicion says, so a
    // cue there changes nothing and emits no gate.changed. The rule under test
    // needs a position where the gate can actually move.
    r.loop.gate.setChannel('HUMAN', { kind: 'transport', cause: 'test' });
    r.ts.say('one moment, let me check that', 100);
    const kinds = r.kinds();
    const obs = kinds.indexOf('semantic.observed');
    const suspected = kinds.indexOf('hold.suspected');
    // The LAST gate change, not the first: `setChannel` above emitted one of
    // its own when the channel opened, and that one legitimately precedes the
    // observation. What must follow it is the closure the cue caused.
    const gate = kinds.lastIndexOf('gate.changed');
    assert.ok(obs >= 0, 'the observation was logged');
    assert.ok(suspected > obs, `hold.suspected at ${suspected} must follow the observation at ${obs}`);
    assert.ok(gate > obs, `the gate closure at ${gate} must follow the observation at ${obs}`);
    assert.equal(r.log.events()[gate]!.t === 'gate.changed' && r.log.events()[gate]!.t, 'gate.changed');
  });

  test('the gate reaches the TRANSPORT, not just the log', () => {
    // ADR-007 layer 2. A gate that only exists in the log stops nothing.
    const r = rig();
    r.loop.gate.setChannel('HUMAN', { kind: 'transport', cause: 'test' });
    r.ts.say('one moment, let me check that', 100);
    assert.ok(r.tp.gates.length > 0, 'applyGate was called');
    assert.equal(r.tp.intent, r.loop.gate.gate, 'and the transport agrees with the derivation');
  });

  test('nothing here writes the gate: it is derived (ADR-007)', () => {
    // Every gate value the transport saw must equal what `gateFor` gives for the
    // channel and suspicion at that moment. A second writer would make INV-1
    // unauditable, and this is the cheap check that there is only one.
    const r = rig();
    r.loop.gate.setChannel('HUMAN', { kind: 'transport', cause: 'test' });
    r.ts.say('one moment', 100);
    r.ts.say('okay, so I can see the member right here', 3000);
    for (const e of r.log.events()) {
      if (e.t !== 'gate.changed') continue;
      assert.equal(typeof e.clearSent, 'boolean');
      assert.ok(e.producer, 'every gate change names what produced it');
    }
  });
});

// ---------------------------------------------------------------------------
// The cue path, end to end — what A-27 will measure
// ---------------------------------------------------------------------------

describe('a hold cue closes the gate, and a person reopens it (§5.5, §6.3)', () => {
  test('"let me check" shuts the gate at N=1', () => {
    const r = rig();
    assert.equal(r.loop.gate.holdSuspected, false);
    r.ts.say('let me check that for you', 100);
    assert.equal(r.loop.gate.holdSuspected, true, 'suspect fast (§6.5)');
    assert.equal(r.loop.gate.gate, 'closed');
  });

  test('and two HUMAN observations reopen it — N=2, not N=1', () => {
    const r = rig();
    // A human must be on the line for §5.5 to clear suspicion back to an open
    // gate; in DIALING the gate is closed whatever suspicion says (ADR-007).
    r.loop.gate.setChannel('HUMAN', { kind: 'transport', cause: 'test' });
    r.ts.say('let me check that for you', 100);
    assert.equal(r.loop.gate.gate, 'closed');

    r.ts.say('okay, I can see the member right here', 2000);
    const afterOne = r.loop.gate.holdSuspected;
    r.ts.say('and I have the request open now, so what did you need', 4000);
    const afterTwo = r.loop.gate.holdSuspected;

    assert.equal(afterOne, true, 'one HUMAN observation is not enough (§6.5)');
    assert.equal(afterTwo, false, 'two are');
    assert.equal(r.loop.gate.gate, 'open');
    assert.ok(r.kinds().includes('hold.cleared'));
  });
});

describe('the utterance latch — found only by assembling the parts', () => {
  test('a cue phrase does not poison every later turn', () => {
    // The semantic classifier accumulates deltas into ONE utterance and matches
    // §6.3's phrases against the whole of it. Without `endTurn()` at the turn
    // boundary, "let me check" stays in the buffer for the rest of the call, so
    // every later observation reads HOLD_CUE, `humanRun` never reaches N=2, and
    // the gate never reopens: the agent is mute from the first cue phrase to
    // the end of the call.
    //
    // No test in the classifier package could see this — they push one
    // utterance at a time. It appears only here.
    const r = rig();
    r.loop.gate.setChannel('HUMAN', { kind: 'transport', cause: 'test' });
    r.ts.say('let me check that for you', 100);
    assert.equal(r.loop.gate.gate, 'closed');

    r.ts.say('okay, I can see the member right here', 2000);
    r.ts.say('and I have the request open now, so what did you need', 4000);

    assert.equal(r.loop.gate.gate, 'open', 'the buffer was cleared between turns');
    const winners = r.log.events()
      .filter((e) => e.t === 'semantic.observed')
      .map((e) => (e.t === 'semantic.observed' ? e.obs.winner : ''));
    assert.deepEqual(winners, ['HOLD_CUE', 'HUMAN', 'HUMAN'], 'each turn was judged on its own words');
  });

  test('a partial does NOT end the turn: the far end is still talking', () => {
    // The cue arrives in the middle of a sentence the representative has not
    // finished. Ending the turn on a partial would clear the buffer mid-phrase
    // and lose the context the next delta needs.
    const r = rig();
    r.loop.gate.setChannel('HUMAN', { kind: 'transport', cause: 'test' });
    r.ts.partial('okay so', 100);
    r.ts.partial(' let me check', 300);
    assert.equal(r.loop.gate.gate, 'closed', 'the phrase was matched across the two deltas');
    const turns = r.kinds().filter((k) => k === 'turn.transcribed');
    assert.deepEqual(turns, [], 'and no turn was recorded, because none ended');
  });

  test('a completed far-end turn is written to the log, marked redactable (§11)', () => {
    const r = rig();
    r.ts.say('the member ID is M as in mike, four four eight two one', 100);
    const turn = r.log.events().find((e) => e.t === 'turn.transcribed');
    assert.ok(turn && turn.t === 'turn.transcribed');
    assert.equal(turn.speaker, 'far_end');
    assert.equal(turn.partial, false);
    assert.equal(turn.redactable, true, 'the panel decides whether to show it, not the loop');
  });
});

// ---------------------------------------------------------------------------
// §6.2's responsiveness signal
// ---------------------------------------------------------------------------

describe('the agent s own speech is reported only where a person could be replying (§6.2)', () => {
  /** The classifier records the moment; the loop decides whether to tell it. */
  function spy() {
    const calls: number[] = [];
    return {
      calls,
      classifier: {
        push: (): SemanticObservation | null => null,
        rampSensitivity: () => ({ step: 0, effectiveMinWeight: 0.5 }),
        setHoldMode: () => {},
        endTurn: () => {},
        reset: () => {},
        noteAgentSpoke: (atMs: number) => { calls.push(atMs); },
      },
    };
  }

  const build = (channel: 'IVR' | 'HUMAN' | 'HOLD') => {
    const s = spy();
    const tp = fakeTransport();
    const ts = transcriptSource();
    const loop = startCallLoop({
      request: request(),
      log: createEventLog({ callId: 'CALL-S' }),
      transport: tp.t,
      transcripts: ts.src,
      navMode: 'speech',
      networkProfile: 'TELEPHONY',
      nowMs: () => 1000,
      semantic: s.classifier as never,
    });
    loop.gate.setChannel(channel, { kind: 'transport', cause: 'test' });
    return { loop, calls: s.calls };
  };

  test('never while navigating an IVR — the menu answers the agent too', () => {
    // Measured in module 2.2: reporting the menu s reply as agent speech made a
    // four-word menu opening read HUMAN, which is the one error A-4 forbids.
    const b = build('IVR');
    b.loop.noteAgentSpoke();
    assert.deepEqual(b.calls, []);
  });

  test('yes on HUMAN, where the reply really is a person', () => {
    const b = build('HUMAN');
    b.loop.noteAgentSpoke();
    assert.deepEqual(b.calls, [1000]);
  });

  test('not during HOLD — the agent is silent there by design, so there is no signal', () => {
    const b = build('HOLD');
    b.loop.noteAgentSpoke();
    assert.deepEqual(b.calls, [], '§6.2s structural gap, not an oversight');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('the loop s edges', () => {
  test('it opens the log with call.started, carrying the attempt this is', () => {
    const tp = fakeTransport();
    const ts = transcriptSource();
    const log = createEventLog({ callId: 'CALL-E' });
    startCallLoop({
      request: request({ attempts: 2 }),
      log, transport: tp.t, transcripts: ts.src,
      navMode: 'dtmf', networkProfile: 'DEGRADED', nowMs: () => 0,
    });
    const first = log.events()[0]!;
    assert.equal(first.t, 'call.started');
    assert.equal(first.t === 'call.started' && first.attempts, 3, 'this is the third try, not the second');
    assert.equal(first.t === 'call.started' && first.networkProfile, 'DEGRADED', 'INV-16: the profile in force');
  });

  test('stop() ends the feed, and a late frame changes nothing', () => {
    const r = rig();
    r.feed(loud, 20);
    const observed = r.loop.framesObserved;
    const events = r.log.length;
    r.loop.stop();
    r.feed(loud, 20);
    r.ts.say('let me check', 9000);
    assert.equal(r.loop.framesObserved, observed);
    assert.equal(r.log.length, events);
  });
});

// ---------------------------------------------------------------------------
// Over the real transport
// ---------------------------------------------------------------------------

describe('over the loopback transport, with real audio', () => {
  test('hold music moves the channel to HOLD without anyone saying a word', () => {
    // §6.8s other half: the acoustic path with nothing semantic to help it.
    // This is the case the classifier exists for, and before module 4.0 no code
    // path connected it to a channel change.
    const tp = fakeTransport();
    const ts = transcriptSource();
    const log = createEventLog({ callId: 'CALL-A' });
    let ms = 0;
    const loop = startCallLoop({
      request: request(), log, transport: tp.t, transcripts: ts.src,
      navMode: 'dtmf', networkProfile: 'TELEPHONY', nowMs: () => ms,
    });
    loop.gate.setChannel('HUMAN', { kind: 'transport', cause: 'test' });

    // A periodic tone: what the acoustic layer reads as hold audio (§6.1).
    const music: Uint8Array[] = [];
    for (let f = 0; f < 60 * 50; f++) {
      const pcm = new Int16Array(BYTES_PER_FRAME);
      for (let i = 0; i < BYTES_PER_FRAME; i++) {
        const n = f * BYTES_PER_FRAME + i;
        pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * n) / 8000));
      }
      music.push(muLaw.encode(pcm));
    }
    for (const frame of music) {
      tp.feed(frame);
      ms += FRAME_MS;
    }

    assert.ok(loop.gate.holdSuspected || loop.gate.channel === 'HOLD', 'the acoustic layer was heard');
    assert.equal(tp.intent, 'closed', 'and the gate followed it to the transport');
  });
});

void PROFILES;
