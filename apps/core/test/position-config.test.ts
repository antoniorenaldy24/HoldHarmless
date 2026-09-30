/**
 * Per-position configuration — module 4.0, reply half, step 3.
 *
 * `promptFor` and `POSITION_POLICY` were built and tested in week 1; until this
 * step nothing sent either to a session, so the agent would have gone through
 * every call on whatever it was connected with.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createDisclosureTracker, PARTY_CONTINUITY_MS, type DisclosureTracker } from '@holdharmless/callmodel';
import type { SessionConfig } from '@holdharmless/agent';
import type { AuthRequest, Call, Channel, Phase } from '@holdharmless/events';
import { createEventLog } from '../src/index.js';
import { createConfigurator, positionConfig, type PositionInputs } from '../src/position-config.js';

const request: AuthRequest = {
  id: 'R1', patientRef: 'p', memberId: 'M-99', patientDob: '1970-01-01',
  cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-01',
  payerId: 'payer', payerEndpoint: 'ws://x', clinicName: 'Riverside Oncology', clinicCallbackPhone: '555',
  priority: 'routine', clinicalSummary: 's', status: 'in_progress', attempts: 0,
};

const call = (channel: Channel, phase: Phase, over: Partial<Call> = {}): Call => ({
  id: 'C1', requestId: 'R1', transport: 'loopback', navMode: 'dtmf', networkProfile: 'TELEPHONY',
  startedAt: '2026-09-30T00:00:00.000Z', channel, phase, holdSuspected: false, holdDurationMs: 0,
  cumulativeHoldMs: 0, humanChannelMs: 0, disclosedToCurrentParty: false, partiesDetected: 1,
  disclosuresDelivered: 0, readbackAttempts: 0, rePromptCounts: {}, holdRampSteps: 0,
  pendingContextCorrection: false, discardedToolResults: [], outcomeWritten: false, billableSessionMs: 0,
  ...over,
});

const inputs = (c: Call, over: { disclosure?: DisclosureTracker; holdSegmentMs?: number } = {}): PositionInputs => ({
  call: c, request, navMode: c.navMode, disclosure: over.disclosure ?? createDisclosureTracker(), holdSegmentMs: over.holdSegmentMs ?? 0,
});

const toolNames = (cfg: Partial<SessionConfig>) => (cfg.tools ?? []).map((t) => t.name);

describe('what each position is told (§5.6, §7.3)', () => {
  test('IVR in DTMF: the menu prompt, send_dtmf only, no interruption, fastest transcription', () => {
    const { bundle, config } = positionConfig(inputs(call('IVR', 'NOT_STARTED')));
    assert.deepEqual(bundle?.files, ['IVR_DTMF.txt']);
    assert.deepEqual(toolNames(config), ['send_dtmf']);
    assert.equal(config.interruptResponse, false);
    assert.equal(config.transcriptionMode, 'min_latency');
    assert.equal(config.systemPrompt, bundle?.text);
  });

  test('HUMAN/EXCHANGE, not yet told: the exchange prompt WITH the disclosure, and its tools', () => {
    const { bundle, config } = positionConfig(inputs(call('HUMAN', 'EXCHANGE')));
    assert.deepEqual(bundle?.files, ['EXCHANGE.txt', 'DISCLOSURE.txt']);
    assert.ok(config.systemPrompt?.includes('Riverside Oncology'), 'placeholders rendered, not passed through');
    assert.deepEqual(toolNames(config), ['get_auth_request', 'capture_auth_number', 'capture_reference', 'notify_transfer', 'escalate_to_human']);
    assert.equal(config.interruptResponse, true);
    assert.equal(config.interruptionDelayMs, 700, 'ADR-011, where a mis-detection is most expensive');
  });

  test('once the agent has actually disclosed, the disclosure drops out (observation, not provenance)', () => {
    const d = createDisclosureTracker();
    d.onAgentTurn("Hi, I'm an AI assistant calling on behalf of Riverside Oncology.");
    const { bundle } = positionConfig(inputs(call('HUMAN', 'EXCHANGE'), { disclosure: d }));
    assert.deepEqual(bundle?.files, ['EXCHANGE.txt']);
  });

  test('HOLD: the hold prompt, no tools at all', () => {
    const { bundle, config } = positionConfig(inputs(call('HOLD', 'EXCHANGE')));
    assert.deepEqual(bundle?.files, ['HOLD.txt']);
    assert.deepEqual(toolNames(config), []);
    assert.equal(config.interruptResponse, false);
  });

  test('READBACK carries the captured number into the prompt', () => {
    const { config } = positionConfig(inputs(call('HUMAN', 'READBACK', { capturedAuthNumber: 'A472-91', disclosedToCurrentParty: true })));
    assert.ok(config.systemPrompt?.includes('A472-91'));
    assert.equal(config.interruptionDelayMs, 800);
  });

  test('where no prompt applies, the tools are still withdrawn', () => {
    for (const [ch, ph] of [['DIALING', 'NOT_STARTED'], ['HUMAN', 'DONE'], ['CLOSED', 'DONE']] as const) {
      const { bundle, config } = positionConfig(inputs(call(ch, ph)));
      assert.equal(bundle, null, `${ch}/${ph}`);
      assert.equal('systemPrompt' in config, false, 'nothing to say, so the prompt is not replaced');
      assert.deepEqual(toolNames(config), [], `${ch}/${ph}: a finished call must not keep its tools`);
    }
  });
});

describe('the return from hold (ADR-017, §7.3)', () => {
  test('a short hold: continuity assured, no hedge', () => {
    const d = createDisclosureTracker();
    d.onAgentTurn("I'm an AI assistant calling on behalf of Riverside Oncology.");
    const { bundle } = positionConfig(inputs(call('HUMAN', 'EXCHANGE'), { disclosure: d, holdSegmentMs: PARTY_CONTINUITY_MS - 1 }), 'HOLD');
    assert.equal(bundle?.hedged, false);
  });

  test('a longer one: the party hedge, and never the disclosure beside it', () => {
    const d = createDisclosureTracker();
    d.onAgentTurn("I'm an AI assistant calling on behalf of Riverside Oncology.");
    const { bundle } = positionConfig(inputs(call('HUMAN', 'EXCHANGE'), { disclosure: d, holdSegmentMs: PARTY_CONTINUITY_MS }), 'HOLD');
    assert.equal(bundle?.hedged, true);
    assert.deepEqual(bundle?.files, ['PARTY_HEDGE.txt', 'EXCHANGE.txt']);
  });

  test('channelCameFrom is used for the transition only — the next update has none', () => {
    const d = createDisclosureTracker();
    const { bundle } = positionConfig(inputs(call('HUMAN', 'EXCHANGE'), { disclosure: d, holdSegmentMs: 60_000 }));
    assert.equal(bundle?.hedged, false);
  });
});

// ---------------------------------------------------------------------------

function fakeSession() {
  const updates: Partial<SessionConfig>[] = [];
  const gates: { resolve: () => void; reject: (e: Error) => void }[] = [];
  let auto = true;
  return {
    updates,
    session: {
      update(cfg: Partial<SessionConfig>) {
        updates.push(cfg);
        if (auto) return Promise.resolve();
        return new Promise<void>((resolve, reject) => gates.push({ resolve, reject }));
      },
    },
    hold() { auto = false; },
    release() { auto = true; for (const g of gates.splice(0)) g.resolve(); },
    fail(msg: string) { for (const g of gates.splice(0)) g.reject(new Error(msg)); },
  };
}

function configRig() {
  const s = fakeSession();
  const log = createEventLog({ callId: 'CFG' });
  let state = call('DIALING', 'NOT_STARTED');
  let segment = 0;
  const faults: unknown[] = [];
  const cfg = createConfigurator({
    session: s.session, log, onFault: (e) => faults.push(e),
    read: () => inputs(state, { holdSegmentMs: segment }),
  });
  return {
    s, log, cfg, faults,
    set(c: Call) { state = c; },
    segment(ms: number) { segment = ms; },
    loaded: () => log.events().filter((e) => e.t === 'prompt.loaded'),
  };
}

describe('the configurator: one update per SETTLED position', () => {
  test('a channel change and its phase follow-up in one task produce ONE update — and never read HUMAN/NOT_STARTED', async () => {
    const r = configRig();
    // Exactly what the call loop does in one handler: channel first, then phase.
    r.set(call('HUMAN', 'NOT_STARTED'));
    r.cfg.request('IVR'); // configuring HERE would throw in positionalPromptName
    r.set(call('HUMAN', 'EXCHANGE'));
    r.cfg.request();
    await r.cfg.idle();
    assert.equal(r.s.updates.length, 1);
    assert.deepEqual(r.faults, []);
    assert.ok(r.s.updates[0]!.systemPrompt?.length);
  });

  test('two transitions in one task: the one INTO the settled channel is the one processed', async () => {
    // HUMAN → HOLD → HUMAN before the task ends — a hold confirmed and a person
    // answering on the same tick. The call settles in HUMAN having come from
    // HOLD, after a hold long enough for someone else to have picked up.
    const r = configRig();
    r.segment(60_000);
    r.set(call('HUMAN', 'EXCHANGE'));
    r.cfg.request('HUMAN'); // HUMAN → HOLD
    r.cfg.request('HOLD'); // HOLD → HUMAN
    await r.cfg.idle();
    const e = r.loaded().at(-1)!;
    assert.ok(e.t === 'prompt.loaded' && e.hedged, 'the party hedge: a different person may be there');
  });

  test('only what changed is sent', async () => {
    const r = configRig();
    r.set(call('IVR', 'NOT_STARTED'));
    r.cfg.request('DIALING');
    await r.cfg.idle();
    r.set(call('HOLD', 'NOT_STARTED'));
    r.cfg.request('IVR');
    await r.cfg.idle();
    const second = r.s.updates[1]!;
    assert.ok('systemPrompt' in second && 'tools' in second);
    assert.equal('interruptResponse' in second, false, 'false in IVR and false in HOLD: not resent');
  });

  test('nothing changed, nothing sent', async () => {
    const r = configRig();
    r.set(call('IVR', 'NOT_STARTED'));
    r.cfg.request();
    await r.cfg.idle();
    r.cfg.request();
    await r.cfg.idle();
    assert.equal(r.s.updates.length, 1);
  });

  test('serial, and the latest position wins over one the call has already left', async () => {
    const r = configRig();
    r.s.hold();
    r.set(call('IVR', 'NOT_STARTED'));
    r.cfg.request();
    await new Promise((res) => setImmediate(res));
    assert.equal(r.s.updates.length, 1, 'in flight');
    r.set(call('HOLD', 'NOT_STARTED'));
    r.cfg.request('IVR');
    r.set(call('HUMAN', 'EXCHANGE'));
    r.cfg.request('HOLD');
    assert.equal(r.s.updates.length, 1, 'never two in flight');
    r.s.release();
    await r.cfg.idle();
    assert.equal(r.s.updates.length, 2, 'HOLD was never sent: the call had already left it');
    assert.ok(r.s.updates[1]!.tools?.some((t) => t.name === 'capture_auth_number'), 'the second update is HUMAN/EXCHANGE');
  });

  test('prompt.loaded is written once the session accepted the prompt, not before', async () => {
    const r = configRig();
    r.s.hold();
    r.set(call('IVR', 'NOT_STARTED'));
    r.cfg.request();
    await new Promise((res) => setImmediate(res));
    assert.equal(r.loaded().length, 0);
    r.s.release();
    await r.cfg.idle();
    const e = r.loaded();
    assert.equal(e.length, 1);
    assert.ok(e[0]!.t === 'prompt.loaded' && e[0]!.files[0] === 'IVR_DTMF.txt');
  });

  test('a rejected update is surfaced, not recorded as sent, and retried by the next request', async () => {
    const r = configRig();
    r.s.hold();
    r.set(call('IVR', 'NOT_STARTED'));
    r.cfg.request();
    await new Promise((res) => setImmediate(res));
    r.s.fail('invalid_value');
    await r.cfg.idle();
    assert.equal(r.faults.length, 1);
    assert.equal(r.loaded().length, 0, 'nothing was loaded');
    r.s.release();
    r.cfg.request();
    await r.cfg.idle();
    assert.equal(r.s.updates.length, 2);
    assert.ok(r.s.updates[1]!.systemPrompt, 'the whole configuration again, not a diff against what failed');
  });

  test('stop() ends it', async () => {
    const r = configRig();
    r.cfg.stop();
    r.set(call('IVR', 'NOT_STARTED'));
    r.cfg.request();
    await r.cfg.idle();
    assert.equal(r.s.updates.length, 0);
  });

  test('…including a request already scheduled when stop() arrived', async () => {
    const r = configRig();
    r.set(call('IVR', 'NOT_STARTED'));
    r.cfg.request();
    r.cfg.stop(); // same task: the update is queued, not yet run
    await r.cfg.idle();
    assert.equal(r.s.updates.length, 0);
  });
});
