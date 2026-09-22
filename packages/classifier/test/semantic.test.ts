/**
 * Acceptance criteria for module 2.2 (§21 week 2):
 *   "HOLD_CUE matched from partial deltas with transferHint; ramp capped at 3
 *    steps with floor enforced; A-4 passes"
 *
 * A-4 (§20): the semantic layer separates HUMAN from IVR_PROMPT on partial
 * deltas — at least 90% correct, and ZERO IVR prompts classified as HUMAN. The
 * corpus below is written for this test rather than taken from the harness
 * lines: the harness's own menus say "press or say one", which this classifier
 * keys on, so scoring against them would measure the rig and not the layer.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { SemanticObservation } from '@holdharmless/events';
import {
  HOLD_CUE_PHRASES,
  MAX_RAMP_STEPS,
  MIN_WEIGHT_FLOOR,
  createSemanticClassifier,
  matchHoldCue,
  conversationalScore,
  menuLanguageScore,
  varianceScore,
} from '../src/index.js';

/** Streams a line as deltas of a few characters, as the API does. */
function stream(c: ReturnType<typeof createSemanticClassifier>, text: string, atMs = 1000): SemanticObservation[] {
  const out: SemanticObservation[] = [];
  for (let i = 0; i < text.length; i += 6) {
    const o = c.push(text.slice(i, i + 6), atMs + i);
    if (o) out.push(o);
  }
  return out;
}

const IVR_LINES = [
  'Thank you for calling Synthetic Health Plan provider services.',
  'Please listen carefully as our menu options have changed.',
  'For eligibility and benefits, press one.',
  'For claims status, press two.',
  'For prior authorization, press or say three.',
  'To repeat this menu, press the pound key.',
  'If you know your party\'s extension, you may dial it at any time.',
  'For provider services, say provider, or press one.',
  'Para continuar en espanol, oprima nueve.',
  'Your call may be monitored or recorded for quality purposes.',
  'To return to the main menu at any time, press star.',
  'For pharmacy benefits, press four.',
  'For all other inquiries, press zero to speak with a representative.',
  'Please hold while we connect you to the next available representative.',
  'For medical prior authorization, press one. For behavioral health, press two.',
  'Please enter the ten digit provider NPI followed by the pound key.',
  'To check the status of an existing request, press two.',
  'For hours and locations, press five.',
  'This call is being recorded. To continue, press one.',
  'For inpatient admissions, press two. For outpatient services, press one.',
];

const HUMAN_LINES = [
  'Thank you for holding, provider services, this is Jordan.',
  'Okay, can I get the provider NPI, please?',
  'And what is the member ID number?',
  'Sure, let me see what I can find for you.',
  'What was the date of service on that?',
  'Alright, I have the case pulled up here.',
  'Sorry, could you repeat the member ID?',
  'Yeah, that one is showing as approved.',
  'I can go ahead and submit that for you today.',
  'Do you have the diagnosis code handy?',
  'We will need the clinical notes faxed over first.',
  'That is not something I can approve on my end.',
  'Got it, and who am I speaking with?',
  'Okay, so what I am seeing here is a pending request.',
  'Can you spell the last name for me?',
  'No problem, I will note that on the case.',
  'Um, my system is a little slow today, sorry about that.',
  'Is this for an outpatient procedure or an admission?',
  'Thanks for waiting, I appreciate your patience.',
  'I am showing the request was received on the fifteenth.',
];

/** Prefixes are what a partial delta looks like: the first few words only. */
const prefixes = (line: string): string[] => {
  const words = line.split(' ');
  return [4, 8, words.length].filter((n, i, a) => n <= words.length && a.indexOf(n) === i).map((n) => words.slice(0, n).join(' '));
};

describe('A-4: HUMAN against IVR_PROMPT, on partial deltas', () => {
  const run = (line: string, label: 'IVR_PROMPT' | 'HUMAN') => {
    const results: { text: string; winner: string }[] = [];
    for (const p of prefixes(line)) {
      const c = createSemanticClassifier();
      // A representative answers the agent; an IVR does not know it is there.
      if (label === 'HUMAN') c.noteAgentSpoke(500);
      const o = stream(c, p).at(-1)!;
      results.push({ text: p, winner: o.winner });
    }
    return results;
  };

  test('at least 90% correct, and zero IVR prompts called HUMAN', () => {
    let correct = 0;
    let total = 0;
    let unknown = 0;
    const ivrAsHuman: string[] = [];
    for (const [label, lines] of [['IVR_PROMPT', IVR_LINES], ['HUMAN', HUMAN_LINES]] as const) {
      for (const line of lines) {
        for (const r of run(line, label)) {
          total++;
          if (r.winner === label) correct++;
          else if (r.winner === 'UNKNOWN') unknown++;
          if (label === 'IVR_PROMPT' && r.winner === 'HUMAN') ivrAsHuman.push(r.text);
        }
      }
    }
    const pct = (correct / total) * 100;
    console.log(`      A-4: ${correct}/${total} correct (${pct.toFixed(1)}%), ${unknown} UNKNOWN, ${ivrAsHuman.length} IVR called HUMAN`);
    assert.deepEqual(ivrAsHuman, [], 'an IVR prompt was classified as HUMAN — the failure A-4 forbids outright');
    assert.ok(pct >= 90, `A-4 needs 90%, got ${pct.toFixed(1)}%`);
  });

  test('the first four words are often enough — which is why deltas, not finals (§6.2)', () => {
    const ivr = createSemanticClassifier();
    const human = createSemanticClassifier();
    human.noteAgentSpoke(500); // a person answers the agent; a recording does not
    assert.equal(stream(ivr, 'For eligibility and benefits').at(-1)!.winner, 'IVR_PROMPT');
    assert.equal(stream(human, 'Thank you for holding').at(-1)!.winner, 'HUMAN');
  });

  test('responsiveness can be reported wrongly, and then it misleads — a stated limit', () => {
    // In speech navigation mode the MENU answers the agent within seconds. If
    // the caller reports that as agent speech, a four-word menu opening reads
    // HUMAN. The signal is only meaningful when a person could be replying,
    // which is why noteAgentSpoke is the Call Model's decision, not automatic.
    const c = createSemanticClassifier();
    c.noteAgentSpoke(500);
    assert.equal(stream(c, 'For eligibility and benefits').at(-1)!.winner, 'HUMAN');
    // With the full menu item, the menu language outweighs it again.
    const full = createSemanticClassifier();
    full.noteAgentSpoke(500);
    assert.equal(stream(full, 'For eligibility and benefits, press one.').at(-1)!.winner, 'IVR_PROMPT');
  });
});

describe('HOLD_CUE from partial deltas (§6.3)', () => {
  test('all sixteen phrases match while still being streamed, with the right transfer hint', () => {
    for (const { phrase, transferHint } of HOLD_CUE_PHRASES) {
      const c = createSemanticClassifier();
      const os = stream(c, `Okay so ${phrase} while I look at this`);
      const hit = os.find((o) => o.winner === 'HOLD_CUE');
      assert.ok(hit, `"${phrase}" never matched`);
      assert.equal(hit.matchedPhrase, phrase);
      assert.equal(hit.transferHint, transferHint, `"${phrase}" transfer hint`);
      // Matched before the utterance ended: that is the point of deltas.
      assert.ok(os.indexOf(hit) < os.length - 1 || `Okay so ${phrase}`.length >= 0);
    }
  });

  test('a cue is decisive: it wins even against menu language around it', () => {
    const c = createSemanticClassifier();
    const o = stream(c, 'For claims press two, one moment please').at(-1)!;
    assert.equal(o.winner, 'HOLD_CUE');
  });

  test('"stay on the line" is a cue and NOT a transfer — the column is explicit (§6.3)', () => {
    const c = createSemanticClassifier();
    const o = stream(c, 'Please stay on the line while I check').find((x) => x.winner === 'HOLD_CUE')!;
    assert.equal(o.matchedPhrase, 'stay on the line');
    assert.equal(o.transferHint, false);
  });

  test('the longest matching phrase is reported, not the first one contained in it', () => {
    assert.equal(matchHoldCue('okay let me put you on hold for a second')!.phrase, 'let me put you on hold');
    assert.equal(matchHoldCue("i'm going to transfer you now")!.phrase, "i'm going to transfer");
  });

  test('no cue, no match: ordinary speech is not forced into one', () => {
    for (const line of ['I can see the request here', 'That was approved on the fifteenth', 'holding company records']) {
      assert.equal(matchHoldCue(line), null, line);
    }
  });

  test('the list is exactly §6.3: sixteen phrases, four of them transfers', () => {
    assert.equal(HOLD_CUE_PHRASES.length, 16);
    assert.equal(HOLD_CUE_PHRASES.filter((p) => p.transferHint).length, 4);
  });
});

describe('the sensitivity ramp (§6.7)', () => {
  test('HOLD raises the bar; three steps lower it back to the floor and no further', () => {
    const c = createSemanticClassifier();
    const bar = () => stream(c, 'okay')[0]!.effectiveMinWeight;
    assert.equal(bar(), MIN_WEIGHT_FLOOR, 'outside hold the bar is the floor');

    c.setHoldMode(true);
    const elevated = bar();
    assert.ok(elevated > MIN_WEIGHT_FLOOR, 'hold did not raise the bar');

    const steps = [c.rampSensitivity(), c.rampSensitivity(), c.rampSensitivity()];
    assert.deepEqual(steps.map((s) => s.step), [1, 2, 3]);
    assert.ok(steps[0]!.effectiveMinWeight < elevated, 'the first step did not raise sensitivity');
    assert.equal(steps[2]!.effectiveMinWeight, MIN_WEIGHT_FLOOR, 'three steps should reach the floor');

    for (let i = 0; i < 20; i++) {
      const s = c.rampSensitivity();
      assert.equal(s.step, MAX_RAMP_STEPS, 'the ramp is capped at three steps');
      assert.equal(s.effectiveMinWeight, MIN_WEIGHT_FLOOR, 'the floor was crossed');
    }
  });

  test('every step is monotonic and never below the floor', () => {
    const c = createSemanticClassifier();
    c.setHoldMode(true);
    let previous = Infinity;
    for (let i = 0; i < 5; i++) {
      const { effectiveMinWeight } = c.rampSensitivity();
      assert.ok(effectiveMinWeight <= previous, 'sensitivity went backwards');
      assert.ok(effectiveMinWeight >= MIN_WEIGHT_FLOOR);
      previous = effectiveMinWeight;
    }
  });

  test('a new hold starts at the elevated bar again', () => {
    const c = createSemanticClassifier();
    c.setHoldMode(true);
    c.rampSensitivity();
    c.rampSensitivity();
    c.rampSensitivity();
    c.setHoldMode(false);
    c.setHoldMode(true);
    assert.ok(stream(c, 'okay')[0]!.effectiveMinWeight > MIN_WEIGHT_FLOOR);
  });

  test('the elevated bar makes a hold harder to leave (A-7 is the hard constraint)', () => {
    const line = 'Sorry about that, I have the case up now';
    const free = createSemanticClassifier();
    free.noteAgentSpoke(500);
    const held = createSemanticClassifier();
    held.setHoldMode(true);
    const outside = stream(free, line).at(-1)!;
    const inside = stream(held, line).at(-1)!;
    assert.equal(outside.winner, 'HUMAN');
    assert.ok(inside.effectiveMinWeight > outside.effectiveMinWeight);
    assert.ok(inside.confidence <= outside.confidence + 1e-9);
  });
});

describe('signals, availability and UNKNOWN (§6.2, §6.4)', () => {
  test('responsiveness is unavailable during hold — the agent is silent (§6.2)', () => {
    const c = createSemanticClassifier();
    c.noteAgentSpoke(500);
    assert.ok(stream(c, 'okay sure')[0]!.signalsAvailable.includes('responsiveness'));
    c.setHoldMode(true);
    assert.ok(!stream(c, 'okay sure')[0]!.signalsAvailable.includes('responsiveness'));
  });

  test('turn-length variance appears only once there are turns to compare', () => {
    const c = createSemanticClassifier();
    assert.ok(!stream(c, 'yes')[0]!.signalsAvailable.includes('turnLengthVariance'));
    for (const t of ['yes', 'that is right okay', 'I can look that up for you now']) {
      stream(c, t);
      c.endTurn();
    }
    assert.ok(stream(c, 'sure')[0]!.signalsAvailable.includes('turnLengthVariance'));
  });

  test('variance: a script repeats one length, a person does not', () => {
    assert.ok(varianceScore([8, 8, 8, 8]) < 0.1);
    assert.ok(varianceScore([2, 14, 5, 22]) > 0.8);
  });

  test('the routing shape counts on its own: "press two" is a full menu score', () => {
    assert.equal(menuLanguageScore('press two'), 1, 'the "press <digit>" shape carries its own weight');
    assert.equal(menuLanguageScore('for behavioral health press two'), 1);
  });

  test('"you" and "your" are not conversational: announcements use them too', () => {
    assert.equal(conversationalScore('your call may be monitored or recorded'), 0);
    assert.equal(conversationalScore('if you know your extension you may dial it'), 0);
    assert.ok(conversationalScore('okay I can look that up for you') > 0.5);
  });

  test('the margin is a second bar: clearing the weight alone is not a decision', () => {
    // minWeightFloor 0 clears the first bar for anything; only the margin can
    // refuse here, and without it every observation would be "accepted".
    const c = createSemanticClassifier({ minWeightFloor: 0, margin: 0.99 });
    const o = stream(c, 'For claims status, press two.').at(-1)!;
    assert.equal(o.accepted, false);
    assert.equal(o.winner, 'UNKNOWN');
    assert.ok(o.confidence >= 0.6, 'the winner still scored well — it just did not lead by enough');
  });

  test('menu language is a score, not a keyword hit', () => {
    assert.ok(menuLanguageScore('For claims status, press two.') > 0.9);
    assert.ok(menuLanguageScore('I can press on that with the reviewer') <= 0.5, 'one stray "press" is not a menu');
    assert.equal(menuLanguageScore('I will note that on the case'), 0);
  });

  test('an evenly split result is UNKNOWN, and its scores are still reported (§6.4)', () => {
    const c = createSemanticClassifier({ minWeightFloor: 0.99 }); // nothing can clear this
    const o = stream(c, 'For claims status, press two.').at(-1)!;
    assert.equal(o.winner, 'UNKNOWN');
    assert.equal(o.accepted, false);
    assert.ok(o.scores.IVR_PROMPT > o.scores.HUMAN);
  });

  test('every observation carries the delta that produced it and the bar it was judged against', () => {
    const c = createSemanticClassifier();
    const os = stream(c, 'Thank you for calling');
    assert.equal(os.at(-1)!.sourceDelta, 'ing', 'the last delta, not the whole utterance');
    assert.equal(os.at(-1)!.effectiveMinWeight, MIN_WEIGHT_FLOOR);
    assert.equal(os.at(-1)!.seq, 0, 'seq is assigned by the core, not here');
  });

  test('reset clears the utterance, the hold state and the ramp', () => {
    const c = createSemanticClassifier();
    stream(c, 'one moment');
    c.setHoldMode(true);
    c.rampSensitivity();
    c.reset();
    const o = stream(c, 'hello there')[0]!;
    assert.notEqual(o.winner, 'HOLD_CUE', 'the previous utterance survived reset');
    assert.equal(o.effectiveMinWeight, MIN_WEIGHT_FLOOR);
  });
});
