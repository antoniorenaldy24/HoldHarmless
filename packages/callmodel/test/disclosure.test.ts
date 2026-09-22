/**
 * Acceptance criteria for module 2.5 (§21 week 2):
 *   "A-12 passes (10/10 announced transfers); A-20 passes (20/20 short-hold
 *    swaps against parties_used); A-29 passes"
 *
 * A-29 is met here in full: every (channel, phase, hedged, disclosed)
 * combination is rendered and checked for contradictory instructions.
 *
 * A-12 and A-20 are NOT met here and cannot be: both compare
 * disclosuresDelivered against harness ground truth over whole calls in which
 * the MODEL speaks, which needs the call loop of week 3 and live session
 * credit. What this file proves is everything under the model: the resets of
 * ADR-017, the hedge trigger, and the rule that only an observed phrase counts.
 * The §20 rows say so too, rather than borrowing these tests' green.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthRequest, Call, CallEventBody, Channel, ClosingKind, NavMode, Phase } from '@holdharmless/events';
import { promptFor, promptText, type PromptContext } from '@holdharmless/prompts';
import { CHANNELS, PHASES } from '../src/index.js';
import {
  DISCLOSURE_RESET_HOLD_MS,
  PARTY_CONTINUITY_MS,
  createDisclosureTracker,
} from '../src/disclosure.js';

const DISCLOSURE_SENTENCE = "Hi, I'm an AI assistant calling on behalf of Riverside Clinic about a prior authorization.";

const REQUEST: AuthRequest = {
  id: 'SYN-REQ-1', patientRef: 'SYN-PT-1', memberId: 'SYN-M-1', patientDob: '1970-01-01',
  cptCode: '72148', icdCode: 'M54.16', providerNpi: '1234567890', serviceDate: '2026-10-01',
  payerId: 'SYN-PAYER-1', payerEndpoint: 'ws://127.0.0.1:8081/call', clinicName: 'Riverside Synthetic Clinic',
  clinicCallbackPhone: '555-0142', priority: 'routine', clinicalSummary: 'Synthetic summary.',
  status: 'in_progress', attempts: 0,
};

const CALL: Call = {
  id: 'SYN-CALL-1', requestId: REQUEST.id, transport: 'loopback', navMode: 'dtmf', networkProfile: 'TELEPHONY',
  startedAt: '2026-09-23T00:00:00.000Z', channel: 'HUMAN', phase: 'EXCHANGE', holdSuspected: false,
  holdDurationMs: 0, cumulativeHoldMs: 0, humanChannelMs: 0, disclosedToCurrentParty: false,
  partiesDetected: 1, disclosuresDelivered: 0, capturedAuthNumber: 'PA-7781-QX', readbackAttempts: 0,
  rePromptCounts: {}, holdRampSteps: 0, pendingContextCorrection: false, discardedToolResults: [],
  outcomeWritten: false, billableSessionMs: 0,
};

describe('the field is set by observation, never by provenance (ADR-017)', () => {
  test('loading a prompt that instructs disclosure does not mark the party as told', () => {
    const t = createDisclosureTracker();
    const bundle = promptFor({
      channel: 'HUMAN', phase: 'EXCHANGE', navMode: 'dtmf', partyContinuityAssured: true,
      disclosedToCurrentParty: false, pendingContextCorrection: false, discardedToolResults: [],
      request: REQUEST, call: CALL,
    })!;
    assert.ok(bundle.disclosureIncluded, 'the prompt did instruct a disclosure');
    assert.equal(t.disclosedToCurrentParty, false, 'the instruction alone marked the party as informed');
  });

  test('an agent turn containing the phrase sets it, and is counted and quoted', () => {
    const events: CallEventBody[] = [];
    const t = createDisclosureTracker({ emit: (e) => events.push(e) });
    assert.equal(t.onAgentTurn('Good afternoon, could I get the member ID?'), false);
    assert.equal(t.disclosedToCurrentParty, false);
    assert.equal(t.onAgentTurn(DISCLOSURE_SENTENCE), true);
    assert.equal(t.disclosedToCurrentParty, true);
    assert.equal(t.disclosuresDelivered, 1);
    const delivered = events.find((e) => e.t === 'disclosure.delivered')!;
    assert.equal(delivered.t === 'disclosure.delivered' && delivered.partyIndex, 1);
    assert.ok(delivered.t === 'disclosure.delivered' && delivered.quote.includes('AI assistant'));
  });

  test('a turn that only half-matches is not a disclosure (§7.6)', () => {
    const t = createDisclosureTracker();
    assert.equal(t.onAgentTurn("I'm an AI assistant. How can I help?"), false, 'no behalf phrase');
    assert.equal(t.onAgentTurn('Calling on behalf of Riverside Clinic.'), false, 'no self-identification');
    assert.equal(t.disclosedToCurrentParty, false);
  });
});

describe('ADR-017 resets, one case per row', () => {
  const told = () => {
    const events: CallEventBody[] = [];
    const t = createDisclosureTracker({ emit: (e) => events.push(e) });
    t.onAgentTurn(DISCLOSURE_SENTENCE);
    return { t, events };
  };

  test('notify_transfer: a new party, not yet told', () => {
    const { t, events } = told();
    t.onNotifyTransfer();
    assert.equal(t.disclosedToCurrentParty, false);
    assert.equal(t.partiesDetected, 2);
    assert.equal(events.filter((e) => e.t === 'party.changed').at(-1)!.t === 'party.changed', true);
  });

  test('entering TRANSFER: a new party', () => {
    const { t } = told();
    t.onChannelChange('HUMAN', 'TRANSFER', 0);
    assert.equal(t.disclosedToCurrentParty, false);
    assert.equal(t.partiesDetected, 2);
  });

  test('returning to IVR from HOLD: whoever answers next has been told nothing', () => {
    const { t, events } = told();
    t.onChannelChange('HOLD', 'IVR', 30_000);
    assert.equal(t.disclosedToCurrentParty, false);
    const change = events.filter((e) => e.t === 'party.changed').at(-1)!;
    assert.equal(change.t === 'party.changed' && change.reason, 'ivr_return');
  });

  test('a hold longer than DISCLOSURE_RESET_HOLD_MS resets; a shorter one does not', () => {
    const long = told();
    long.t.onChannelChange('HOLD', 'HUMAN', DISCLOSURE_RESET_HOLD_MS + 1);
    assert.equal(long.t.disclosedToCurrentParty, false);
    assert.equal(long.t.partiesDetected, 2);

    const short = told();
    short.t.onChannelChange('HOLD', 'HUMAN', DISCLOSURE_RESET_HOLD_MS - 1);
    assert.equal(short.t.disclosedToCurrentParty, true, 'a 119 s hold reset the flag');
    assert.equal(short.t.partiesDetected, 1);
  });

  test('an ordinary HUMAN to HOLD transition changes nothing', () => {
    const { t, events } = told();
    t.onChannelChange('HUMAN', 'HOLD', 0);
    assert.equal(t.disclosedToCurrentParty, true);
    assert.deepEqual(events.filter((e) => e.t === 'party.changed'), []);
  });
});

describe('the hedge trigger (ADR-017): continuity is assured only by a short hold', () => {
  const t = createDisclosureTracker();

  test('a hold shorter than PARTY_CONTINUITY_MS is assured; a longer one is not', () => {
    assert.equal(t.promptInputs({ channel: 'HUMAN', channelCameFrom: 'HOLD', holdSegmentMs: PARTY_CONTINUITY_MS - 1 }).partyContinuityAssured, true);
    assert.equal(t.promptInputs({ channel: 'HUMAN', channelCameFrom: 'HOLD', holdSegmentMs: PARTY_CONTINUITY_MS + 1 }).partyContinuityAssured, false);
  });

  test('a return from TRANSFER is never assured: the party was announced as changed', () => {
    assert.equal(t.promptInputs({ channel: 'HUMAN', channelCameFrom: 'TRANSFER', holdSegmentMs: 0 }).partyContinuityAssured, false);
  });

  test('the 20-40 s swap A-20 is built around produces the hedge', () => {
    for (const seconds of [20, 30, 40]) {
      const inputs = t.promptInputs({ channel: 'HUMAN', channelCameFrom: 'HOLD', holdSegmentMs: seconds * 1000 });
      const bundle = promptFor({
        channel: 'HUMAN', phase: 'EXCHANGE', navMode: 'dtmf', pendingContextCorrection: false,
        discardedToolResults: [], request: REQUEST, call: CALL, ...inputs,
      })!;
      assert.ok(bundle.hedged, `${seconds} s swap did not hedge`);
      assert.match(bundle.text, /AI\s+assistant calling on behalf of/, 'the hedge must carry the disclosure itself');
    }
  });

  test('the hedge fires on a 20 s hold measured from SUSPICION, and would not from confirmation', () => {
    // ADR-017's reason for measuring from holdSuspectedAt: on the acoustic path
    // confirmation lags by up to 20 s, so a 20 s hold measured from the channel
    // transition reads as 0 s — under the 5 s threshold, and the hedge is lost.
    const fromSuspicion = t.promptInputs({ channel: 'HUMAN', channelCameFrom: 'HOLD', holdSegmentMs: 20_000 });
    const fromConfirmation = t.promptInputs({ channel: 'HUMAN', channelCameFrom: 'HOLD', holdSegmentMs: 20_000 - 19_000 });
    assert.equal(fromSuspicion.partyContinuityAssured, false, 'measured from suspicion: hedge');
    assert.equal(fromConfirmation.partyContinuityAssured, true, 'measured from confirmation: no hedge — the error ADR-017 names');
  });
});

describe('A-29: no rendered prompt ever contains contradictory instructions', () => {
  const NAV: NavMode[] = ['dtmf', 'speech'];
  const CLOSING: (ClosingKind | undefined)[] = ['wrapup', 'escalation', undefined];

  test('every (channel, phase, hedged, disclosed) combination, rendered', () => {
    let rendered = 0;
    let hedgedCount = 0;
    for (const channel of CHANNELS) for (const phase of PHASES) for (const navMode of NAV) for (const closingKind of CLOSING)
      for (const cameFrom of [undefined, 'HOLD', 'TRANSFER', 'IVR'] as (Channel | undefined)[])
        for (const assured of [true, false]) for (const disclosed of [true, false]) {
          const ctx: PromptContext = {
            channel, phase, navMode, partyContinuityAssured: assured, disclosedToCurrentParty: disclosed,
            pendingContextCorrection: false, discardedToolResults: [], request: REQUEST, call: CALL,
            ...(closingKind ? { closingKind } : {}), ...(cameFrom ? { channelCameFrom: cameFrom } : {}),
          };
          let bundle;
          try {
            bundle = promptFor(ctx);
          } catch {
            continue; // the two combinations the call model makes impossible
          }
          if (!bundle) continue;
          rendered++;
          const label = `${channel}/${phase}/${navMode}/${closingKind}/from ${cameFrom}/assured ${assured}/disclosed ${disclosed}`;

          // The contradiction A-29 forbids: "introduce yourself" beside "do not
          // repeat yourself", in one system prompt, at the moment the ethical
          // claim is tested.
          assert.ok(!(bundle.files.includes('PARTY_HEDGE.txt') && bundle.files.includes('DISCLOSURE.txt')), `${label}: both files`);
          assert.equal(bundle.hedged && bundle.disclosureIncluded, false, label);
          if (bundle.hedged) {
            hedgedCount++;
            assert.match(bundle.text, /continue without repeating yourself/, `${label}: the hedge lost its continuity clause`);
            assert.match(bundle.text, /AI\s+assistant calling on behalf of/, `${label}: the hedge lost its disclosure`);
            assert.doesNotMatch(bundle.text, /Before anything else, state that you are an AI assistant/, `${label}: the unconditional disclosure came too`);
          }
        }
    console.log(`      A-29: ${rendered} prompt combinations rendered, ${hedgedCount} hedged, zero contradictions`);
    assert.ok(rendered > 200, `only ${rendered} combinations were rendered`);
    assert.ok(hedgedCount > 0, 'no combination produced a hedge — the check proved nothing');
  });

  test('the two files really do contradict each other, so the check is not vacuous', () => {
    // If DISCLOSURE.txt stopped being unconditional, or the hedge stopped
    // covering the case, the test above would pass for the wrong reason.
    assert.match(promptText('DISCLOSURE.txt'), /Before anything else, state that you are an AI assistant/);
    assert.match(promptText('PARTY_HEDGE.txt'), /If it is clearly the same person, continue without repeating yourself/);
  });
});

describe('the count is of disclosures spoken (ADR-018, INV-7)', () => {
  test('a second party told is a second disclosure, and parties keep pace', () => {
    const t = createDisclosureTracker();
    t.onAgentTurn(DISCLOSURE_SENTENCE);
    t.onNotifyTransfer();
    t.onAgentTurn(DISCLOSURE_SENTENCE);
    assert.equal(t.disclosuresDelivered, 2);
    assert.equal(t.partiesDetected, 2);
    assert.ok(t.disclosuresDelivered >= t.partiesDetected, 'INV-7: every party was told');
  });

  test('a party that is never told leaves the count short — the failure INV-7 catches', () => {
    const t = createDisclosureTracker();
    t.onAgentTurn(DISCLOSURE_SENTENCE);
    t.onNotifyTransfer();
    assert.ok(t.disclosuresDelivered < t.partiesDetected);
  });

  test('repeating a disclosure to the same party is counted, and harms nothing', () => {
    // ADR-017's binding principle: too often, never too rarely.
    const t = createDisclosureTracker();
    t.onAgentTurn(DISCLOSURE_SENTENCE);
    t.onAgentTurn(DISCLOSURE_SENTENCE);
    assert.equal(t.disclosuresDelivered, 2);
    assert.equal(t.partiesDetected, 1);
  });
});
