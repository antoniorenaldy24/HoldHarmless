/**
 * `pnpm --filter core dev` — §14. The API the dashboard reads, on port 3001.
 *
 * There is no live call yet (the orchestrator is week 4), so this starts the
 * log, the Work Queue and the dashboard API, and plays the §19.3 stored call
 * into the log so every panel has something real to derive from. The dashboard
 * shows that the source is a replay; a screen that presents invented data as a
 * live call is worse than a screen showing nothing.
 */

import { createEventLog } from './log.js';
import { createWorkQueue } from './work-queue.js';
import { startDashboardServer, type DemoControl } from './server.js';
import { playDemoCall, type DemoPlayer } from './demo-call.js';
import type { AuthRequest } from '@holdharmless/events';

const PORT = Number(process.env['CORE_PORT'] ?? 3001);
const DEMO_MODE = (process.env['DEMO_MODE'] ?? 'true') !== 'false';
const SPEED = Number(process.env['DEMO_SPEED'] ?? 8);

/** Synthetic, as INV-12 requires of every AuthRequest anywhere in this repo. */
const REQUESTS: AuthRequest[] = [
  {
    id: 'SYN-REQ-14', patientRef: 'SYN-PT-14', memberId: 'SYN-M-44821', patientDob: '1970-03-14',
    cptCode: '96413', icdCode: 'C50.911', providerNpi: '1234567890', serviceDate: '2026-10-02',
    payerId: 'SYN-PAYER-1', payerEndpoint: 'ws://127.0.0.1:8081/call', clinicName: 'Riverside Oncology',
    clinicCallbackPhone: '555-0142', priority: 'expedited', clinicalSummary: 'Synthetic summary; no real patient exists.',
    status: 'queued', attempts: 0,
  },
  {
    id: 'SYN-REQ-09', patientRef: 'SYN-PT-09', memberId: 'SYN-M-11907', patientDob: '1964-08-02',
    cptCode: '77427', icdCode: 'C34.90', providerNpi: '1234567890', serviceDate: '2026-10-05',
    payerId: 'SYN-PAYER-1', payerEndpoint: 'ws://127.0.0.1:8081/call', clinicName: 'Riverside Oncology',
    clinicCallbackPhone: '555-0142', priority: 'routine', clinicalSummary: 'Synthetic summary; no real patient exists.',
    status: 'escalated', attempts: 2, lastReference: 'REF-99',
  },
  {
    id: 'SYN-REQ-02', patientRef: 'SYN-PT-02', memberId: 'SYN-M-70334', patientDob: '1981-12-19',
    cptCode: '96360', icdCode: 'K50.00', providerNpi: '1234567890', serviceDate: '2026-09-28',
    payerId: 'SYN-PAYER-1', payerEndpoint: 'ws://127.0.0.1:8081/call', clinicName: 'Riverside Oncology',
    clinicCallbackPhone: '555-0142', priority: 'routine', clinicalSummary: 'Synthetic summary; no real patient exists.',
    status: 'approved', attempts: 1,
  },
];

const log = createEventLog({ callId: 'CALL-DEMO-1', onSubscriberError: (e) => console.error('dashboard reader threw:', e) });
const queue = createWorkQueue({ requests: REQUESTS, emit: (body) => log.append(body) });

let player: DemoPlayer | null = null;
const control = (which: DemoControl): void => {
  player?.stop();
  player = which === 'replay' ? playDemoCall({ log, speed: SPEED }) : null;
};

const server = await startDashboardServer({
  log,
  queue,
  requests: () => REQUESTS,
  demoMode: DEMO_MODE,
  onDemoControl: control,
  port: PORT,
});

control('replay');

console.log(`core: dashboard API on http://127.0.0.1:${server.port} (demo mode ${DEMO_MODE ? 'on' : 'off'}, replay at ${SPEED}x)`);
console.log('      the dashboard proxies /api to this port; run: pnpm --filter dashboard dev');

const shutdown = async (): Promise<void> => {
  player?.stop();
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
