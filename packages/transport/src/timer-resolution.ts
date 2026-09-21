/**
 * Process timer resolution — a host property that decides whether §4.5's
 * network profile is actually applied.
 *
 * MEASURED ON THE DEVELOPMENT HOST (Windows 11, 2026-09-21):
 *
 *   requested   actual, default resolution   actual, after timeBeginPeriod(1)
 *   17 ms       31.2 ms                      17.4 ms
 *   25 ms       31.1 ms                      25.5 ms
 *   33 ms       46.8 ms                      33.5 ms
 *
 * Windows wakes timers on a 15.625 ms quantum unless a process asks for finer.
 * At the default, 17 ms and 25 ms both become 31.2 ms: TELEPHONY's 25 ms +/- 8
 * collapses to roughly 31 ms +/- 1, the jitter distribution is erased, and CLEAN
 * becomes 15 ms rather than zero. Every latency figure reported "under TELEPHONY"
 * would in fact have been measured under a different, undocumented profile —
 * the precise failure INV-16 exists to prevent, arriving from the host instead
 * of from a careless configuration.
 *
 * timeBeginPeriod(1) is what Chrome and most media software call. Since Windows
 * 10 version 2004 it is scoped to the calling process, so it cannot be inherited
 * from another application that happens to be running; each process that
 * depends on the profile must request it itself — core AND harness.
 *
 * On any other platform this is a no-op: Linux and macOS already schedule
 * timers at sub-millisecond resolution.
 */

import { createRequire } from 'node:module';

export type TimerResolution = {
  /** True when the host needed raising and it was raised. */
  raised: boolean;
  platform: NodeJS.Platform;
  /** Human-readable, for logs and the compliance panel. */
  detail: string;
};

let active: { release: () => void } | null = null;

export function raiseTimerResolution(): TimerResolution {
  if (process.platform !== 'win32') {
    return { raised: false, platform: process.platform, detail: 'not required on this platform' };
  }
  if (active !== null) {
    return { raised: true, platform: 'win32', detail: 'already raised to 1 ms' };
  }

  try {
    const require = createRequire(import.meta.url);
    const koffi = require('koffi') as typeof import('koffi');
    const winmm = koffi.load('winmm.dll');
    const begin = winmm.func('uint32 __stdcall timeBeginPeriod(uint32 uPeriod)') as (p: number) => number;
    const end = winmm.func('uint32 __stdcall timeEndPeriod(uint32 uPeriod)') as (p: number) => number;

    if (begin(1) !== 0) {
      return { raised: false, platform: 'win32', detail: 'timeBeginPeriod(1) returned an error' };
    }

    const release = () => {
      if (active === null) return;
      active = null;
      end(1);
    };
    active = { release };
    process.once('exit', release);
    return { raised: true, platform: 'win32', detail: 'raised from 15.625 ms to 1 ms via timeBeginPeriod' };
  } catch (err) {
    // Never fatal: the system still runs, it just cannot honor the profile.
    // The caller is expected to record this, so a figure measured without it
    // can be identified rather than silently trusted.
    return {
      raised: false,
      platform: 'win32',
      detail: `could not raise timer resolution: ${(err as Error).message}`,
    };
  }
}

export function releaseTimerResolution(): void {
  active?.release();
}

/**
 * Measures what the host actually delivers for a requested delay. Used by tests
 * and by the harness at startup, so a coarse clock is detected rather than
 * assumed away.
 */
export async function measureTimerAccuracy(requestedMs = 25, samples = 20): Promise<{ meanMs: number; errorMs: number }> {
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    await new Promise((r) => setTimeout(r, requestedMs));
    total += performance.now() - t;
  }
  const meanMs = total / samples;
  return { meanMs, errorMs: meanMs - requestedMs };
}
