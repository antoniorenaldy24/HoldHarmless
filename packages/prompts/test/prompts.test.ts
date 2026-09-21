/**
 * Acceptance criteria for module 1.8 (§21 week 1), prompts half:
 *   "positionalPromptName total; renderer resolves every placeholder; hedge and
 *    disclosure mutually exclusive"
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AuthRequest, Call, Channel, ClosingKind, NavMode, Phase } from '@holdharmless/events';
import { CHANNELS, PHASES, reachablePositions, positionId } from '@holdharmless/callmodel';
import { createClosingTracker } from '@holdharmless/detectors';
import {
  PROMPT_DIR,
  PROMPT_FILES,
  positionalPromptName,
  promptFor,
  promptText,
  render,
  type PromptContext,
} from '../src/index.js';

const REQUEST: AuthRequest = {
  id: 'SYN-REQ-0001',
  patientRef: 'SYN-PT-0001',
  memberId: 'SYN-M-44821',
  patientDob: '1970-01-01',
  cptCode: '72148',
  icdCode: 'M54.16',
  providerNpi: '8084012345',
  serviceDate: '2026-10-01',
  payerId: 'SYN-PAYER-1',
  payerEndpoint: 'ws://127.0.0.1:4010',
  clinicName: 'Riverside Synthetic Clinic',
  clinicCallbackPhone: '555-0142',
  priority: 'routine',
  clinicalSummary: 'Synthetic summary.',
  status: 'in_progress',
  attempts: 0,
};

const CALL: Call = {
  id: 'SYN-CALL-0001',
  requestId: REQUEST.id,
  transport: 'loopback',
  navMode: 'dtmf',
  networkProfile: 'TELEPHONY',
  startedAt: '2026-09-22T00:00:00.000Z',
  channel: 'HUMAN',
  phase: 'EXCHANGE',
  holdSuspected: false,
  holdDurationMs: 0,
  cumulativeHoldMs: 0,
  humanChannelMs: 0,
  disclosedToCurrentParty: false,
  partiesDetected: 1,
  disclosuresDelivered: 0,
  readbackAttempts: 0,
  rePromptCounts: {},
  holdRampSteps: 0,
  pendingContextCorrection: false,
  discardedToolResults: [],
  outcomeWritten: false,
  billableSessionMs: 0,
};

function ctx(over: Partial<PromptContext> = {}): PromptContext {
  return {
    channel: 'HUMAN',
    phase: 'EXCHANGE',
    navMode: 'dtmf',
    partyContinuityAssured: true,
    disclosedToCurrentParty: true,
    pendingContextCorrection: false,
    discardedToolResults: [],
    request: REQUEST,
    call: { ...CALL, capturedAuthNumber: 'PA-7781-QX' },
    ...over,
  };
}

const NAV_MODES: NavMode[] = ['dtmf', 'speech'];
const CLOSING_KINDS: (ClosingKind | undefined)[] = ['wrapup', 'escalation', undefined];

describe('positionalPromptName is total', () => {
  test('every (channel, phase, navMode, closingKind) returns a file, null, or one of the two documented refusals', () => {
    for (const channel of CHANNELS) for (const phase of PHASES) for (const navMode of NAV_MODES) for (const closingKind of CLOSING_KINDS) {
      const c = { channel, phase, navMode, ...(closingKind ? { closingKind } : {}) };
      try {
        const name = positionalPromptName(c);
        if (name !== null) assert.ok((PROMPT_FILES as readonly string[]).includes(name), `${name} is not a prompt file`);
      } catch (e) {
        const documented =
          (channel === 'HUMAN' && phase === 'NOT_STARTED') ||
          (channel === 'HUMAN' && phase === 'CLOSING' && closingKind === undefined);
        assert.ok(documented, `${channel}/${phase}/${navMode}/${closingKind}: undocumented throw: ${(e as Error).message}`);
      }
    }
  });

  test('no REACHABLE position is refused', () => {
    for (const id of reachablePositions()) {
      const [channel, phase] = id.split('/') as [Channel, Phase];
      for (const navMode of NAV_MODES) {
        const closingKinds: ClosingKind[] = phase === 'CLOSING' ? ['wrapup', 'escalation'] : [];
        for (const closingKind of closingKinds.length ? closingKinds : [undefined]) {
          assert.doesNotThrow(() => positionalPromptName({ channel, phase, navMode, ...(closingKind ? { closingKind } : {}) }), id);
        }
      }
    }
  });

  test('the two refusals are for positions the call model makes unreachable', () => {
    assert.ok(!reachablePositions().has(positionId('HUMAN', 'NOT_STARTED')));
  });

  test('the §7.3 table, row by row', () => {
    const p = (channel: Channel, phase: Phase, navMode: NavMode = 'dtmf', closingKind?: ClosingKind) =>
      positionalPromptName({ channel, phase, navMode, ...(closingKind ? { closingKind } : {}) });
    assert.equal(p('IVR', 'NOT_STARTED', 'dtmf'), 'IVR_DTMF.txt');
    assert.equal(p('IVR', 'EXCHANGE', 'speech'), 'IVR_SPEECH.txt');
    assert.equal(p('HOLD', 'READBACK'), 'HOLD.txt');
    assert.equal(p('TRANSFER', 'CLOSING', 'dtmf', 'wrapup'), 'TRANSFER.txt');
    assert.equal(p('HUMAN', 'EXCHANGE'), 'EXCHANGE.txt');
    assert.equal(p('HUMAN', 'READBACK'), 'READBACK.txt');
    assert.equal(p('HUMAN', 'CLOSING', 'dtmf', 'wrapup'), 'CLOSING_WRAPUP.txt');
    assert.equal(p('HUMAN', 'CLOSING', 'dtmf', 'escalation'), 'CLOSING_ESCALATION.txt');
    assert.equal(p('DIALING', 'NOT_STARTED'), null);
    assert.equal(p('CLOSED', 'DONE'), null);
    assert.equal(p('HUMAN', 'DONE'), null);
  });

  test('PROMPT_FILES and the files directory hold the same set', () => {
    assert.deepEqual(fs.readdirSync(PROMPT_DIR).sort(), [...PROMPT_FILES].sort());
  });
});

describe('the renderer resolves every placeholder', () => {
  test('every prompt file renders with nothing left unrendered', () => {
    for (const request of [REQUEST, { ...REQUEST, priority: 'expedited' as const, attempts: 2, lastReference: 'REF-1' }]) {
      for (const f of PROMPT_FILES) {
        const r = render(promptText(f), { request, call: { ...CALL, capturedAuthNumber: 'PA-7781-QX' } });
        assert.doesNotMatch(r.text, /<[A-Za-z/]|\[\[/, `${f} left a construct in its output`);
      }
    }
  });

  test('placeholders are substituted, and their names recorded', () => {
    const r = render(promptText('READBACK.txt'), { request: REQUEST, call: { ...CALL, capturedAuthNumber: 'PA-7781-QX' } });
    assert.match(r.text, /ask them to confirm it: PA-7781-QX/);
    assert.deepEqual(r.substitutions, ['CAPTURED_AUTH_NUMBER']);
  });

  test('<if priority = expedited> is included only when expedited', () => {
    const routine = render(promptText('DISCLOSURE.txt'), { request: REQUEST, call: CALL }).text;
    const expedited = render(promptText('DISCLOSURE.txt'), { request: { ...REQUEST, priority: 'expedited' }, call: CALL }).text;
    assert.doesNotMatch(routine, /EXPEDITED/);
    assert.match(expedited, /EXPEDITED/);
  });

  test('<if attempts > 0> with and without a last reference', () => {
    const first = render(promptText('DISCLOSURE.txt'), { request: REQUEST, call: CALL }).text;
    assert.doesNotMatch(first, /follow-up/);
    const withRef = render(promptText('DISCLOSURE.txt'), { request: { ...REQUEST, attempts: 1, lastReference: 'REF-9' }, call: CALL }).text;
    assert.match(withRef, /give reference REF-9 if you\s+have one/);
    const noRef = render(promptText('DISCLOSURE.txt'), { request: { ...REQUEST, attempts: 1 }, call: CALL }).text;
    assert.match(noRef, /give reference none on file if you\s+have one/);
  });

  test('an unset required field is an error, not an empty string', () => {
    assert.throws(() => render(promptText('READBACK.txt'), { request: REQUEST, call: CALL }), /CAPTURED_AUTH_NUMBER.*unset/);
  });

  test('a placeholder naming no field is an error', () => {
    assert.throws(() => render('Say <NOT_A_FIELD>.', { request: REQUEST, call: CALL }), /names no field/);
  });

  test('a construct the renderer does not know is an error, not passed through', () => {
    const src = { request: REQUEST, call: CALL };
    // A lower-case placeholder is not a placeholder, and would reach the model verbatim.
    assert.throws(() => render('Call on behalf of <clinic_name>.', src), /unrendered construct/);
    assert.throws(() => render('<unless attempts > 0>\nx\n</unless>', src), /unrendered construct/);
  });

  test('a placeholder naming a field on both entities is refused', () => {
    assert.throws(() => render('Your id is <ID>.', { request: REQUEST, call: CALL }), /ambiguous/);
  });

  test('malformed, nested and unclosed <if> blocks are errors', () => {
    const src = { request: REQUEST, call: CALL };
    assert.throws(() => render('<if priority ~ expedited>\nx\n</if>', src), /unrecognized/);
    assert.throws(() => render('<if attempts > 0>\n<if attempts > 1>\nx\n</if>\n</if>', src), /nested/);
    assert.throws(() => render('<if attempts > 0>\nx', src), /never closed/);
    assert.throws(() => render('x\n</if>', src), /without an open/);
    assert.throws(() => render('<if nosuch = 1>\nx\n</if>', src), /names no field/);
    assert.throws(() => render('<if priority > 1>\nx\n</if>', src), /non-number/);
  });

  test('markers are recorded in order and stripped', () => {
    const r = render(promptText('CLOSING_WRAPUP.txt'), { request: REQUEST, call: CALL });
    assert.deepEqual(r.markerOrder, ['RECORD_OUTCOME', 'CLOSING']);
    assert.doesNotMatch(r.text, /\[\[/);
  });

  test('a marker sharing a line with text is refused', () => {
    assert.throws(() => render('Say goodbye. [[CLOSING]]', { request: REQUEST, call: CALL }), /shares a line/);
  });

  test('CRLF input renders the same as LF', () => {
    const lf = promptText('DISCLOSURE.txt');
    const src = { request: REQUEST, call: CALL };
    assert.equal(render(lf.replaceAll('\n', '\r\n'), src).text, render(lf, src).text);
  });
});

describe('hedge and disclosure are mutually exclusive', () => {
  const FROM: (Channel | undefined)[] = [undefined, ...CHANNELS];

  test('over every combination of the inputs that decide them', () => {
    for (const channel of ['HUMAN', 'IVR', 'HOLD', 'TRANSFER'] as const) for (const channelCameFrom of FROM)
      for (const partyContinuityAssured of [true, false]) for (const disclosedToCurrentParty of [true, false]) {
        const b = promptFor(ctx({ channel, partyContinuityAssured, disclosedToCurrentParty, ...(channelCameFrom ? { channelCameFrom } : {}) }))!;
        const label = `${channel} from ${channelCameFrom} assured=${partyContinuityAssured} disclosed=${disclosedToCurrentParty}`;

        assert.ok(!(b.hedged && b.disclosureIncluded), `${label}: both emitted`);
        assert.equal(b.hedged, b.files.includes('PARTY_HEDGE.txt'), label);
        assert.equal(b.disclosureIncluded, b.files.includes('DISCLOSURE.txt'), label);

        const expectHedge = channel === 'HUMAN' && (channelCameFrom === 'HOLD' || channelCameFrom === 'TRANSFER') && !partyContinuityAssured;
        assert.equal(b.hedged, expectHedge, `${label}: hedge`);
        assert.equal(b.disclosureIncluded, channel === 'HUMAN' && !disclosedToCurrentParty && !expectHedge, `${label}: disclosure`);
      }
  });

  test('an undisclosed party returning from a long hold gets the hedge, which carries the disclosure', () => {
    const b = promptFor(ctx({ channelCameFrom: 'HOLD', partyContinuityAssured: false, disclosedToCurrentParty: false }))!;
    assert.deepEqual(b.files, ['PARTY_HEDGE.txt', 'EXCHANGE.txt']);
    assert.match(b.text, /AI\s+assistant calling on behalf of Riverside Synthetic Clinic/);
  });
});

describe('promptFor assembly', () => {
  test('the §7.3 order: correction, hedge, positional, disclosure', () => {
    const b = promptFor(ctx({ pendingContextCorrection: true, disclosedToCurrentParty: false }))!;
    assert.deepEqual(b.files, ['CONTEXT_CORRECTION.txt', 'EXCHANGE.txt', 'DISCLOSURE.txt']);
    assert.ok(b.text.startsWith('NOTE: your previous utterance was not transmitted'));
  });

  test('no prompt where nobody is spoken to or the work is done', () => {
    assert.equal(promptFor(ctx({ channel: 'DIALING', phase: 'NOT_STARTED' })), null);
    assert.equal(promptFor(ctx({ channel: 'HUMAN', phase: 'DONE', disclosedToCurrentParty: false })), null);
  });

  test('a closing prompt yields a marker order the closing tracker accepts', () => {
    const b = promptFor(ctx({ phase: 'CLOSING', closingKind: 'escalation' }))!;
    assert.deepEqual(b.markerOrder, ['RECORD_OUTCOME', 'CLOSING']);
    const t = createClosingTracker(b.markerOrder);
    t.noteMarkerReached('RECORD_OUTCOME');
    assert.equal(t.isClosing(), false);
    t.noteMarkerReached('CLOSING');
    assert.equal(t.isClosing(), true);
  });
});
