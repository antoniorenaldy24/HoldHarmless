/**
 * Audio helpers for the Day-0 scaffold.
 *
 * Throwaway code — the production μ-law codec and framing live in packages/audio
 * (§12.2) and are written properly there. This exists only to get bytes onto the
 * wire at the right cadence.
 *
 * Frame arithmetic for μ-law 8 kHz, 20 ms (§4.1):
 *   8000 samples/s x 1 byte/sample x 0.020 s = 160 bytes per frame.
 * For PCM16 24 kHz, 20 ms:
 *   24000 x 2 x 0.020 = 960 bytes per frame.
 *
 * The API takes audio as base64 inside a JSON `input.audio` message, not as raw
 * binary WebSocket frames.
 */

import fs from 'node:fs';
import { send, sleep } from './session.mjs';

export const FRAME_MS = 20;

export function bytesPerFrame(encoding, sampleRate) {
  const bytesPerSample = encoding === 'audio/pcmu' ? 1 : 2;
  return Math.round(sampleRate * bytesPerSample * (FRAME_MS / 1000));
}

/** Splits a raw audio file into fixed-size frames. The tail is zero-padded. */
export function frameFile(filePath, encoding, sampleRate) {
  const buf = fs.readFileSync(filePath);
  const size = bytesPerFrame(encoding, sampleRate);
  const frames = [];
  for (let off = 0; off < buf.length; off += size) {
    const slice = buf.subarray(off, off + size);
    if (slice.length === size) {
      frames.push(slice);
    } else {
      const padded = Buffer.alloc(size, encoding === 'audio/pcmu' ? 0xff : 0x00);
      slice.copy(padded);
      frames.push(padded);
    }
  }
  return frames;
}

/** A frame of silence. μ-law silence is 0xFF, PCM16 silence is 0x00. */
export function silenceFrame(encoding, sampleRate) {
  return Buffer.alloc(bytesPerFrame(encoding, sampleRate), encoding === 'audio/pcmu' ? 0xff : 0x00);
}

/**
 * Streams frames at real-time cadence — one frame every 20 ms.
 *
 * Sending the whole file at once would let the server transcribe faster than real
 * time and make every latency figure in §4.2 meaningless. `onFrame` is called with
 * the index before each send, which is how the experiments stamp "last frame sent".
 */
export async function streamFrames(ws, log, frames, { onFrame } = {}) {
  const startedAt = Date.now();
  for (let i = 0; i < frames.length; i++) {
    onFrame?.(i, frames.length);
    send(ws, log, { type: 'input.audio', audio: frames[i].toString('base64') });

    // Pace against the wall clock so accumulated drift does not compress the stream.
    const targetMs = startedAt + (i + 1) * FRAME_MS;
    const waitMs = targetMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);
  }
  return Date.now();
}

/** Streams `ms` of silence — used to nudge the endpointer into closing a turn. */
export async function streamSilence(ws, log, encoding, sampleRate, ms) {
  const frame = silenceFrame(encoding, sampleRate);
  const count = Math.round(ms / FRAME_MS);
  return streamFrames(ws, log, Array(count).fill(frame));
}

/** Collects base64 reply.audio chunks and writes them to one raw file. */
export function makeReplyRecorder(outPath) {
  const chunks = [];
  return {
    push: (b64) => chunks.push(Buffer.from(b64, 'base64')),
    byteLength: () => chunks.reduce((n, c) => n + c.length, 0),
    write: () => {
      if (chunks.length === 0) return null;
      fs.writeFileSync(outPath, Buffer.concat(chunks));
      return outPath;
    },
    reset: () => (chunks.length = 0),
  };
}
