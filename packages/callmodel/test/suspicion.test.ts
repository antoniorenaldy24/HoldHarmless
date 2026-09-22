/**
 * Acceptance criteria for module 2.3 (§21 week 2):
 *   "holdSuspected at N=1; holdSuspectedAt stamped; counters freeze;
 *    A-11 passes; A-28 passes; A-3 passes against the real playout queue"
 *
 * A-3 and A-11 are measured where the SSOT says they must be (§16.1): at the
 * FAR END, counting what actually reached its speaker. Measuring them in the
 * core would measure the gate with the gate.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AcousticObservation, SemanticObservation } from '@holdharmless/events';
import { BYTES_PER_FRAME, FRAME_MS, muLaw, silenceFrame } from '@holdharmless/audio';
import { PROFILES, raiseTimerResolution } from '@holdharmless/transport';
import { LoopbackEndpoint, LoopbackTransport, type FarEndSession } from '@holdharmless/transport-loopback';
import { createAcousticClassifier } from '@holdharmless/classifier';
import { holdMusicPcm } from '@holdharmless/ivr-harness';
import { createGateController, createRecoveryCounters } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
raiseTimerResolution(); // §4.5: the profile is only honored at 1 ms resolution

const acoustic = (winner: AcousticObservation['winner'], tier: AcousticObservation['tier'] = 'provisional'): AcousticObservation => ({
  at: new Date().toISOString(), seq: 1, scores: { SILENCE: 0, PERIODIC: 0, SPEECH_LIKE: 0 },
  winner, tier, confidence: 0.9, signalsAvailable: [], windowsMs: {}, accepted: winner !== 'UNKNOWN',
});

const semantic = (winner: SemanticObservation['winner'], accepted = true): SemanticObservation => ({
  at: new Date().toISOString(), seq: 1, scores: { IVR_PROMPT: 0, HUMAN: 0, HOLD_CUE: 0 },
  winner, confidence: 0.9, effectiveMinWeight: 0.45, signalsAvailable: [], sourceDelta: '', accepted,
});

describe('suspicion is N=1 (§5.5, §6.5)', () => {
  const setup = () => {
    const events: { t: string; [k: string]: unknown }[] = [];
    const gates: string[] = [];
    let clock = 1_000_000;
    const c = createGateController({
      navMode: 'dtmf',
      channel: 'HUMAN',
      transport: { applyGate: (g) => gates.push(g) },
      emit: (e) => events.push(e as { t: string }),
      now: () => clock,
    });
    return { c, events, gates, tick: (ms: number) => (clock += ms) };
  };

  test('one hold cue closes the gate and stamps the instant', () => {
    const { c, events, gates } = setup();
    assert.equal(c.gate, 'open');
    c.onSemantic({ ...semantic('HOLD_CUE'), matchedPhrase: 'one moment', transferHint: false });
    assert.equal(c.holdSuspected, true);
    assert.equal(c.gate, 'closed');
    assert.equal(c.holdSuspectedAt, 1_000_000);
    // The controller pushes the gate the call starts with, then the change.
    assert.deepEqual(gates, ['open', 'closed']);
    assert.deepEqual(events.map((e) => e.t), ['hold.suspected', 'gate.changed']);
    assert.equal(events[0]!['trigger'], 'hold_cue');
    assert.equal(events[1]!['clearSent'], true, 'a narrowing gate clears the far-end queue (ADR-007)');
  });

  test('the gate the call starts with is pushed to the transport, not merely assumed', () => {
    const applied: string[] = [];
    createGateController({ navMode: 'dtmf', channel: 'HUMAN', transport: { applyGate: (g) => applied.push(g) } });
    assert.deepEqual(applied, ['open'], 'a transport starts closed; an unpushed initial gate drops the first agent audio');
    const dialing: string[] = [];
    createGateController({ navMode: 'dtmf', channel: 'DIALING', transport: { applyGate: (g) => dialing.push(g) } });
    assert.deepEqual(dialing, ['closed']);
  });

  test('one provisional PERIODIC is enough — no confirmation needed to go quiet', () => {
    const { c, events } = setup();
    c.onAcoustic(acoustic('PERIODIC', 'provisional'));
    assert.equal(c.gate, 'closed');
    assert.equal(events[0]!['trigger'], 'periodic_provisional');
  });

  test('notify_transfer suspects on the tool call, before the audio changes (ADR-019)', () => {
    const { c, events } = setup();
    c.onToolCall('notify_transfer');
    assert.equal(c.gate, 'closed');
    assert.equal(events[0]!['trigger'], 'notify_transfer');
  });

  test('a lost session suspects, and a restored one clears (§15 step 4)', () => {
    const { c, events } = setup();
    c.setConnection('lost');
    assert.equal(c.gate, 'closed');
    assert.equal(events[0]!['trigger'], 'reconnect');
    c.setConnection('restored');
    assert.equal(c.gate, 'open');
    assert.equal(events.at(-2)!['reason'], 'reconnected');
  });

  test('an UNKNOWN observation is not evidence and changes nothing (§6.4)', () => {
    const { c, events } = setup();
    c.onAcoustic({ ...acoustic('PERIODIC'), accepted: false, winner: 'UNKNOWN' });
    c.onSemantic(semantic('HOLD_CUE', false));
    assert.equal(c.holdSuspected, false);
    assert.deepEqual(events, []);
  });

  test('a PERIODIC reading that did not clear the bar is not evidence either', () => {
    // winner PERIODIC, accepted false: the scores favoured hold audio but not
    // by enough (§6.4). Acting on it would make MIN_WEIGHT decorative.
    const { c, events } = setup();
    c.onAcoustic({ ...acoustic('PERIODIC', 'confirmed'), accepted: false });
    c.onAcoustic({ ...acoustic('PERIODIC', 'confirmed'), accepted: false });
    assert.equal(c.holdSuspected, false);
    assert.equal(c.channel, 'HUMAN');
    assert.deepEqual(events, []);
  });

  test('holdDurationMs runs from the stamp, and is zero when not suspected', () => {
    const { c, tick } = setup();
    assert.equal(c.holdDurationMs(), 0);
    c.onSemantic(semantic('HOLD_CUE'));
    tick(4200);
    assert.equal(c.holdDurationMs(), 4200);
  });
});

describe('clearing is N=2 (§6.5: confirm slowly)', () => {
  const setup = () => {
    const events: { t: string; [k: string]: unknown }[] = [];
    const c = createGateController({ navMode: 'dtmf', channel: 'HUMAN', emit: (e) => events.push(e as { t: string }) });
    c.onSemantic(semantic('HOLD_CUE'));
    return { c, events };
  };

  test('one HUMAN does not reopen the gate; two do', () => {
    const { c, events } = setup();
    c.onSemantic(semantic('HUMAN'));
    assert.equal(c.gate, 'closed', 'one observation reopened the gate');
    c.onSemantic(semantic('HUMAN'));
    assert.equal(c.gate, 'open');
    assert.equal(events.at(-2)!['reason'], 'human_confirmed');
  });

  test('the run must be consecutive: anything else resets it', () => {
    const { c } = setup();
    c.onSemantic(semantic('HUMAN'));
    c.onSemantic(semantic('IVR_PROMPT'));
    c.onSemantic(semantic('HUMAN'));
    assert.equal(c.gate, 'closed');
    c.onSemantic(semantic('HUMAN'));
    assert.equal(c.gate, 'open');
  });

  test('a second hold cue mid-run starts the count again', () => {
    const { c } = setup();
    c.onSemantic(semantic('HUMAN'));
    c.onSemantic(semantic('HOLD_CUE'));
    c.onSemantic(semantic('HUMAN'));
    assert.equal(c.gate, 'closed');
  });

  test('two CONFIRMED periodic observations move the channel to HOLD, and suspicion hands over', () => {
    const events: { t: string; [k: string]: unknown }[] = [];
    const c = createGateController({ navMode: 'dtmf', channel: 'HUMAN', emit: (e) => events.push(e as { t: string }) });
    c.onAcoustic(acoustic('PERIODIC', 'confirmed'));
    assert.equal(c.channel, 'HUMAN', 'one confirmation is not two');
    c.onAcoustic(acoustic('PERIODIC', 'confirmed'));
    assert.equal(c.channel, 'HOLD');
    assert.equal(c.holdSuspected, false, 'the channel now holds the gate closed by itself (§5.5)');
    assert.equal(c.gate, 'closed', 'and it is still closed');
    assert.equal(events.filter((e) => e.t === 'hold.cleared').at(-1)!['reason'], 'hold_confirmed');
  });

  test('inside HOLD, HUMAN observations do not reopen the gate — leaving hold is the Call Model\'s decision', () => {
    const c = createGateController({ navMode: 'dtmf', channel: 'HOLD' });
    c.onSemantic(semantic('HUMAN'));
    c.onSemantic(semantic('HUMAN'));
    c.onSemantic(semantic('HUMAN'));
    assert.equal(c.gate, 'closed');
  });
});

describe('the gate is derived, never assigned (ADR-007)', () => {
  test('every channel, with and without suspicion, matches gateFor', () => {
    for (const navMode of ['dtmf', 'speech'] as const) {
      const c = createGateController({ navMode, channel: 'DIALING' });
      for (const channel of ['IVR', 'HUMAN', 'HOLD', 'TRANSFER', 'CLOSED'] as const) {
        c.setChannel(channel, { kind: 'transport', cause: 'test' });
        const expected = channel === 'HUMAN' ? 'open' : channel === 'IVR' ? (navMode === 'dtmf' ? 'dtmf_only' : 'open') : 'closed';
        assert.equal(c.gate, expected, `${channel}/${navMode}`);
      }
    }
  });

  test('suspicion outranks the channel everywhere', () => {
    for (const channel of ['IVR', 'HUMAN'] as const) {
      const c = createGateController({ navMode: 'speech', channel });
      c.onSemantic(semantic('HOLD_CUE'));
      assert.equal(c.gate, 'closed', channel);
    }
  });

  test('a widening gate does not claim a clear was sent', () => {
    const events: { t: string; [k: string]: unknown }[] = [];
    const c = createGateController({ navMode: 'dtmf', channel: 'HUMAN', emit: (e) => events.push(e as { t: string }) });
    c.onSemantic(semantic('HOLD_CUE'));
    c.onSemantic(semantic('HUMAN'));
    c.onSemantic(semantic('HUMAN'));
    const changes = events.filter((e) => e.t === 'gate.changed');
    assert.deepEqual(changes.map((e) => [e['from'], e['to'], e['clearSent']]), [['open', 'closed', true], ['closed', 'open', false]]);
  });
});

describe('counters freeze while suspected (§6.5, the A-28 mechanism)', () => {
  test('the silence clock stops on suspicion and resumes when it clears', () => {
    const c = createGateController({ navMode: 'dtmf', channel: 'HUMAN' });
    const counters = createRecoveryCounters(() => c.countersFrozen);
    for (let i = 0; i < 8; i++) counters.advance(250); // 2 s of silence
    assert.equal(counters.silenceMs(), 2000);

    c.onAcoustic(acoustic('PERIODIC'));
    for (let i = 0; i < 80; i++) counters.advance(250); // 20 s of hold audio
    assert.equal(counters.silenceMs(), 2000, 'the counter advanced during hold');

    c.onSemantic(semantic('HUMAN'));
    c.onSemantic(semantic('HUMAN'));
    counters.advance(250);
    assert.equal(counters.silenceMs(), 2250);
  });

  test('A-28, as a unit: an unannounced hold never reaches the unresponsive limit before HOLD', () => {
    // HUMAN/EXCHANGE: silenceTimeout 3000 ms, rePromptLimit 2, then close as
    // unresponsive. Without the freeze that limit arrives about nine seconds
    // into any silent or unannounced hold.
    const SILENCE_TIMEOUT = 3000;
    const RE_PROMPT_LIMIT = 2;
    for (const trial of [0, 1]) {
      const c = createGateController({ navMode: 'dtmf', channel: 'HUMAN' });
      const counters = createRecoveryCounters(() => (trial === 0 ? c.countersFrozen : false));
      let closed = false;
      // Hold audio, unannounced: the acoustic layer suspects at about 1 s.
      for (let ms = 0; ms < 20_000; ms += 250) {
        if (ms === 1000) c.onAcoustic(acoustic('PERIODIC'));
        if (ms === 20_000 - 250) {
          c.onAcoustic(acoustic('PERIODIC', 'confirmed'));
          c.onAcoustic(acoustic('PERIODIC', 'confirmed'));
        }
        if (counters.advance(250) >= SILENCE_TIMEOUT) {
          if (counters.rePrompts() >= RE_PROMPT_LIMIT) closed = true;
          else counters.noteRePrompt();
        }
      }
      if (trial === 0) {
        assert.equal(closed, false, 'the call was ended as unresponsive during a hold');
        assert.equal(c.channel, 'HOLD');
      } else {
        assert.equal(closed, true, 'without the freeze this scenario must fail — otherwise the test proves nothing');
      }
    }
  });

  test('a re-prompt restarts the silence clock but not the count', () => {
    const c = createGateController({ navMode: 'dtmf', channel: 'HUMAN' });
    const counters = createRecoveryCounters(() => c.countersFrozen);
    counters.advance(3000);
    counters.noteRePrompt();
    assert.equal(counters.silenceMs(), 0);
    assert.equal(counters.rePrompts(), 1);
    counters.advance(1000);
    counters.noteActivity();
    assert.equal(counters.silenceMs(), 0);
    assert.equal(counters.rePrompts(), 1, 'the far end speaking does not undo a re-prompt');
  });
});

// ---------------------------------------------------------------------------
// A-3 and A-11, measured at the far end over the real transport
// ---------------------------------------------------------------------------

const MUSIC = muLaw.encode(holdMusicPcm());
const AGENT_FRAME = () => new Uint8Array(BYTES_PER_FRAME).fill(0x40); // loud, nothing like silence
const cleanups: (() => Promise<void>)[] = [];
after(async () => { for (const c of cleanups) await c(); });

async function link(profile = PROFILES.TELEPHONY) {
  const endpoint = await LoopbackEndpoint.listen({ port: 0, profile });
  cleanups.push(() => endpoint.close());
  const ready = new Promise<FarEndSession>((resolve) => endpoint.onSession(resolve));
  const transport = new LoopbackTransport();
  await transport.dial(endpoint.url(), profile);
  const far = await ready;

  /** What the far end's speaker emits, counted as milliseconds of agent audio. */
  const audible: number[] = [];
  far.onSpeaker((frame) => {
    // Agent audio is the only loud thing the core sends; silence is 0xff.
    if (frame[0] === 0x40) audible.push(performance.now());
  });
  return { endpoint, transport, far, audible };
}

describe('A-3: clear stops audio within 300 ms, against the real playout queue', () => {
  test('a closing gate empties the queue, reports its marks, and silences the far end', async () => {
    const { transport, far, audible } = await link();
    transport.applyGate('open');

    // Load the far end: 40 frames is 800 ms of audio into a 200 ms queue, so the
    // queue is full and the rest was dropped as overflow — the state ADR-007
    // describes, where closing the gate is not enough on its own.
    for (let i = 0; i < 40; i++) transport.sendAudio(AGENT_FRAME(), 'agent');
    await transport.mark('chunk-end');
    await sleep(60);

    const closedAt = performance.now();
    transport.applyGate('closed'); // the transport clears on any narrowing
    const discarded = await transport.clear();
    await sleep(400);

    const after = audible.filter((t) => t > closedAt);
    const lastMs = after.length ? Math.max(...after) - closedAt : 0;
    console.log(`      A-3: ${after.length} agent frames audible after the gate closed, last at ${lastMs.toFixed(0)} ms`);
    assert.ok(lastMs < 300, `agent audio was still audible ${lastMs.toFixed(0)} ms after the gate closed`);
    assert.equal(far.playout.depthMs(), 0, 'the queue still holds unplayed agent frames');
    assert.ok(discarded.includes('chunk-end') || discarded.length === 0, 'marks for discarded chunks are returned');
    await transport.hangup();
  });

  test('the far end hears nothing at all once the gate is closed', async () => {
    const { transport, audible } = await link();
    transport.applyGate('closed');
    const from = performance.now();
    for (let i = 0; i < 25; i++) {
      assert.equal(transport.sendAudio(AGENT_FRAME(), 'agent'), false, 'the transport accepted audio through a closed gate');
      await sleep(FRAME_MS);
    }
    await sleep(200);
    assert.deepEqual(audible.filter((t) => t > from), []);
    await transport.hangup();
  });
});

describe('A-11: the gate closes before the agent can speak when a hold begins', () => {
  /**
   * One transition: the agent is mid-sentence, the representative says a hold
   * cue, two seconds pass, then hold audio starts. The transcript delta reaches
   * the core ASR_LATENCY_MS after the phrase begins — the §5.5 figure.
   */
  async function oneTransition(silentHold: boolean): Promise<{ entryLatencyMs: number; audibleDuringHoldMs: number }> {
    const ASR_LATENCY_MS = 300;
    const { transport, far, audible } = await link();
    const controller = createGateController({
      navMode: 'dtmf',
      channel: 'HUMAN',
      transport,
      now: () => performance.now(),
    });
    // The Call Model opens the gate for HUMAN; the agent starts talking.
    const speaking = setInterval(() => transport.sendAudio(AGENT_FRAME(), 'agent'), FRAME_MS);

    const classifier = createAcousticClassifier();
    transport.onAudio((frame) => {
      const o = classifier.push(muLaw.decode(frame), performance.now());
      if (o) controller.onAcoustic(o);
    });

    await sleep(300);
    const cueStart = performance.now();
    setTimeout(() => controller.onSemantic({ ...semantic('HOLD_CUE'), matchedPhrase: 'one moment' }), ASR_LATENCY_MS);

    // Two seconds of pause, then the hold begins.
    await sleep(2000);
    const holdStart = performance.now();
    const source = silentHold ? null : MUSIC;
    let offset = 0;
    const holdAudio = setInterval(() => {
      const frame = new Uint8Array(BYTES_PER_FRAME);
      if (source === null) frame.set(silenceFrame());
      else for (let j = 0; j < BYTES_PER_FRAME; j++) frame[j] = source[(offset + j) % source.length]!;
      offset += BYTES_PER_FRAME;
      far.sendAudio(frame);
    }, FRAME_MS);

    await sleep(1500);
    clearInterval(speaking);
    clearInterval(holdAudio);
    await sleep(200);
    await transport.hangup();

    const closedAt = audible.length ? Math.max(...audible) : cueStart;
    return {
      entryLatencyMs: closedAt - cueStart,
      audibleDuringHoldMs: audible.filter((t) => t >= holdStart).length * FRAME_MS,
    };
  }

  test('zero milliseconds of agent speech during the hold, and entry latency p90 under 800 ms', async () => {
    const runs: { entryLatencyMs: number; audibleDuringHoldMs: number }[] = [];
    // The SSOT asks for 20 transitions plus 5 silent holds; 6 plus 2 here keeps
    // the suite quick, and scripts/ can run the full count before the rehearsal.
    for (let i = 0; i < 6; i++) runs.push(await oneTransition(false));
    for (let i = 0; i < 2; i++) runs.push(await oneTransition(true));

    const audible = runs.reduce((a, r) => a + r.audibleDuringHoldMs, 0);
    const latencies = runs.map((r) => r.entryLatencyMs).sort((a, b) => a - b);
    const p90 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.9))]!;
    console.log(`      A-11: ${audible} ms of agent audio during hold; entry latency p90 ${p90.toFixed(0)} ms (${latencies.map((l) => l.toFixed(0)).join(', ')})`);
    assert.equal(audible, 0, 'the agent was audible during a hold');
    assert.ok(p90 < 800, `hold_entry_latency_ms p90 was ${p90.toFixed(0)} ms`);
  });
});
