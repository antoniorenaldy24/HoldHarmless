/**
 * `HUMAN_REP`: the live microphone path — §10.6, §12.10, module 4.1.
 *
 * A team member's voice is captured locally, encoded to μ-law 8 kHz, and put
 * into the harness's outbound stream where a pre-rendered asset would go. §10.6
 * is four sentences long, so most of what follows is decision rather than
 * transcription, and each one is recorded where it is made.
 *
 * WHY ffmpeg AND NOT A NATIVE ADDON. ffmpeg is already required (§10.2 renders
 * every asset with it) and it emits exactly the format the harness wants, so
 * this path adds no dependency and no build step. A native audio addon would
 * add both, on the one platform (Windows) the demo host runs.
 *
 * WHAT "ONE TURN" MEANS. §12.10 declares `streamMicrophone(persona): Promise<void>`
 * and says nothing about when it resolves. It resolves at the END OF ONE TURN,
 * so that a `HUMAN_REP` turn substitutes for a `speakAs` turn in every script
 * §10.5 describes without the script knowing which mode it is in. The turn ends
 * when the speaker has been silent for `TURN_END_SILENCE_MS`.
 *
 * WHY THE SOURCE OUTLIVES THE TURN. Opening a capture device costs hundreds of
 * milliseconds, and a turn that begins while the device is still opening loses
 * its first word. So the device opens once per session and each turn is a gate
 * over a stream that is already running. That moves startup cost out of the
 * per-turn path entirely, and it is reported once as `mic_startup_latency_ms`.
 *
 * WHAT THIS PATH CAN AND CANNOT MEASURE. It measures delay VARIATION:
 * `mic_frame_delay_ms` is each frame's lateness against the fastest arrival-to-
 * stream-position relationship seen so far, which is what a pipe stall or a GC
 * pause looks like, and it is what actually breaks live audio. It CANNOT measure
 * the constant part — microphone, driver, and the device's own buffering before
 * ffmpeg sees anything — which needs a loopback reference (emit a click, record
 * it back) and is not attempted here. Discarding that constant is deliberate and
 * is what makes the number honest rather than arbitrary: see `consume`, where
 * anchoring to the first frame instead was measured putting a permanent -480 ms
 * on every reading. So the figure this path reports is a LOWER BOUND on
 * `HUMAN_REP` capture latency, and
 * §10.6's rule that `HUMAN_REP` figures are reported separately from `BOT_REP`
 * figures is exactly why that lower bound is still worth having: the two are
 * never pooled, so an unmeasured constant offset cannot contaminate a `BOT_REP`
 * number.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { BYTES_PER_FRAME, FRAME_MS, SAMPLE_RATE, muLaw } from '@holdharmless/audio';

/** Silence long enough to end a turn. Below a natural mid-sentence pause. */
export const TURN_END_SILENCE_MS = 700;

/**
 * A turn cannot run forever. §10.5's longest representative line is under 30 s;
 * this is generous enough not to cut a real answer and short enough that a
 * microphone left open on a quiet room does not hang a rehearsal.
 */
export const TURN_MAX_MS = 60_000;

/** How long to wait for the speaker to begin before giving up on the turn. */
export const TURN_ONSET_TIMEOUT_MS = 20_000;

/**
 * A frame at or above this RMS counts as speech for endpointing.
 *
 * Deliberately NOT the classifier's `SILENCE_RMS` (200), although it is near
 * it. That constant is calibrated for the hold/speech decision on audio that
 * has been loudness-normalized (§10.2); this one runs on un-normalized live
 * capture, where the level is whatever the person's microphone gain happens to
 * be. Sharing the constant would tie a decision about a live device to a
 * measurement taken on rendered files, and a later change to one would silently
 * move the other.
 */
export const SPEECH_RMS = 250;

export type MicFrame = {
  frame: Uint8Array;
  /**
   * The AUDIO TIMELINE: consecutive frames are exactly `FRAME_MS` apart, by
   * construction, whatever order or bursts the bytes arrived in. Carries an
   * unknown constant offset — the acoustic and buffering latency no software on
   * this side can see — so differences are meaningful and the absolute value is
   * not.
   */
  capturedAtMs: number;
  /**
   * ARRIVAL LATENESS against the fastest arrival-to-stream-position relationship
   * seen so far. Never negative.
   *
   * This is a separate field because the two numbers want opposite things and
   * one field cannot be both. `capturedAtMs` must keep the 20 ms spacing, or a
   * turn whose audio arrived in bursts would report a compressed length and
   * `lastSpeechAtMs` would be wrong. `delayMs` must discount the constant
   * buffering, or the flush ffmpeg performs at device open — measured at 480 ms
   * on real hardware — becomes a permanent negative offset on every reading and
   * a genuine stall can never show as positive. Deriving one from the other is
   * what the first version of this module did, and it got one of them wrong.
   */
  delayMs: number;
};

export interface MicrophoneSource {
  /** Opens the device. Resolves when audio is flowing, rejects if it will not. */
  open(): Promise<void>;
  /**
   * Returns an unsubscribe. One source serves a whole call and every turn
   * subscribes to it, so a turn that ended must let go — otherwise a long call
   * accumulates one dead listener per turn, each still decoding every frame.
   */
  onFrame(handler: (f: MicFrame) => void): () => void;
  /** ms from `open()` to the first audio byte; null until that byte arrives. */
  readonly startupLatencyMs: number | null;
  close(): Promise<void>;
}

export function frameRms(frame: Uint8Array): number {
  const pcm = muLaw.decode(frame);
  let sum = 0;
  for (const s of pcm) sum += s * s;
  return Math.sqrt(sum / pcm.length);
}

// --- the live device ------------------------------------------------------

export type FfmpegMicOptions = {
  /**
   * Capture device, in the form the platform's ffmpeg input expects: a dshow
   * name on Windows ("Microphone (Realtek Audio)"), an avfoundation index on
   * macOS (":1"), an ALSA name on Linux ("default"). Required — guessing a
   * device would mean recording from whatever happened to be first.
   */
  device: string;
  /** Overridden in tests; also lets a caller point at a specific binary. */
  ffmpegPath?: string;
  platform?: NodeJS.Platform;
  /** How long to wait for the first byte before declaring the device dead. */
  openTimeoutMs?: number;
  clock?: () => number;
  /**
   * Injected so the failure modes can be tested without a device: a capture
   * process that opens and then stays silent is the one that matters most (a
   * muted input, a webcam microphone whose phone app is not running) and it
   * cannot be provoked by pointing this at a different binary.
   */
  spawn?: (cmd: string, args: string[]) => ChildProcess;
};

/** ffmpeg's input arguments differ per platform; the output arguments do not. */
export function captureArgs(device: string, platform: NodeJS.Platform): string[] {
  const input =
    platform === 'win32' ? ['-f', 'dshow', '-i', `audio=${device}`]
    : platform === 'darwin' ? ['-f', 'avfoundation', '-i', device]
    : ['-f', 'alsa', '-i', device];
  return [
    '-hide_banner', '-loglevel', 'error',
    ...input,
    // NO loudnorm, unlike the rendered assets (§10.2). Its single-pass mode
    // carries about three seconds of lookahead, which on a live path would
    // dwarf everything else this module measures. The consequence — live
    // capture is NOT level-matched to the rendered assets — is handled by
    // measuring the level and refusing an out-of-range one, not by filtering.
    '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 'mulaw', '-',
  ];
}

export class FfmpegMicrophone implements MicrophoneSource {
  private proc: ChildProcess | null = null;
  private readonly handlers: ((f: MicFrame) => void)[] = [];
  private pending = new Uint8Array(0);
  private firstFrameAt: number | null = null;
  private framesEmitted = 0;
  /** The smallest (arrival - stream position) seen; see `consume`. */
  private minOffsetMs: number | null = null;
  private openedAt = 0;
  private stderr = '';
  private readonly clock: () => number;

  constructor(private readonly opts: FfmpegMicOptions) {
    this.clock = opts.clock ?? (() => performance.now());
  }

  startupLatencyMsValue: number | null = null;

  get startupLatencyMs(): number | null {
    return this.startupLatencyMsValue;
  }

  open(): Promise<void> {
    const args = captureArgs(this.opts.device, this.opts.platform ?? process.platform);
    this.openedAt = this.clock();
    const launch = this.opts.spawn ?? ((cmd: string, a: string[]) => spawn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'] }));
    const proc = launch(this.opts.ffmpegPath ?? 'ffmpeg', args);
    this.proc = proc;

    proc.stderr?.on('data', (b: Buffer) => {
      this.stderr += b.toString();
    });

    const timeout = this.opts.openTimeoutMs ?? 5_000;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A device that opens but never produces audio is the failure mode that
        // matters here: a webcam microphone whose phone app is not running, a
        // muted input. It looks like success to spawn() and like a hang to a
        // rehearsal, so it is turned into an error with the device named.
        reject(new Error(`microphone "${this.opts.device}" produced no audio within ${timeout} ms${this.stderr ? `: ${this.stderr.trim()}` : ''}`));
        void this.close();
      }, timeout);

      proc.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`could not start ffmpeg for microphone capture: ${String(err)}`));
      });
      proc.once('exit', (code) => {
        if (this.firstFrameAt === null) {
          clearTimeout(timer);
          reject(new Error(`ffmpeg exited with code ${String(code)} before any audio${this.stderr ? `: ${this.stderr.trim()}` : ''}`));
        }
      });
      proc.stdout?.on('data', (b: Buffer) => {
        if (this.firstFrameAt === null) clearTimeout(timer);
        const first = this.consume(new Uint8Array(b));
        if (first) resolve();
      });
    });
  }

  /** Splits the byte stream into frames. Returns true on the very first one. */
  private consume(chunk: Uint8Array): boolean {
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);

    let off = 0;
    let wasFirst = false;
    const arrivedAt = this.clock();
    while (joined.length - off >= BYTES_PER_FRAME) {
      const frame = joined.slice(off, off + BYTES_PER_FRAME);
      off += BYTES_PER_FRAME;
      if (this.firstFrameAt === null) {
        this.firstFrameAt = arrivedAt;
        this.startupLatencyMsValue = arrivedAt - this.openedAt;
        wasFirst = true;
      }
      const streamPositionMs = this.framesEmitted * FRAME_MS;
      this.framesEmitted++;
      // The timeline is anchored to the first frame, so the 20 ms spacing holds.
      const capturedAtMs = this.firstFrameAt + streamPositionMs;
      // The delay is anchored to the SMALLEST (arrival - stream position) seen
      // so far — the standard one-way delay-variation measure. It discards the
      // unmeasurable constant (buffering, driver, the acoustic path) and keeps
      // the variation, which is what breaks live audio and what this can see.
      // Found by running against real hardware: ffmpeg flushes a buffer at
      // open, 174 frames of a 3480 ms stream arriving in 3000 ms of wall time,
      // which anchored any other way puts a standing -480 ms on every reading.
      const offset = arrivedAt - streamPositionMs;
      if (this.minOffsetMs === null || offset < this.minOffsetMs) this.minOffsetMs = offset;
      const delayMs = offset - this.minOffsetMs;
      for (const h of this.handlers) h({ frame, capturedAtMs, delayMs });
    }
    this.pending = joined.slice(off);
    return wasFirst;
  }

  onFrame(handler: (f: MicFrame) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  async close(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill();
      // A capture process that ignores the signal must not hang the harness.
      setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 1_000).unref();
    });
  }
}

// --- the test double -----------------------------------------------------

/**
 * Replays μ-law audio as though it were a microphone, at the frame cadence.
 *
 * This is what CI runs: the demo host has a microphone and no build agent does,
 * so every behaviour of this module that can be pinned without a device is
 * pinned against this. It is also how the rendered assets are fed through the
 * live path in `scripts/mic-check.ts` — the same bytes down the same code,
 * which is what isolates "this path changes the audio" from "a human voice
 * differs from a rendered one".
 */
export class ScriptedMicrophone implements MicrophoneSource {
  private readonly handlers: ((f: MicFrame) => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private index = 0;
  private readonly t0 = performance.now();
  startupLatencyMsValue: number | null = null;

  constructor(
    private readonly frames: readonly Uint8Array[],
    private readonly opts: { startupLatencyMs?: number } = {},
  ) {}

  get startupLatencyMs(): number | null {
    return this.startupLatencyMsValue;
  }

  open(): Promise<void> {
    this.startupLatencyMsValue = this.opts.startupLatencyMs ?? 0;
    this.timer = setInterval(() => this.emit(), FRAME_MS);
    return Promise.resolve();
  }

  /** Emits the next frame. Exposed so a test can drive it without real time. */
  emit(): void {
    const frame = this.frames[this.index];
    if (!frame) return;
    const capturedAtMs = this.t0 + this.index * FRAME_MS;
    this.index++;
    // Synthetic frames arrive on time by definition; there is no pipe to stall.
    for (const h of this.handlers) h({ frame, capturedAtMs, delayMs: 0 });
  }

  get exhausted(): boolean {
    return this.index >= this.frames.length;
  }

  onFrame(handler: (f: MicFrame) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    return Promise.resolve();
  }
}

// --- one turn ------------------------------------------------------------

export type TurnResult = {
  /** Frames the turn passed on, in order. */
  frames: Uint8Array[];
  /**
   * The capture time of the last frame that contained SPEECH — not of the last
   * frame streamed.
   *
   * This distinction is the whole reason the field exists. `perceived_response_ms`
   * (§16.1) is measured from the end of the far end's audio to the agent's first
   * audible byte. Take the endpointer's DECISION as that end instead and every
   * `HUMAN_REP` figure comes out `TURN_END_SILENCE_MS` too small — 700 ms of the
   * harness's own patience quietly deducted from the agent's latency, against a
   * bar of 300 ms. It is wrong in the FLATTERING direction, which is the worse
   * one: it could turn a figure that fails into one that passes, on the number
   * panel 7 shows a judge. The person stopped speaking when they stopped
   * speaking; what the harness took to notice is the harness's.
   */
  lastSpeechAtMs: number | null;
  /** Each frame's `delayMs`, as the source measured it. */
  frameDelaysMs: number[];
  /** Mean RMS over the speech frames — what the level check reads. */
  speechRms: number;
  endedBy: 'silence' | 'max_duration' | 'no_onset' | 'stopped';
};

export type TurnOptions = {
  source: MicrophoneSource;
  /** Where each frame goes as it arrives. */
  emit: (frame: Uint8Array) => void;
  silenceMs?: number;
  maxMs?: number;
  onsetTimeoutMs?: number;
  speechRms?: number;
  /** Injected in tests; real time otherwise. */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
};

/**
 * Gates one turn out of an already-running microphone stream.
 *
 * The gate opens on the first speech frame and closes after `silenceMs` of
 * quiet. Frames BEFORE onset are dropped rather than forwarded: the stream is
 * open across the whole call, so what precedes a turn is the room, and sending
 * the room would make the agent's own silence-recovery timers (§5.7) fire
 * against noise the representative never made.
 */
export function micTurn(opts: TurnOptions): { done: Promise<TurnResult>; stop: () => void } {
  const silenceMs = opts.silenceMs ?? TURN_END_SILENCE_MS;
  const maxMs = opts.maxMs ?? TURN_MAX_MS;
  const onsetMs = opts.onsetTimeoutMs ?? TURN_ONSET_TIMEOUT_MS;
  const speechRms = opts.speechRms ?? SPEECH_RMS;
  const schedule =
    opts.schedule ??
    ((fn, ms) => {
      // unref: a turn waiting for somebody to speak is not a reason for the
      // process to stay alive. The call's own socket is.
      const h = setTimeout(fn, ms);
      h.unref();
      return { cancel: () => clearTimeout(h) };
    });

  const frames: Uint8Array[] = [];
  const frameDelaysMs: number[] = [];
  let speechFrames = 0;
  let speechRmsSum = 0;
  let started = false;
  let lastSpeechAtMs: number | null = null;
  let settled = false;

  let finish!: (r: TurnResult) => void;
  const done = new Promise<TurnResult>((resolve) => {
    finish = resolve;
  });

  const timers: { cancel: () => void }[] = [];
  // Assigned below, but `end` can run before that line: an injected scheduler
  // in a test may fire synchronously. A no-op default keeps that a non-event.
  let unsubscribe: () => void = () => {};
  const end = (endedBy: TurnResult['endedBy']) => {
    if (settled) return;
    settled = true;
    unsubscribe();
    for (const t of timers) t.cancel();
    finish({ frames, lastSpeechAtMs, frameDelaysMs, speechRms: speechFrames > 0 ? speechRmsSum / speechFrames : 0, endedBy });
  };

  // Until the representative speaks, the only deadline that applies is the one
  // for speaking at all; it is replaced by the duration cap at onset.
  timers.push(schedule(() => end('no_onset'), onsetMs));

  unsubscribe = opts.source.onFrame(({ frame, capturedAtMs, delayMs }) => {
    if (settled) return;
    frameDelaysMs.push(delayMs);
    const rms = frameRms(frame);
    const isSpeech = rms >= speechRms;

    if (!started) {
      if (!isSpeech) return; // the room, not the representative
      started = true;
      for (const t of timers.splice(0)) t.cancel();
      timers.push(schedule(() => end('max_duration'), maxMs));
    }

    frames.push(frame);
    opts.emit(frame);

    if (isSpeech) {
      speechFrames++;
      speechRmsSum += rms;
      lastSpeechAtMs = capturedAtMs;
    } else if (lastSpeechAtMs !== null && capturedAtMs - lastSpeechAtMs >= silenceMs) {
      end('silence');
    }
  });

  return { done, stop: () => end('stopped') };
}
