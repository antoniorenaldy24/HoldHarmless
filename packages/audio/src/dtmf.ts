/**
 * DTMF generation and detection — ADR-005 and ADR-013.
 *
 * The agent synthesizes genuine dual-tone audio and injects it into the outbound
 * frame stream; the harness decodes it with a Goertzel filter bank. The
 * alternative — a side-channel message saying "the agent pressed 2" — would make
 * navigation work while demonstrating nothing.
 *
 * Both endpoints are ours, so tone SURVIVAL is guaranteed by construction and
 * that question is not under test (§1.7). Tone TIMING is, and E1 sweeps it.
 */

import { muLaw, SAMPLE_RATE, BYTES_PER_FRAME, MULAW_SILENCE } from './mulaw.js';

/** 697/770/852/941 Hz against 1209/1336/1477/1633 Hz (ADR-005). */
export const LOW_TONES = [697, 770, 852, 941] as const;
export const HIGH_TONES = [1209, 1336, 1477, 1633] as const;

export const DTMF_KEYPAD = [
  ['1', '2', '3', 'A'],
  ['4', '5', '6', 'B'],
  ['7', '8', '9', 'C'],
  ['*', '0', '#', 'D'],
] as const;

export const DTMF_FREQUENCIES = [...LOW_TONES, ...HIGH_TONES];

export function tonesFor(digit: string): readonly [number, number] | null {
  for (let row = 0; row < DTMF_KEYPAD.length; row++) {
    const col = DTMF_KEYPAD[row]!.indexOf(digit.toUpperCase() as never);
    if (col >= 0) return [LOW_TONES[row]!, HIGH_TONES[col]!];
  }
  return null;
}

export const DEFAULT_TONE_MS = 100;
export const DEFAULT_GAP_MS = 50;

export interface DtmfGenerator {
  generate(digits: string, toneMs?: number, gapMs?: number): Uint8Array[];
}

/**
 * Renders digits to 20 ms μ-law frames: tone, gap, tone, gap.
 *
 * Amplitude is deliberately below full scale. Two sines at 0.5 sum to 1.0, and
 * a summed pair that clips would distort the very frequencies the detector is
 * looking for — a self-inflicted decode failure that looks like a transport
 * problem.
 */
export const dtmf: DtmfGenerator = {
  generate(digits: string, toneMs = DEFAULT_TONE_MS, gapMs = DEFAULT_GAP_MS): Uint8Array[] {
    const samples: number[] = [];

    for (const digit of digits) {
      const pair = tonesFor(digit);
      if (pair === null) throw new Error(`Not a DTMF digit: ${JSON.stringify(digit)}`);
      const [low, high] = pair;

      const toneSamples = Math.round((SAMPLE_RATE * toneMs) / 1000);
      for (let n = 0; n < toneSamples; n++) {
        const t = n / SAMPLE_RATE;
        const value =
          0.4 * Math.sin(2 * Math.PI * low * t) + 0.4 * Math.sin(2 * Math.PI * high * t);
        samples.push(Math.round(value * 16384));
      }

      const gapSamples = Math.round((SAMPLE_RATE * gapMs) / 1000);
      for (let n = 0; n < gapSamples; n++) samples.push(0);
    }

    return chunkToFrames(muLaw.encode(Int16Array.from(samples)));
  },
};

/** Splits a μ-law byte stream into 20 ms frames, padding the tail with silence. */
export function chunkToFrames(bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += BYTES_PER_FRAME) {
    const slice = bytes.subarray(offset, offset + BYTES_PER_FRAME);
    if (slice.length === BYTES_PER_FRAME) {
      frames.push(slice);
    } else {
      const padded = new Uint8Array(BYTES_PER_FRAME).fill(MULAW_SILENCE);
      padded.set(slice);
      frames.push(padded);
    }
  }
  return frames;
}
