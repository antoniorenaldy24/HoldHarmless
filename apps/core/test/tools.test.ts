/**
 * Acceptance criteria for module 3.1 (§21 week 3):
 *   "Allowlist authorization precedes execution; rejections return reasons;
 *    §8.8 ordering respected including side-effect persistence on interrupt"
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthRequest, Call, Channel, Outcome, Phase, ToolName } from '@holdharmless/events';
import { POSITION_POLICY, toolsAllowedAt } from '@holdharmless/callmodel';
import {
  DENIAL_BLOCKLIST,
  TOOL_SCHEMAS,
  createToolHandlers,
  denialReasonProblem,
  validateAgainstSchema,
  validateOutcomeArgs,
  type PropertySchema,
  type ToolCallState,
  type ToolEffects,
  type ToolEvent,
  type ToolSchema,
} from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SSOT = fs.readFileSync(path.join(ROOT, 'holdharmless-ssot-v1.2.md'), 'utf8').replaceAll(String.fromCharCode(13), '');

const REQUEST: AuthRequest = {
  id: 'SYN-REQ-1', patientRef: 'SYN-PT-1', memberId: 'SYN-M-44821', patientDob: '1970-03-14',
  cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-01',
  payerId: 'SYN-PAYER-1', payerEndpoint: 'ws://127.0.0.1:8081/call', clinicName: 'Riverside Synthetic Clinic',
  clinicCallbackPhone: '555-0142', priority: 'routine', clinicalSummary: 'Synthetic clinical summary, approved before the call.',
  status: 'in_progress', attempts: 0,
};

const CALL: Call = {
  id: 'SYN-CALL-1', requestId: REQUEST.id, transport: 'loopback', navMode: 'dtmf', networkProfile: 'TELEPHONY',
  startedAt: '2026-09-23T00:00:00.000Z', channel: 'HUMAN', phase: 'EXCHANGE', holdSuspected: false,
  holdDurationMs: 0, cumulativeHoldMs: 0, humanChannelMs: 0, disclosedToCurrentParty: true,
  partiesDetected: 1, disclosuresDelivered: 1, readbackAttempts: 0, rePromptCounts: {}, holdRampSteps: 0,
  pendingContextCorrection: false, discardedToolResults: [], outcomeWritten: false, billableSessionMs: 0,
};

type Recorded = { dtmf: string[]; captured: string[]; readbacks: [boolean, string | undefined][]; transfers: string[]; references: string[]; escalations: string[]; outcomes: Outcome[] };

function setup(over: { channel?: Channel; phase?: Phase; call?: Partial<Call> } = {}) {
  const recorded: Recorded = { dtmf: [], captured: [], readbacks: [], transfers: [], references: [], escalations: [], outcomes: [] };
  const events: ToolEvent[] = [];
  const state: ToolCallState = {
    channel: over.channel ?? 'HUMAN',
    phase: over.phase ?? 'EXCHANGE',
    call: { ...CALL, ...over.call },
    request: REQUEST,
  };
  const effects: ToolEffects = {
    sendDtmf: (digits) => recorded.dtmf.push(digits),
    captureAuthNumber: (value) => recorded.captured.push(value),
    confirmReadback: (matched, corrected) => recorded.readbacks.push([matched, corrected]),
    notifyTransfer: (destination) => recorded.transfers.push(destination),
    captureReference: (reference) => recorded.references.push(reference),
    escalate: (reason) => recorded.escalations.push(reason),
    recordOutcome: (outcome) => recorded.outcomes.push(outcome),
  };
  const handlers = createToolHandlers({ state: () => state, effects, emit: (e) => events.push(e) });
  return { handlers, recorded, events, state };
}

const call = (h: ReturnType<typeof setup>['handlers'], name: ToolName, args: unknown) => h.handle('SYN-CALL-1', `tc-${name}`, name, args);

describe('the code schemas are the §8.1 schemas', () => {
  test('every tool, field, enum, pattern and requirement matches the document', () => {
    const block = /```json\n([\s\S]*?)```/.exec(SSOT.slice(SSOT.indexOf('### 8.1 Schemas')))![1]!;
    const documented = JSON.parse(block) as ToolSchema[];
    assert.equal(TOOL_SCHEMAS.length, documented.length, 'the number of tools differs');

    for (const doc of documented) {
      const code = TOOL_SCHEMAS.find((s) => s.name === doc.name);
      assert.ok(code, `${doc.name} is in §8.1 and not in the code`);
      assert.equal(code.type, 'function', `${doc.name} needs the "type": "function" discriminator (§7.1)`);
      assert.deepEqual(
        Object.keys(code.parameters.properties).sort(),
        Object.keys(doc.parameters.properties).sort(),
        `${doc.name}: different properties`,
      );
      assert.deepEqual(code.parameters.required ?? [], doc.parameters.required ?? [], `${doc.name}: different required fields`);
      for (const [key, docProp] of Object.entries(doc.parameters.properties)) {
        const codeProp: PropertySchema = code.parameters.properties[key]!;
        for (const facet of ['type', 'pattern', 'minLength', 'minItems'] as const) {
          assert.deepEqual(codeProp[facet], docProp[facet], `${doc.name}.${key}: ${facet} differs`);
        }
        assert.deepEqual(codeProp.enum, docProp.enum, `${doc.name}.${key}: enum differs`);
        assert.deepEqual(codeProp.items?.enum, docProp.items?.enum, `${doc.name}.${key}: item enum differs`);
      }
    }
  });

  test('no tool carries request_id — one call is active at a time (§8.1)', () => {
    for (const schema of TOOL_SCHEMAS) {
      assert.ok(!('request_id' in schema.parameters.properties), `${schema.name} carries request_id`);
    }
  });

  test('record_outcome does not carry context_summary (§8.1)', () => {
    const schema = TOOL_SCHEMAS.find((s) => s.name === 'record_outcome')!;
    assert.ok(!('context_summary' in schema.parameters.properties));
  });
});

describe('authorization precedes execution (§8.7)', () => {
  test('a tool the position forbids is refused, and nothing runs', () => {
    const { handlers, recorded, events } = setup({ channel: 'HUMAN', phase: 'EXCHANGE' });
    const r = call(handlers, 'send_dtmf', { digits: '3', reason: 'prior authorization' });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.category, 'state_not_allowed');
    assert.match(r.ok === false ? r.reason : '', /not available right now \(HUMAN\/EXCHANGE\)/);
    assert.deepEqual(recorded.dtmf, []);
    assert.deepEqual(events.map((e) => e.t), ['tool.called', 'tool.rejected']);
  });

  test('a forbidden tool is refused BEFORE its arguments are read — the order §8.7 requires', () => {
    // Invalid arguments AND a forbidden position: the reason must be the
    // position. Otherwise a malformed argument could be why a forbidden tool
    // was noticed, and fixing the argument would let it through.
    const { handlers } = setup({ channel: 'HUMAN', phase: 'EXCHANGE' });
    const r = call(handlers, 'send_dtmf', { digits: 'not digits at all', reason: 42 });
    assert.equal(r.ok === false && r.category, 'state_not_allowed');
  });

  test('every position allows exactly what §5.6 allows, and refuses the rest', () => {
    const everyTool = TOOL_SCHEMAS.map((s) => s.name);
    for (const id of Object.keys(POSITION_POLICY)) {
      const [channel, phase] = id.split('/') as [Channel, Phase];
      const allowed = toolsAllowedAt(channel, phase);
      for (const name of everyTool) {
        const { handlers } = setup({ channel, phase });
        const r = call(handlers, name, {});
        const refusedForPosition = r.ok === false && r.category === 'state_not_allowed';
        assert.equal(refusedForPosition, !allowed.includes(name), `${id}: ${name}`);
      }
    }
  });

  test('the refusal names what IS available, so the model can recover', () => {
    const { handlers } = setup({ channel: 'HUMAN', phase: 'READBACK' });
    const r = call(handlers, 'capture_auth_number', { value: 'A472-91' });
    assert.match(r.ok === false ? r.reason : '', /Available: confirm_readback, capture_reference, notify_transfer, escalate_to_human\./);
  });
});

describe('argument validation against §8.1', () => {
  test('a missing required field is refused by name', () => {
    assert.equal(validateAgainstSchema('send_dtmf', { digits: '1' }), 'reason is required');
    assert.equal(validateAgainstSchema('capture_auth_number', {}), 'value is required');
  });

  test('patterns, lengths, enums and item enums are all enforced', () => {
    assert.match(validateAgainstSchema('send_dtmf', { digits: '12345', reason: 'x' })!, /does not match/);
    assert.match(validateAgainstSchema('capture_auth_number', { value: 'AB' })!, /at least 3 characters/);
    assert.match(validateAgainstSchema('record_outcome', { status: 'maybe' })!, /must be one of/);
    assert.match(validateAgainstSchema('get_auth_request', { fields: ['member_id', 'social_security'] })!, /not one of/);
    assert.match(validateAgainstSchema('get_auth_request', { fields: [] })!, /at least 1 item/);
    assert.match(validateAgainstSchema('confirm_readback', { matched: 'yes' })!, /must be true or false/);
  });

  test('valid arguments pass, and an unknown extra field is ignored rather than fatal', () => {
    assert.equal(validateAgainstSchema('send_dtmf', { digits: '3', reason: 'prior auth', confidence: 0.9 }), null);
    assert.equal(validateAgainstSchema('capture_reference', { reference: 'REF-4417-B', kind: 'call_reference' }), null);
  });

  test('confirm_readback(false) must carry the corrected value', () => {
    const { handlers, recorded } = setup({ phase: 'READBACK' });
    const r = call(handlers, 'confirm_readback', { matched: false });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : '', /corrected_value is required/);
    assert.deepEqual(recorded.readbacks, [], 'a rejected call must not write');
    assert.equal(call(handlers, 'confirm_readback', { matched: false, corrected_value: 'A473-91' }).ok, true);
    assert.deepEqual(recorded.readbacks, [[false, 'A473-91']]);
  });
});

describe('§8.5 status rules', () => {
  const closing = { channel: 'HUMAN' as Channel, phase: 'CLOSING' as Phase };

  test('approved: the number must equal the stored capture, byte for byte (§8.2)', () => {
    const { handlers, recorded } = setup({ ...closing, call: { capturedAuthNumber: 'A472-91' } });
    assert.match(
      (call(handlers, 'record_outcome', { status: 'approved', auth_number: 'a472-91' }) as { reason: string }).reason,
      /does not match the number captured/,
      'a case-insensitive comparison would be comparing the model with itself',
    );
    assert.match((call(handlers, 'record_outcome', { status: 'approved', auth_number: 'A472 91' }) as { reason: string }).reason, /does not match/);
    assert.deepEqual(recorded.outcomes, []);
    assert.equal(call(handlers, 'record_outcome', { status: 'approved', auth_number: 'A472-91' }).ok, true);
    assert.deepEqual(recorded.outcomes.map((o: Outcome) => o.status), ['approved']);
  });

  test('approved with nothing captured is refused, with the tool to call instead', () => {
    const { handlers } = setup(closing);
    const r = call(handlers, 'record_outcome', { status: 'approved', auth_number: 'A472-91' });
    assert.match(r.ok === false ? r.reason : '', /Call capture_auth_number/);
  });

  test('pending_info needs at least one item; call_failed needs nothing', () => {
    const { handlers } = setup(closing);
    assert.equal(call(handlers, 'record_outcome', { status: 'pending_info', missing_info: [] }).ok, false);
    assert.equal(call(handlers, 'record_outcome', { status: 'pending_info', missing_info: ['clinical notes'] }).ok, true);
    assert.equal(call(handlers, 'record_outcome', { status: 'call_failed' }).ok, true);
  });

  test('pending_info with a blank item is refused — the schema counts items, §8.5 reads them', () => {
    // minItems in §8.1 accepts [" "]: one item, and no information at all.
    const { handlers, recorded } = setup(closing);
    const r = call(handlers, 'record_outcome', { status: 'pending_info', missing_info: ['   '] });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : '', /at least one document or data item/);
    assert.deepEqual(recorded.outcomes, []);
  });

  test('escalated is refused when the log holds no summary (INV-9)', () => {
    const state = { channel: 'HUMAN' as Channel, phase: 'CLOSING' as Phase, call: CALL, request: REQUEST };
    assert.equal(validateOutcomeArgs({ status: 'escalated' }, state, { hasEscalationSummary: false }).ok, false);
    assert.equal(validateOutcomeArgs({ status: 'escalated' }, state, { hasEscalationSummary: true }).ok, true);
  });
});

describe('§8.5.1: a denial reason must say something', () => {
  test('every blocklist entry alone is refused, and the refusal asks for the specific detail', () => {
    for (const entry of DENIAL_BLOCKLIST) {
      const padded = `${entry}                                     `.slice(0, Math.max(30, entry.length));
      const problem = denialReasonProblem(padded);
      assert.ok(problem, `"${entry}" was accepted on its own`);
      assert.match(problem, /criterion|document|therapy|specific/i);
    }
  });

  test('the blocklist is currently subsumed by the specific-token rule — stated, not assumed', () => {
    // Every §8.5.1 blocklist entry fails rule 3 as well: none contains a number,
    // a code or a time unit. So rule 2 refuses nothing rule 3 would let through
    // TODAY. It is kept because it is the rule that would catch a future entry
    // that did contain one — "denied per policy 2024" would pass rule 3.
    for (const entry of DENIAL_BLOCKLIST) {
      assert.match(denialReasonProblem(`${entry} and nothing else at all here`)!, /no specific detail/, `"${entry}" was caught by something other than rule 3`);
    }
    // The case rule 2 exists for, constructed: specific token, still boilerplate.
    const withToken = 'denied per policy';
    assert.equal(denialReasonProblem(`${withToken} 2024 revision`), null, 'rule 3 alone accepts this — which is why rule 2 stays');
  });

  test('the same words inside a longer, specific reason are accepted', () => {
    assert.equal(denialReasonProblem('not medically necessary per criteria 4.2 — requires documented failure of methotrexate for 12 weeks'), null);
    assert.equal(denialReasonProblem('insufficient documentation: the operative report from 2026-04-11 was not received'), null);
  });

  test('length alone is not enough: a long reason with no specific token is refused', () => {
    assert.match(denialReasonProblem('the reviewing physician did not consider this service appropriate for the member')!, /no specific detail/);
  });

  test('each of the three token types satisfies the rule', () => {
    assert.equal(denialReasonProblem('denied because criterion 4.2 was not met by the submitted chart'), null, 'a number');
    assert.equal(denialReasonProblem('denied: procedure code J1234 requires prior step therapy documentation'), null, 'a code');
    assert.equal(denialReasonProblem('denied until conservative therapy has been tried for six weeks minimum'), null, 'a time unit');
  });

  test('under 25 characters is refused whatever it contains', () => {
    assert.ok(denialReasonProblem('criteria 4.2 unmet'));
  });
});

describe('§8.8: side effects persist when the result does not', () => {
  test('the write happens during handle, not when the result is delivered', () => {
    // §8.8 rule 3 discards the pending RESULT MESSAGES of an interrupted reply,
    // and explicitly does not undo writes. The severe case is a captured
    // authorization number lost to a barge-in.
    const { handlers, recorded, events } = setup();
    const r = call(handlers, 'capture_auth_number', { value: 'A472-91', spoken_form: 'A as in alpha, four seven two' });
    assert.equal(r.ok, true);
    assert.deepEqual(recorded.captured, ['A472-91'], 'the capture must already be written');
    // The result is returned to the CALLER, which queues it (packages/agent);
    // nothing here sends it, which is what lets §8.8 discard it.
    assert.deepEqual(events.map((e) => e.t), ['tool.called', 'tool.returned']);
  });

  test('a rejected call writes nothing and is logged as a rejection', () => {
    const { handlers, recorded, events } = setup();
    call(handlers, 'capture_auth_number', { value: 'A' });
    assert.deepEqual(recorded.captured, []);
    assert.deepEqual(events.map((e) => e.t), ['tool.called', 'tool.rejected']);
  });

  test('every call is logged before it runs, so a crash mid-execution still leaves a record', () => {
    const { handlers, events } = setup();
    call(handlers, 'capture_reference', { reference: 'REF-4417-B', kind: 'call_reference' });
    assert.equal(events[0]!.t, 'tool.called');
    assert.equal(events[1]!.t, 'tool.returned');
    assert.ok(events[1]!.t === 'tool.returned' && events[1]!.latencyMs >= 0);
  });

  test('record_outcome tells the model the call continues (ADR-015)', () => {
    const { handlers } = setup({ channel: 'HUMAN', phase: 'CLOSING' });
    const r = call(handlers, 'record_outcome', { status: 'call_failed' });
    assert.deepEqual(r.ok === true ? r.result : null, { ok: true, recorded: 'call_failed', call_continues: true });
  });
});

describe('what the tools return', () => {
  test('get_auth_request returns exactly the fields asked for (§8.5 minimum necessary)', () => {
    const { handlers } = setup();
    const r = call(handlers, 'get_auth_request', { fields: ['member_id', 'patient_dob'] });
    assert.deepEqual(r.ok === true ? r.result : null, { ok: true, fields: { member_id: 'SYN-M-44821', patient_dob: '1970-03-14' } });
  });

  test('clinical_summary comes back verbatim, never trimmed or summarized (ADR-016)', () => {
    const { handlers } = setup();
    const r = call(handlers, 'get_auth_request', { fields: ['clinical_summary'] }) as { result: { fields: Record<string, string> } };
    assert.equal(r.result.fields['clinical_summary'], REQUEST.clinicalSummary);
  });

  test('send_dtmf runs where the policy allows it', () => {
    const { handlers, recorded } = setup({ channel: 'IVR', phase: 'NOT_STARTED' });
    assert.equal(call(handlers, 'send_dtmf', { digits: '3', reason: 'prior authorization' }).ok, true);
    assert.deepEqual(recorded.dtmf, ['3']);
  });

  test('notify_transfer and escalate_to_human carry their audit fields through', () => {
    const { handlers, recorded } = setup();
    assert.equal(call(handlers, 'notify_transfer', { destination: 'utilization management', quote: "I'm going to transfer you" }).ok, true);
    assert.deepEqual(recorded.transfers, ['utilization management']);
    const summary = 'Routine. Gave member ID and DOB. Representative asked whether first-line therapy failed. Clinical staff need to call back on 555-0142.';
    assert.equal(call(handlers, 'escalate_to_human', { reason: 'clinical question beyond the approved summary', context_summary: summary }).ok, true);
    assert.deepEqual(recorded.escalations, ['clinical question beyond the approved summary']);
  });

  test('escalate_to_human refuses a summary too short to be useful (§8.1 minLength 40)', () => {
    const { handlers } = setup();
    const r = call(handlers, 'escalate_to_human', { reason: 'clinical', context_summary: 'Routine. Ask clinical.' });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : '', /at least 40 characters/);
  });
});
