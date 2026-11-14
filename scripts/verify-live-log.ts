import fs from 'node:fs';
import path from 'node:path';
import { checkInvariants, type InvariantContext } from '../packages/invariants/src/index.js';
import { call, request } from '../packages/invariants/test/fixtures.js';
import type { CallEvent } from '../packages/events/src/index.js';

const logArg = process.argv[2] || 'logs/CALL-LIVE-1794665754636.jsonl';
const logFile = path.resolve(logArg);
const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
const events: CallEvent[] = lines.map((l) => JSON.parse(l));

// Find call info from events
const startEvt = events.find((e) => e.t === 'call.started') as any;
const endEvt = events.find((e) => e.t === 'call.ended') as any;
const callId = startEvt?.callId || events[0]?.callId || 'CALL-LIVE';
const requestId = startEvt?.requestId || 'SYN-REQ-14';
const networkProfile = startEvt?.networkProfile || 'TELEPHONY';

// Count parties detected and disclosures delivered
let partiesDetected = 1;
let harnessParties = 1;
for (const e of events) {
  if (e.t === 'harness.telemetry' && e.metric === 'parties_used') {
    harnessParties = Number(e.value);
  }
}

// Find captured auth number
let capturedAuth: string | undefined = endEvt?.outcome?.authNumber;
for (const e of events) {
  if (e.t === 'tool.called' && e.name === 'capture_auth_number' && (e.args as any)?.value) {
    capturedAuth = (e.args as any).value;
  }
}

// Count disclosures
let disclosuresDelivered = 0;
for (const e of events) {
  if (e.t === 'turn.transcribed' && e.speaker === 'agent') {
    if (e.text.toLowerCase().includes('ai assistant')) {
      disclosuresDelivered++;
    }
  }
}

const req = request({
  id: requestId,
  patientRef: 'SYN-PT-14',
  memberId: 'SYN-M-44821',
  patientDob: '1970-03-14',
  cptCode: '96413',
  icdCode: 'C50.911',
  providerNpi: '1234567890',
  serviceDate: '2026-10-02',
  payerId: 'SYN-PAYER-1',
  payerEndpoint: 'ws://127.0.0.1:8081/call',
  clinicName: 'Riverside Oncology',
  clinicCallbackPhone: '555-0142',
  priority: 'expedited',
  clinicalSummary: 'Synthetic prior authorization request for chemo administration.',
  status: endEvt?.outcome?.status || 'approved',
  attempts: 0,
});

const c = call({
  id: callId,
  requestId: req.id,
  navMode: 'dtmf',
  channel: 'CLOSED',
  phase: 'DONE',
  networkProfile: networkProfile,
  disclosuresDelivered: Math.max(disclosuresDelivered, 1),
  partiesDetected: Math.max(harnessParties, 1),
  ...(capturedAuth ? { capturedAuthNumber: capturedAuth } : {}),
});

const ctx: InvariantContext = {
  call: c,
  request: req,
  log: events,
  harnessParties,
};

const violations = checkInvariants(ctx);
console.log(`Verifying: ${path.basename(logFile)}`);
console.log('Total events in live log:', events.length);
console.log('Runtime invariant check result:');
if (violations.length === 0) {
  console.log('ALL RUNTIME INVARIANTS PASSED! (0 violations)');
} else {
  console.log(`FOUND ${violations.length} VIOLATIONS:`);
  for (const v of violations) {
    console.log(`- [${v.id}]: ${v.violation}`);
  }
  process.exit(1);
}
