/**
 * Acceptance criteria for module 1.8 (§21 week 1), detectors half:
 *   "both detectors unit-tested against positive and negative examples"
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClosingTracker, disclosureDetector, matchDisclosure, normalize } from '../src/index.js';

describe('disclosure detector — positive', () => {
  const positives = [
    "Hi, I'm an AI assistant calling on behalf of Riverside Clinic about a prior authorization.",
    'This is an automated assistant calling from Riverside Clinic.',
    'Hello, you are speaking with an automated system calling for Riverside Clinic.',
    "I'm a virtual assistant, calling on behalf of the clinic.",
    // How transcripts spell it: the §7.6 list includes "a i assistant" for this.
    "I'm an A.I. assistant calling on behalf of Riverside Clinic.",
    'AI-assistant here, calling from Riverside.',
    'HELLO, THIS IS AN AI ASSISTANT CALLING ON BEHALF OF RIVERSIDE.',
    // Order does not matter, only that both are in the one turn.
    "Calling on behalf of Riverside Clinic — I should say I'm an AI assistant.",
    // Line breaks and doubled spaces from joined deltas.
    'I am an AI\nassistant  calling on   behalf of Riverside.',
  ];
  for (const turn of positives) test(JSON.stringify(turn), () => assert.equal(disclosureDetector.test(turn), true));
});

describe('disclosure detector — negative', () => {
  const negatives = [
    // "assistant" alone must never count (§7.6).
    "Hi, I'm Sam, an assistant calling on behalf of Riverside Clinic.",
    // Self-identification without a behalf phrase.
    "I'm an AI assistant. How can I help?",
    // Behalf phrase without self-identification.
    'Calling on behalf of Riverside Clinic about a prior authorization.',
    // Word boundaries: "calling formally" does not contain "calling for".
    "I'm an AI assistant, calling formally to follow up.",
    // Word boundaries: "maintain" contains "ai" but is not "ai assistant".
    'We maintain assistant records, calling from Riverside.',
    // Unjoined deltas — the reason packages/agent inserts spaces.
    "I'm an AIassistant callingonbehalfof Riverside.",
    '',
    'Please go ahead.',
  ];
  for (const turn of negatives) test(JSON.stringify(turn), () => assert.equal(disclosureDetector.test(turn), false));
});

test('matchDisclosure names what matched, for the disclosure.delivered quote', () => {
  assert.deepEqual(matchDisclosure("I'm an A.I. assistant calling for Riverside."), { self: 'a i assistant', behalf: 'calling for' });
});

test('normalize pads and collapses', () => {
  assert.equal(normalize('  A.I.--Assistant! '), ' a i assistant ');
});

describe('closing tracker', () => {
  const ORDER = ['RECORD_OUTCOME', 'CLOSING'];

  test('positive: closing once [[CLOSING]] is reached in order', () => {
    const t = createClosingTracker(ORDER);
    t.noteMarkerReached('RECORD_OUTCOME');
    t.noteMarkerReached('CLOSING');
    assert.equal(t.isClosing(), true);
  });

  test('negative: not closing before any marker, nor after only [[RECORD_OUTCOME]]', () => {
    const t = createClosingTracker(ORDER);
    assert.equal(t.isClosing(), false);
    t.noteMarkerReached('RECORD_OUTCOME');
    assert.equal(t.isClosing(), false);
  });

  test('negative: [[CLOSING]] before [[RECORD_OUTCOME]] is refused, and does not mark closing', () => {
    const t = createClosingTracker(ORDER);
    assert.throws(() => t.noteMarkerReached('CLOSING'), /before \[\[RECORD_OUTCOME\]\]/);
    assert.equal(t.isClosing(), false);
  });

  test('negative: a prompt without [[CLOSING]] never marks closing', () => {
    const t = createClosingTracker([]);
    assert.throws(() => t.noteMarkerReached('CLOSING'), /not in the loaded prompt/);
    assert.equal(t.isClosing(), false);
  });

  test('a repeated marker is harmless; reset starts over', () => {
    const t = createClosingTracker(ORDER);
    t.noteMarkerReached('RECORD_OUTCOME');
    t.noteMarkerReached('CLOSING');
    t.noteMarkerReached('RECORD_OUTCOME');
    assert.equal(t.isClosing(), true);
    t.reset();
    assert.equal(t.isClosing(), false);
  });
});
