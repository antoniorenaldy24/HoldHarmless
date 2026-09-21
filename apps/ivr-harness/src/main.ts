/**
 * `pnpm --filter ivr-harness start` — the harness as its own process (§10.1).
 *
 * HARNESS_WS_URL, HARNESS_CONTROL_URL, NETWORK_PROFILE (default TELEPHONY) and
 * IVR_NAV_MODE (default dtmf) come from the environment (§13).
 */

import { PROFILES, raiseTimerResolution } from '@holdharmless/transport';
import type { NetworkProfileName } from '@holdharmless/events';
import { fileAssets } from './assets.js';
import { HarnessServer, type HarnessNavMode } from './harness.js';

// §4.5 pre-flight: without this the 20 ms pacing runs on a 15.6 ms quantum on
// Windows, and no latency figure from the run may be reported.
const timer = raiseTimerResolution();
console.log(`timer resolution: ${timer.detail}`);

const profileName = (process.env['NETWORK_PROFILE'] ?? 'TELEPHONY') as NetworkProfileName;
const profile = PROFILES[profileName];
if (!profile) throw new Error(`NETWORK_PROFILE "${profileName}" is not one of ${Object.keys(PROFILES).join(', ')}`);

const navMode = (process.env['IVR_NAV_MODE'] ?? 'dtmf') as HarnessNavMode;
// The port comes from HARNESS_WS_URL (§13) — the URL the core dials — so the two
// cannot disagree. HARNESS_CONTROL_URL must name the same port.
const callUrl = new URL(process.env['HARNESS_WS_URL'] ?? 'ws://127.0.0.1:8081/call');
const controlUrl = new URL(process.env['HARNESS_CONTROL_URL'] ?? 'ws://127.0.0.1:8081/control');
if (callUrl.port !== controlUrl.port) throw new Error(`HARNESS_WS_URL and HARNESS_CONTROL_URL name different ports (${callUrl.port}, ${controlUrl.port}); the harness serves both on one`);
const port = Number(callUrl.port);

const harness = await HarnessServer.start({ port, profile, assets: fileAssets(), navMode, queueHoldMs: 8000 });
console.log(`harness listening: ${harness.callUrl()} (audio), ${harness.controlUrl()} (control); profile ${profileName}, nav ${navMode}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void harness.close().then(() => process.exit(0)));
}
