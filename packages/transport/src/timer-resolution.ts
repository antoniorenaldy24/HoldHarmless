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

/**
 * Module-level references to the loaded library and its two functions.
 *
 * WITHOUT THESE THE RAISED RESOLUTION IS LOST TO GARBAGE COLLECTION, silently.
 * koffi's library handle was a local; once it became unreachable the DLL could
 * be unloaded, and unloading winmm ends the period that timeBeginPeriod began.
 * Measured on 2026-09-24 inside one test process: setTimeout(25) took 25.34 ms
 * early on and setTimeout(20) took 30.55 ms later — the 15.625 ms quantum, back
 * without a word. Everything downstream (the 20 ms pacing, every latency figure,
 * the profile itself) had quietly stopped being true.
 */
let held: { winmm: unknown; begin: (p: number) => number; end: (p: number) => number } | null = null;

/**
 * Whether the library reference above is still alive.
 *
 * It exists so `held` is READ somewhere and not only written. A stricter
 * compiler (the dashboard's, which now reaches this file through the core)
 * reports a write-only variable as unused, and the obvious response — deleting
 * it — is exactly the change that silently costs 1 ms timer resolution again.
 * A test can now assert the reference outlives the call that made it.
 */
export function timerLibraryHeld(): boolean {
  return held !== null;
}

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

    held = { winmm, begin, end };
    const throttling = disableTimerThrottling(koffi);

    const release = () => {
      if (active === null) return;
      active = null;
      held = null;
      end(1);
    };
    active = { release };
    process.once('exit', release);
    return { raised: true, platform: 'win32', detail: `raised from 15.625 ms to 1 ms via timeBeginPeriod; ${throttling}` };
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

/**
 * Opts this process out of Windows 11's timer-resolution throttling.
 *
 * WITHOUT THIS, timeBeginPeriod(1) STOPS WORKING WHEN THE PROCESS IS NOT IN
 * THE FOREGROUND. Measured on 2026-09-24: inside one test process, an early
 * setTimeout(25) took 25.34 ms and a later setTimeout(20) took 30.55 ms — the
 * 15.625 ms quantum, back without a word, after the window lost focus. The
 * far end's 20 ms drain then ran at 31 ms, its playout queue overflowed by 44
 * frames, and repeated DTMF digits merged. The symptom looked like a decoder
 * fault; the cause was the operating system throttling a background process.
 *
 * SetProcessInformation(ProcessPowerThrottling) with
 * PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION in the control mask and a
 * zero state mask is the documented way to ask for the exemption.
 */
function disableTimerThrottling(koffi: typeof import('koffi')): string {
  const PROCESS_POWER_THROTTLING = 4;
  const CURRENT_VERSION = 1;
  const IGNORE_TIMER_RESOLUTION = 0x4;
  try {
    const kernel32 = koffi.load('kernel32.dll');
    const getCurrentProcess = kernel32.func('void* __stdcall GetCurrentProcess()') as () => unknown;
    const setProcessInformation = kernel32.func(
      'int __stdcall SetProcessInformation(void* hProcess, int ProcessInformationClass, void* ProcessInformation, uint32 ProcessInformationSize)',
    ) as (h: unknown, cls: number, info: Buffer, size: number) => number;

    // PROCESS_POWER_THROTTLING_STATE: three 32-bit fields.
    const state = Buffer.alloc(12);
    state.writeUInt32LE(CURRENT_VERSION, 0);
    state.writeUInt32LE(IGNORE_TIMER_RESOLUTION, 4); // ControlMask: this is ours to set
    state.writeUInt32LE(0, 8); // StateMask 0: do NOT throttle it
    const ok = setProcessInformation(getCurrentProcess(), PROCESS_POWER_THROTTLING, state, state.length);
    thrott = ok !== 0;
    return ok !== 0 ? 'timer throttling disabled for this process' : 'timer throttling could NOT be disabled';
  } catch (err) {
    return `timer throttling could NOT be disabled: ${(err as Error).message}`;
  }
}

/** True when this process is exempt from Windows timer-resolution throttling. */
export function timerThrottlingDisabled(): boolean {
  return thrott;
}

let thrott = false;

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
