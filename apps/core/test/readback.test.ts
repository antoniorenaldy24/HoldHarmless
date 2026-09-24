/**
 * Module 3.5, the code half: §8.2's two checks, which must never be combined.
 *
 * A-15 (a correction during read-back) and A-13 (max_accuracy on spelled
 * numbers) are live experiments and live in scripts/; this file covers what
 * happens around them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CallEventBody } from '@holdharmless/events';
import { createPhaseMachine } from '@holdharmless/callmodel';
import { captureAppearsInSpeech, createReadbackIntegrity, spokenToCharacters } from '../src/index.js';

const setup = () => {
  const events: CallEventBody[] = [];
  return { events, integrity: createReadbackIntegrity({ emit: (e) => events.push(e) }) };
};

describe('spoken numbers become characters (§8.2)', () => {
  const cases: [string, string][] = [
    ['A as in alpha, four seven two, dash, nine one', 'A472-91'],
    ['P as in papa, A as in alpha, zero zero eight four four one seven', 'PA0084417'],
    ['Okay, your authorization number is C as in charlie, nine six, five, dash, nine six.', 'C965-96'],
    ['A472-91', 'A472-91'],
    ['no numbers here at all', ''],
  ];
  for (const [spoken, expected] of cases) {
    test(JSON.stringify(spoken.slice(0, 40)), () => assert.equal(spokenToCharacters(spoken), expected));
  }

  test('a disambiguation that is itself a digit or a letter is still skipped', () => {
    // Found by mutation: skipping two words instead of three is invisible for
    // "alpha" and "yankee", which the loop ignores anyway, and wrong the moment
    // the word after "in" is something the loop DOES read.
    assert.equal(spokenToCharacters('N as in nine, four'), 'N4');
    assert.equal(spokenToCharacters('B as in B, seven'), 'B7');
  });

  test('the disambiguation is skipped, not read as letters', () => {
    // "A as in alpha" must not become "AASINALPHA" — which would make every
    // spelled letter a mismatch and every capture suspect.
    assert.equal(spokenToCharacters('A as in alpha'), 'A');
    assert.equal(spokenToCharacters('X as in x-ray, Y as in yankee'), 'XY');
  });
});

describe('the sanity check: a review signal, never a rejection', () => {
  test('a capture found in far-end speech is silent', () => {
    const { integrity, events } = setup();
    assert.equal(integrity.checkCapture('A472-91', 'Your authorization number is A as in alpha, four seven two, dash, nine one.'), true);
    assert.deepEqual(events, []);
  });

  test('a capture that cannot be found is recorded as a suspect, and NOT as a violation', () => {
    const { integrity, events } = setup();
    assert.equal(integrity.checkCapture('B999-00', 'Your authorization number is A as in alpha, four seven two, dash, nine one.'), false);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.t, 'auth_number.suspect', 'a recognition signal must not turn the compliance panel red');
  });

  test('a missing separator does not make a capture suspect', () => {
    const { integrity } = setup();
    assert.equal(integrity.checkCapture('A472-91', 'it is A as in alpha four seven two nine one'), true);
  });

  test('the check cannot see an ASR insertion — and is not credited with it (§8.2, A-24)', () => {
    // Day 0's two failures: the wrong number was IN the transcript the model
    // read, so this check would have said nothing. READBACK is what catches it.
    const { integrity, events } = setup();
    const heardWrong = 'Your authorization number is P as in papa, A as in alpha, zero zero zero seven one two four four';
    assert.equal(integrity.checkCapture('PA00071244', heardWrong), true, 'the transcript agreed with the capture — both were wrong');
    assert.deepEqual(events, []);
  });
});

describe('the integrity check: rejected, paired with a violation, never retried', () => {
  test('a matching value is accepted silently', () => {
    const { integrity, events } = setup();
    assert.equal(integrity.checkOutcome('tc-1', 'A472-91', 'A472-91'), true);
    assert.deepEqual(events, []);
  });

  test('a mismatch emits the rejection AND the violation for the same toolCallId (INV-15)', () => {
    const { integrity, events } = setup();
    assert.equal(integrity.checkOutcome('tc-9', 'A473-91', 'A472-91'), false);
    assert.deepEqual(events.map((e) => e.t), ['tool.rejected', 'safety.violation']);
    const rejection = events[0]!;
    const violation = events[1]!;
    assert.equal(rejection.t === 'tool.rejected' && rejection.toolCallId, 'tc-9');
    assert.equal(violation.t === 'safety.violation' && violation.toolCallId, 'tc-9');
    assert.equal(violation.t === 'safety.violation' && violation.kind, 'auth_number_mismatch');
  });

  test('no normalization anywhere: case and separators are differences (ADR-020)', () => {
    const { integrity } = setup();
    assert.equal(integrity.checkOutcome('tc-1', 'a472-91', 'A472-91'), false);
    assert.equal(integrity.checkOutcome('tc-2', 'A472 91', 'A472-91'), false);
    assert.equal(integrity.checkOutcome('tc-3', 'A47291', 'A472-91'), false);
  });

  test('a recorded value that is itself missing is a mismatch, not a match', () => {
    // Found by mutation: without the explicit undefined guard, undefined on
    // BOTH sides compares equal and an outcome with no number at all is
    // accepted. record_outcome's arguments arrive as JSON from the model, so
    // this is a runtime shape the types do not rule out.
    const { integrity, events } = setup();
    assert.equal(integrity.checkOutcome('tc-0', undefined as unknown as string, undefined), false);
    assert.deepEqual(events.map((e) => e.t), ['tool.rejected', 'safety.violation']);
  });

  test('recording an approval with nothing captured is a mismatch too', () => {
    const { integrity, events } = setup();
    assert.equal(integrity.checkOutcome('tc-4', 'A472-91', undefined), false);
    assert.match(events[0]!.t === 'tool.rejected' ? events[0]!.detail : '', /no authorization number was captured/);
  });
});

describe('the correction path (§8.2, §5.4)', () => {
  test('a correction replaces the stored value and returns the call to EXCHANGE', () => {
    const m = createPhaseMachine();
    m.onChannelChange('HUMAN');
    m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    assert.equal(m.state.phase, 'READBACK');
    m.onToolAccepted('confirm_readback', { matched: false, corrected_value: 'A473-91' });
    assert.equal(m.state.capturedAuthNumber, 'A473-91');
    assert.equal(m.state.phase, 'EXCHANGE');
    assert.equal(m.state.readbackAttempts, 1);
  });

  test('after a correction, the corrected value is what record_outcome must carry', () => {
    const { integrity } = setup();
    const m = createPhaseMachine();
    m.onChannelChange('HUMAN');
    m.onToolAccepted('capture_auth_number', { value: 'A472-91' });
    m.onToolAccepted('confirm_readback', { matched: false, corrected_value: 'A473-91' });
    m.onToolAccepted('capture_auth_number', { value: 'A473-91' });
    m.onToolAccepted('confirm_readback', { matched: true });
    assert.equal(integrity.checkOutcome('tc-1', 'A472-91', m.state.capturedAuthNumber), false, 'the number before the correction must not pass');
    assert.equal(integrity.checkOutcome('tc-2', 'A473-91', m.state.capturedAuthNumber), true);
  });
});
