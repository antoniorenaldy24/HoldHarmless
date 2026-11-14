/**
 * Live Outbound Call Runner — Week 4 Integration (§21 Module 4.0 & 4.5).
 *
 * Runs an end-to-end outbound prior authorization call:
 *   1. Starts the simulated switchboard (HarnessServer) with the configured IVR menu and representative personas.
 *   2. Starts the dashboard API server (SSE + REST) so the web dashboard visualizes the call live.
 *   3. Connects the telemetry control channel to pipe harness ground truth directly into the EventLog.
 *   4. Initializes the AssemblyAI voice agent session over G.711 μ-law 8 kHz.
 *   5. Connects via LoopbackTransport under telephony profile delay & jitter.
 *   6. Executes the call loop: IVR navigation, hold music survival, human representative negotiation,
 *      tool calls (NPI, Member ID, DOB, CPT, ICD), spelled auth number capture, read-back confirmation,
 *      and outcome recording before hangup.
 *   7. Persists the full call event stream to logs/<callId>.jsonl.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { PROFILES, raiseTimerResolution } from '@holdharmless/transport';
import { LoopbackTransport } from '@holdharmless/transport-loopback';
import {
  HarnessServer,
  fileAssets,
  connectControl,
  type HarnessNavMode,
  type RepMode,
} from '@holdharmless/ivr-harness';
import { AgentSession, type InitialConfig } from '@holdharmless/agent';
import type { AuthRequest, NavMode } from '@holdharmless/events';
import {
  createEventLog,
  createWorkQueue,
  startCall,
  startDashboardServer,
  positionConfig,
  type PositionInputs,
} from '@holdharmless/core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* environment variables already loaded */
}

const API_KEY = process.env['ASSEMBLYAI_API_KEY']?.trim();
if (!API_KEY) {
  console.error('\n[FATAL] ASSEMBLYAI_API_KEY is not set in .env.');
  console.error('Please configure your AssemblyAI API key in .env before running a live call.\n');
  process.exit(1);
}

const navMode: NavMode = process.env['IVR_NAV_MODE'] === 'speech' ? 'speech' : 'dtmf';
const profileName = (process.env['NETWORK_PROFILE'] ?? 'TELEPHONY') as keyof typeof PROFILES;
const repMode = (process.env['REP_MODE'] ?? 'BOT_REP') as RepMode;
const scenario = process.env['IVR_SCENARIO'] ?? 'approval';
const voice = (process.env['ASSEMBLYAI_VOICE'] ?? 'michael').toLowerCase();
const wsUrl = process.env['ASSEMBLYAI_WS_URL'] ?? 'wss://agents.assemblyai.com/v1/ws';
const harnessPort = Number(process.env['HARNESS_PORT'] ?? 8081);
const dashboardPort = Number(process.env['CORE_PORT'] ?? 3001);
const holdDurationMs = Number(process.env['HOLD_DURATION_MS'] ?? 8000);

// Ensure logs directory exists
const logsDir = path.join(ROOT, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

class LiveSpeakerMonitor {
  private player: ChildProcess | null = null;
  private closed = false;

  constructor(enabled: boolean) {
    if (!enabled) return;
    try {
      this.player = spawn(
        'ffplay',
        [
          '-nodisp',
          '-autoexit',
          '-loglevel',
          'quiet',
          '-f',
          'mulaw',
          '-ar',
          '8000',
          '-ch_layout',
          'mono',
          '-probesize',
          '32',
          '-analyzeduration',
          '0',
          '-',
        ],
        { stdio: ['pipe', 'ignore', 'ignore'] }
      );
      this.player.on('error', () => {
        this.player = null;
      });
    } catch {
      this.player = null;
    }
  }

  get isEnabled(): boolean {
    return this.player !== null && !this.closed;
  }

  playFrame(frame: Uint8Array): void {
    if (!this.player || this.closed) return;
    try {
      this.player.stdin?.write(frame);
    } catch {}
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.player) {
      try {
        this.player.stdin?.end();
        this.player.kill();
      } catch {}
      this.player = null;
    }
  }
}

const speakerEnabled = process.env['AUDIO_SPEAKER'] !== 'false';
const speaker = new LiveSpeakerMonitor(speakerEnabled);

// Raise system timer resolution for accurate 20ms frame pacing (§4.5)
const timer = raiseTimerResolution();

console.log('='.repeat(70));
console.log('  HoldHarmless — Autonomous Outbound Voice Agent');
console.log('='.repeat(70));
console.log(`  Profile:         ${profileName}`);
console.log(`  Navigation Mode: ${navMode}`);
console.log(`  Rep Mode:        ${repMode}`);
console.log(`  Scenario:        ${scenario}`);
console.log(`  AssemblyAI Voice:${voice}`);
console.log(`  Audio Speaker:   ${speaker.isEnabled ? 'ENABLED (real-time output to speakers)' : 'DISABLED'}`);
console.log(`  Timer Precision: ${timer.detail}`);
console.log('='.repeat(70));

const callId = `CALL-LIVE-${Date.now()}`;
const logFile = path.join(logsDir, `${callId}.jsonl`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

const log = createEventLog({
  callId,
  onSubscriberError: (err) => console.error('[log] reader error:', err),
});

// Stream event log to disk synchronously
log.subscribe((event) => {
  logStream.write(JSON.stringify(event) + '\n');
});

// Terminal logger for live observability
log.subscribe((e) => {
  const ts = new Date(e.at).toLocaleTimeString();
  if (e.t === 'channel.changed') {
    console.log(`[${ts}] [CHANNEL] ${e.from} -> ${e.to} (by ${e.producer.kind})`);
  } else if (e.t === 'gate.changed') {
    console.log(`[${ts}] [GATE]    ${e.from} -> ${e.to} (channel: ${e.channel}, suspected: ${e.holdSuspected})`);
  } else if (e.t === 'phase.changed') {
    console.log(`[${ts}] [PHASE]   ${e.from} -> ${e.to}`);
  } else if (e.t === 'dtmf.sent') {
    console.log(`[${ts}] [DTMF]    Sent digit: ${e.digits} (${e.reason})`);
  } else if (e.t === 'turn.transcribed') {
    const speaker = e.speaker === 'agent' ? 'AGENT' : 'FAR-END';
    console.log(`[${ts}] [${speaker}] ${e.text}`);
  } else if (e.t === 'tool.called') {
    console.log(`[${ts}] [TOOL]    Called: ${e.name} args: ${JSON.stringify(e.args)}`);
  } else if (e.t === 'tool.returned') {
    console.log(`[${ts}] [TOOL]    Returned: ${e.name} in ${e.latencyMs}ms result: ${JSON.stringify(e.result)}`);
  } else if (e.t === 'disclosure.delivered') {
    console.log(`[${ts}] [ETHICS]  AI Identity Disclosed to Party ${e.partyIndex}: "${e.quote}"`);
  } else if (e.t === 'call.ended') {
    console.log(`[${ts}] [OUTCOME] Call Ended: ${e.outcome.status} (auth: ${e.outcome.authNumber ?? 'none'})`);
  } else if (e.t === 'call.dropped') {
    console.log(`[${ts}] [DROPPED] Call Dropped: ${e.cause}`);
  }
});

// Synthetic patient & clinic prior authorization request (INV-12)
const request: AuthRequest = {
  id: 'SYN-REQ-14',
  patientRef: 'SYN-PT-14',
  memberId: 'SYN-M-44821',
  patientDob: '1970-03-14',
  cptCode: '96413',
  icdCode: 'C50.911',
  providerNpi: '1234567890',
  serviceDate: '2026-10-02',
  payerId: 'SYN-PAYER-1',
  payerEndpoint: `ws://127.0.0.1:${harnessPort}/call?callId=${encodeURIComponent(callId)}`,
  clinicName: 'Riverside Oncology',
  clinicCallbackPhone: '555-0142',
  priority: 'expedited',
  clinicalSummary: 'Synthetic prior authorization request for chemo administration.',
  status: 'queued',
  attempts: 0,
};

const queue = createWorkQueue({
  requests: [request],
  emit: (body) => log.append(body),
});

// 1. Start Simulated Switchboard (Harness)
console.log('\n[1/5] Starting simulated payer switchboard...');
const harness = await HarnessServer.start({
  port: harnessPort,
  profile: PROFILES[profileName],
  assets: fileAssets(),
  navMode,
  queueHoldMs: holdDurationMs,
  repMode,
  scenario,
});
console.log(`      Payer audio link:   ${harness.callUrl(callId)}`);
console.log(`      Telemetry link:     ${harness.controlUrl()}`);

// 2. Connect Control Channel to EventLog
console.log('[2/5] Connecting telemetry control link...');
const controlWs = await connectControl(harness.controlUrl(), (msg) => {
  log.append({
    t: 'harness.telemetry',
    metric: msg.metric,
    value: msg.value,
    ...(msg.detail !== undefined ? { detail: msg.detail } : {}),
  });
});

// 3. Start Dashboard Server (SSE + REST)
console.log('[3/5] Starting live dashboard API server...');
const dashboardServer = await startDashboardServer({
  log,
  queue,
  requests: () => [request],
  demoMode: false,
  port: dashboardPort,
});
console.log(`      Dashboard API:      http://127.0.0.1:${dashboardServer.port}`);
console.log(`      Web UI Dashboard:   http://localhost:5173 (run 'pnpm --filter dashboard dev')`);

// 4. Initialize Core Call Loop & Media Path
console.log('[4/5] Initializing call loop and audio bridge...');
const transport = new LoopbackTransport();

// Stream far-end audio and admitted agent audio to PC speakers
transport.onAudio((frame) => {
  speaker.playFrame(frame);
});
const origSendAudio = transport.sendAudio.bind(transport);
transport.sendAudio = (frame, source) => {
  const admitted = origSendAudio(frame, source);
  if (admitted) {
    speaker.playFrame(frame);
  }
  return admitted;
};

let sessionInstance: AgentSession | null = null;
const call = startCall({
  request,
  queue,
  log,
  transport,
  navMode,
  networkProfile: profileName,
  createSession: (guard, isClosing) => {
    sessionInstance = new AgentSession({
      url: wsUrl,
      apiKey: API_KEY,
      socket: (url, headers) => new WebSocket(url, { headers }),
      guard,
      isClosing,
      enableInterruptionDelay: process.env['ENABLE_INTERRUPTION_DELAY'] !== 'false',
    });
    return sessionInstance;
  },
});

// 5. Connect AssemblyAI WebSocket Session
console.log('[5/5] Connecting to AssemblyAI Voice Agent API...');
const initialInputs: PositionInputs = {
  call: call.loop.snapshot(),
  request,
  navMode,
  disclosure: call.loop.disclosure,
  holdSegmentMs: 0,
};
const pos = positionConfig(initialInputs);

const initialConfig: InitialConfig = {
  systemPrompt: pos.config.systemPrompt ?? 'You are an AI voice assistant for Riverside Oncology.',
  tools: pos.config.tools ?? [],
  transcriptionMode: pos.config.transcriptionMode ?? 'balanced',
  keyterms: pos.config.keyterms ?? [],
  interruptResponse: false,
  interruptionDelayMs: 700,
  voice,
  inputFormat: 'audio/pcmu',
  outputFormat: 'audio/pcmu',
};

await sessionInstance!.connect(initialConfig);
console.log(`      AssemblyAI Session connected (ID: ${sessionInstance!.sessionId()})`);

// Dial the harness switchboard
console.log(`\n>>> Dialing payer switchboard at ${request.payerEndpoint}...\n`);
const dialed = await call.loop.dial(request.payerEndpoint, PROFILES[profileName]);
if (!dialed) {
  console.error('\n[ERROR] Transport connection refused by switchboard.');
  process.exit(1);
}

// Wait for call completion
const result = await call.finished;

console.log('\n' + '='.repeat(70));
console.log('  Call Completed');
console.log('='.repeat(70));
if (result.outcome) {
  console.log(`  Final Status:       ${result.outcome.status.toUpperCase()}`);
  if (result.outcome.authNumber) {
    console.log(`  Auth Number:        ${result.outcome.authNumber}`);
  }
  if (result.outcome.reference) {
    console.log(`  Reference Number:   ${result.outcome.reference}`);
  }
}
if (result.dropped) {
  console.log(`  Dropped Cause:      ${result.dropped}`);
}
console.log(`  Full Event Log:     ${logFile}`);
console.log('='.repeat(70));

// Flush stream and cleanup
speaker.close();
logStream.end();
controlWs.close();
await harness.close();

// Keep dashboard open for 5 seconds to let UI readers finish, then exit
console.log('\nAllowing dashboard readers to synchronize...');
await new Promise((r) => setTimeout(r, 3000));
await dashboardServer.close();
console.log('Done.\n');
process.exit(0);
