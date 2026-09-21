/**
 * G.711 μ-law codec — ITU-T G.711, the encoding every telephony platform
 * delivers and the encoding AssemblyAI receives (§1.7, §4.1).
 *
 * Hand-written on purpose (ADR-004): roughly sixty lines, and no opaque
 * dependency sits in the audio path when it needs debugging.
 *
 * μ-law is an 8-bit logarithmic encoding of 14-bit linear PCM. Encoding is
 * lossy by construction — it quantizes to 8 bits — so a PCM sample does not
 * survive a round trip unchanged. What DOES survive unchanged is a μ-law byte:
 * decode then re-encode returns the original byte for all 256 values, and that
 * is the property the transport depends on, because μ-law is what crosses the
 * wire in both directions with no resampling anywhere.
 */

const BIAS = 0x84; // 132, added before encoding
const CLIP = 32635; // maximum linear value before clipping

/**
 * Segment upper bounds, from the G.711 reference implementation.
 *
 * These are the BIASED magnitudes, so the table starts at 0x3F and not 0x1F.
 * Shifting it down by one segment still produces plausible audio — tones are
 * recognizable, speech is intelligible — while quantizing 112 of the 256 byte
 * values into the wrong segment. It is a bug that hides in listening tests and
 * only surfaces against a byte-exact round trip, which is why that round trip
 * is the first test in this package.
 */
const SEG_END = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];

function segment(value: number): number {
  for (let i = 0; i < SEG_END.length; i++) {
    const end = SEG_END[i];
    if (end !== undefined && value <= end) return i;
  }
  return SEG_END.length;
}

/**
 * One 16-bit linear sample to one μ-law byte.
 *
 * The encoder works on the 14-bit scale, the decoder on the 16-bit one — that
 * asymmetry is in G.711 itself, not a convenience here. Hence `>> 2` on both the
 * sample and the bias, and a mantissa shift of `seg + 1` rather than `seg + 3`.
 * Omitting the shift produces audio that sounds correct and quantizes 112 of the
 * 256 byte values into the wrong segment.
 */
export function encodeSample(pcm: number): number {
  if (pcm > 32767) pcm = 32767;
  if (pcm < -32768) pcm = -32768;

  const sign = (pcm >> 8) & 0x80;
  if (sign !== 0) pcm = -pcm;
  if (pcm > CLIP) pcm = CLIP;

  const biased = (pcm >> 2) + (BIAS >> 2);
  const seg = segment(biased);
  const mantissa = (biased >> (seg + 1)) & 0x0f;
  // μ-law is transmitted inverted.
  return ~(sign | (seg << 4) | mantissa) & 0xff;
}

/** One μ-law byte to one 16-bit linear sample. */
export function decodeSample(mulaw: number): number {
  const inverted = ~mulaw & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;

  let value = ((mantissa << 3) + BIAS) << exponent;
  value -= BIAS;

  // `-value` on zero yields -0, and Object.is(-0, 0) is false — so a scalar
  // caller comparing against 0 would disagree with the array path, where
  // Int16Array silently normalizes it. Returning a single zero keeps the two
  // consistent. The negative-zero CODE (0x7F) still exists; only the decoded
  // number is normalized.
  if (value === 0) return 0;
  return sign !== 0 ? -value : value;
}

// ---------------------------------------------------------------------------
// Tables. 256 and 65536 entries respectively — built once, and the encode table
// is what keeps the 20 ms frame budget comfortable on a single event loop.
// ---------------------------------------------------------------------------

const DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) DECODE_TABLE[i] = decodeSample(i);

const ENCODE_TABLE = new Uint8Array(65536);
for (let i = 0; i < 65536; i++) {
  // Index by the unsigned representation of a signed 16-bit sample.
  const pcm = i >= 32768 ? i - 65536 : i;
  ENCODE_TABLE[i] = encodeSample(pcm);
}

export interface MuLawCodec {
  decode(mulaw: Uint8Array): Int16Array;
  encode(pcm: Int16Array): Uint8Array;
}

export const muLaw: MuLawCodec = {
  decode(mulaw: Uint8Array): Int16Array {
    const out = new Int16Array(mulaw.length);
    for (let i = 0; i < mulaw.length; i++) out[i] = DECODE_TABLE[mulaw[i]!]!;
    return out;
  },

  encode(pcm: Int16Array): Uint8Array {
    const out = new Uint8Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = ENCODE_TABLE[pcm[i]! & 0xffff]!;
    return out;
  },
};

/** μ-law silence. Not 0x00 — that is near full negative scale. */
export const MULAW_SILENCE = 0xff;

export const SAMPLE_RATE = 8000;
export const FRAME_MS = 20;
/** 8000 samples/s x 1 byte x 0.020 s (§4.1). */
export const BYTES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;

export function silenceFrame(): Uint8Array {
  return new Uint8Array(BYTES_PER_FRAME).fill(MULAW_SILENCE);
}
