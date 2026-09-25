/**
 * The simulated switchboard — §10, interface §12.10. Week-1 skeleton (§21 1.10):
 * a three-level menu navigable by DTMF and by speech, the representative's
 * greeting at the end of it, the playout queue with clear and mark, and the
 * control channel. The conversation after the greeting — field requests,
 * holds, transfers, party swaps (§10.5) — is week 2 and 3.
 *
 * One port, two paths (§13): /call is the audio link (a LoopbackEndpoint),
 * /control is telemetry. The core may pass ?callId= on both so the harness's
 * reports name the call the core knows.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGoertzelDetector, silenceFrame, FRAME_MS } from '@holdharmless/audio';
import type { NetworkProfile } from '@holdharmless/transport';
import { LoopbackEndpoint, type FarEndSession } from '@holdharmless/transport-loopback';
import type { AssetSource } from './assets.js';
import { ControlServer } from './control.js';
import { LINES, lineAnnouncesHold, type LineId, type Role } from './lines.js';
import { MENU, MenuNavigator, NO_INPUT_TIMEOUT_MS, type MenuAction } from './menu.js';
import { frameRms, micTurn, SPEECH_RMS, type MicrophoneSource } from './microphone.js';
import { Pacer } from './pacer.js';

export type HarnessNavMode = 'dtmf' | 'speech' | 'both';

/** §10.5, §10.7. */
export type RepMode = 'BOT_REP' | 'HUMAN_REP';

/**
 * Turns the agent's audio into text, for speech navigation.
 *
 * NOT SPECIFIED BY THE SSOT. §10.5 requires speech navigation and §12.10 gives
 * the harness onSpokenChoice(text), but nothing says what produces the text.
 * The choice (a second AssemblyAI streaming session, which costs credit; or a
 * local recognizer, which adds a dependency) is left open; until it is made,
 * a recognizer is injected, and the harness refuses speech mode without one.
 */
export interface SpeechRecognizer {
  /** Audio as it reaches the harness's speaker. */
  feed(frame: Uint8Array): void;
  onUtterance(handler: (text: string) => void): void;
  close?(): void;
}

export interface HarnessSession {
  readonly callId: string;
  onDigit(handler: (digit: string) => void): void;
  onSpokenChoice(handler: (text: string) => void): void;
  advance(level: number): Promise<void>;
  playHold(durationMs: number, silent: boolean): Promise<void>;
  speakAs(persona: number, lineId: LineId): Promise<void>;
  streamMicrophone(persona: number): Promise<void>;
  swapParty(): void;
  close(delayMs: number): Promise<void>;
  telemetry(metric: string, value: number, detail?: string): void;
}

/**
 * Above this RMS, a frame from the harness's speaker counts as audible.
 *
 * It needs no tuning and was not tuned. The two things it separates are comfort
 * silence (§4.4), which is `MULAW_SILENCE` repeated and decodes to an RMS of
 * zero, and audio, which is in the thousands. Any value in between gives the
 * same answer; this one matches the classifier's `SILENCE_RMS` so a reader does
 * not have to wonder whether the difference was meant.
 */
const AUDIBLE_RMS = 200;

/** §12.10 numbers personas; lines.ts names roles. 0 is the IVR itself. */
const PERSONA_ROLE: Readonly<Record<number, Role>> = { 0: 'ivr', 1: 'rep1', 2: 'rep2' };

export type HarnessOptions = {
  port: number;
  host?: string;
  profile: NetworkProfile;
  assets: AssetSource;
  navMode: HarnessNavMode;
  recognizer?: () => SpeechRecognizer;
  playoutDepthMs?: number;
  noInputTimeoutMs?: number;
  /** Hold before the representative answers; 0 in tests. */
  queueHoldMs?: number;
  /**
   * `BOT_REP` (the default) plays rendered assets; `HUMAN_REP` streams a live
   * microphone in their place (§10.6). Declared here rather than inferred from
   * whether a source was supplied, because §10.6 requires the mode to be
   * REPORTED — a figure whose mode is a matter of inference is a figure that
   * can be pooled with the other mode by accident.
   */
  repMode?: RepMode;
  /**
   * Opens the capture device for a `HUMAN_REP` session. One per session, opened
   * on the first turn that needs it and closed with the call.
   */
  microphone?: () => MicrophoneSource;
};

class Session implements HarnessSession {
  readonly pacer: Pacer;
  private readonly digitHandlers: ((d: string) => void)[] = [];
  private readonly speechHandlers: ((t: string) => void)[] = [];
  private partiesUsed = 1;
  private closed = false;
  /**
   * `perceived_response_ms` (§7, §16.1) needs two observations and the harness
   * is where both of them live: when the representative's audio ENDED, and when
   * the agent's audio became audible here.
   *
   * §7 words the first as "when the harness stops playing the representative's
   * line". Read literally that is the end of the asset FILE, trailing silence
   * included — which would put a few hundred milliseconds of edge-tts padding
   * inside a figure measured against a 300 ms bar, and would have no analogue
   * at all in `HUMAN_REP`, where there is no file. So it is read as A-13 words
   * it, "end of the representative's audio": the last AUDIBLE frame sent. One
   * rule serves both modes, and what then differs between them is the
   * microphone path alone — which is the difference §10.6 wants isolated.
   */
  private lastAudibleSentAtMs = 0;
  private awaitingReplyFrom: number | null = null;
  /**
   * Set when the turn the far end just finished contained a hold cue by the
   * HARNESS's own reckoning (`LineSpec.holdCue`), and cleared the moment a hold
   * actually begins.
   *
   * That is the whole of §16.2's "measurable only by someone who knows no hold
   * occurred": if the cue was honest, `playHold` follows and nothing is charged;
   * if it was conversational filler — "let me check", said while still talking —
   * the agent's silence after it is the price of §6.3's eager list, and the
   * harness is the only party that knows which of the two happened.
   */
  private cuedWithoutHold = false;
  private mic: MicrophoneSource | null = null;
  private micOpening: Promise<MicrophoneSource> | null = null;

  constructor(
    readonly callId: string,
    private readonly far: FarEndSession,
    private readonly assets: AssetSource,
    private readonly control: ControlServer,
    recognizer: SpeechRecognizer | undefined,
    private readonly repMode: RepMode,
    private readonly openMicrophone: (() => MicrophoneSource) | undefined,
  ) {
    this.pacer = new Pacer((f) => {
      if (frameRms(f) >= AUDIBLE_RMS) this.lastAudibleSentAtMs = performance.now();
      far.sendAudio(f);
    });

    // DTMF is decoded from what the harness's speaker emits, not from what
    // arrives: a tone the core clear()ed from the queue was never heard, and a
    // tone with an underflow hole in it is heard WITH the hole (§4.4).
    const goertzel = createGoertzelDetector();
    far.onSpeaker((frame) => {
      const digit = goertzel.push(frame);
      if (digit !== null) for (const h of this.digitHandlers) h(digit);
      recognizer?.feed(frame);
      if (this.awaitingReplyFrom !== null && frameRms(frame) >= AUDIBLE_RMS) {
        const from = this.awaitingReplyFrom;
        this.awaitingReplyFrom = null;
        // The mode travels with every single figure, so two modes cannot be
        // pooled by accident later (§10.6). Prose asking an analyst not to
        // pool them would be a rule with no enforcement.
        const waited = Math.round(performance.now() - from);
        this.telemetry('perceived_response_ms', waited, this.repMode);
        if (this.cuedWithoutHold) {
          // Same interval, different question. `perceived_response_ms` asks how
          // responsive the agent is; this asks what §6.3's list cost on a turn
          // where the cue was filler. They are equal by construction on such a
          // turn, and saying so is better than inventing a second clock: the
          // COST is this figure against the same figure on turns with no cue,
          // which is why both are reported rather than one derived number.
          this.cuedWithoutHold = false;
          this.telemetry('agent_mute_during_conversation_ms', waited, this.repMode);
        }
      }
    });
    recognizer?.onUtterance((text) => {
      for (const h of this.speechHandlers) h(text);
    });
    // Reported once, first: every latency figure from this session belongs to
    // one mode, and §10.6 forbids pooling the two. A run whose mode has to be
    // inferred from which other metrics happen to appear is a run that will be
    // pooled by somebody.
    this.telemetry('rep_mode', repMode === 'HUMAN_REP' ? 1 : 0, repMode);

    far.onHangup(() => {
      this.closed = true;
      this.pacer.stop();
      recognizer?.close?.();
      void this.mic?.close();
      this.mic = null;
    });
  }

  onDigit(h: (d: string) => void): void {
    this.digitHandlers.push(h);
  }

  onSpokenChoice(h: (t: string) => void): void {
    this.speechHandlers.push(h);
  }

  /** Plays menu level `level`'s prompt, outside the navigator (for scripted scenarios). */
  async advance(level: number): Promise<void> {
    const menuLevel = MENU[level];
    if (!menuLevel) throw new Error(`menu has no level ${level}`);
    await this.speakAs(0, menuLevel.prompt);
  }

  async playHold(durationMs: number, silent: boolean): Promise<void> {
    // The far end spoke again — or started music — so whatever wait was being
    // timed ended without a reply, and timing it further would report the
    // harness's own next action as the agent's latency.
    this.awaitingReplyFrom = null;
    // A hold DID follow, so the cue was honest and the gate was right to close.
    this.cuedWithoutHold = false;
    const frames = Math.round(durationMs / FRAME_MS);
    if (silent) return this.pacer.play(Array.from({ length: frames }, silenceFrame));
    const music = this.assets.holdMusic();
    const out: Uint8Array[] = [];
    for (let i = 0; i < frames; i++) out.push(music[i % music.length]!);
    return this.pacer.play(out);
  }

  async speakAs(persona: number, lineId: LineId): Promise<void> {
    const role = PERSONA_ROLE[persona];
    // A line rendered in one role's voice, spoken as another persona, would make
    // the harness's party count (ADR-018) disagree with what was audible.
    if (role !== LINES[lineId].role) throw new Error(`${lineId} is a ${LINES[lineId].role} line; persona ${persona} is ${role ?? 'unknown'}`);
    this.awaitingReplyFrom = null;
    await this.pacer.play(this.assets.line(lineId));
    // Only a REPRESENTATIVE's line starts the clock. §7 defines the metric that
    // way, and it is the right way: after a menu prompt the agent replies with
    // DTMF, which is not what this number is about.
    if (role !== 'ivr') {
      if (lineAnnouncesHold(lineId)) this.cuedWithoutHold = true;
      this.armReplyWindow();
    }
  }

  /**
   * `HUMAN_REP` (§10.6): one turn from the live microphone, in place of an
   * asset. Resolves at the end of the turn, so a scripted scenario cannot tell
   * which mode it is running in — see microphone.ts for why that is the
   * contract §12.10 leaves open.
   */
  async streamMicrophone(persona: number): Promise<void> {
    const role = PERSONA_ROLE[persona];
    if (role === undefined || role === 'ivr') {
      // The IVR is a recording by definition (§10.2). A live voice reading menu
      // prompts would put a human turn into the fixture set labelled as an IVR
      // prompt, which is the one confusion the classifier is calibrated against.
      throw new Error(`streamMicrophone: persona ${persona} is ${role ?? 'unknown'}; only a representative can be live`);
    }
    const mic = await this.microphone();
    this.awaitingReplyFrom = null;
    const turn = micTurn({ source: mic, emit: (f) => void this.pacer.play([f]) });
    const result = await turn.done;

    this.telemetry('human_rep_turn_ms', Math.round(result.frames.length * FRAME_MS), result.endedBy);
    this.telemetry('mic_level_rms', Math.round(result.speechRms), `persona ${persona}`);
    if (result.frameDelaysMs.length > 0) {
      const sorted = [...result.frameDelaysMs].sort((a, b) => a - b);
      this.telemetry('mic_frame_delay_ms', Math.round(sorted[Math.floor(sorted.length / 2)]!), 'median');
      this.telemetry('mic_frame_delay_ms', Math.round(sorted[sorted.length - 1]!), 'max');
    }
    if (result.endedBy === 'no_onset') {
      // Nobody spoke. Reporting it is the point: a rehearsal where the
      // microphone was muted must not read as a call where the agent was slow.
      this.telemetry('human_rep_turn_missing', 1, `persona ${persona}`);
      return;
    }
    // The zero point is the last frame that had SPEECH in it, not the frame on
    // which the endpointer made up its mind: see TurnResult.lastSpeechAtMs.
    if (result.lastSpeechAtMs !== null) this.armReplyWindow(result.lastSpeechAtMs);
  }

  /**
   * One representative turn, in whichever way this session produces them.
   *
   * This is the substitution point §10.6 describes, and it is deliberately NOT
   * on the `HarnessSession` interface (§12.10): that interface already offers
   * both `speakAs` and `streamMicrophone`, and adding a third method that
   * chooses between them would change a documented interface to save the
   * scripts an `if`. The scripts are inside the harness; the interface is what
   * the core sees.
   *
   * `lineId` still matters in `HUMAN_REP`: it is what the person is reading, so
   * it is what the run reports having said.
   */
  async repSays(persona: number, lineId: LineId): Promise<void> {
    if (this.repMode === 'HUMAN_REP') {
      this.telemetry('human_rep_line', 1, lineId);
      await this.streamMicrophone(persona);
      return;
    }
    await this.speakAs(persona, lineId);
  }

  /** Opens the capture device once per session; every turn shares it. */
  private microphone(): Promise<MicrophoneSource> {
    if (this.mic) return Promise.resolve(this.mic);
    if (this.micOpening) return this.micOpening;
    if (this.repMode !== 'HUMAN_REP') {
      return Promise.reject(new Error(`streamMicrophone requires repMode HUMAN_REP; this session is ${this.repMode}`));
    }
    if (!this.openMicrophone) {
      return Promise.reject(new Error('repMode is HUMAN_REP but no microphone source is configured (HarnessOptions.microphone)'));
    }
    const source = this.openMicrophone();
    this.micOpening = source.open().then(() => {
      this.mic = source;
      this.micOpening = null;
      this.telemetry('mic_startup_latency_ms', Math.round(source.startupLatencyMs ?? 0), 'device open to first audio');
      return source;
    });
    return this.micOpening;
  }

  /**
   * Starts timing the agent's reply. Defaults to the last audible frame the
   * harness sent, which for a rendered line is the end of its audio.
   */
  private armReplyWindow(fromMs = this.lastAudibleSentAtMs): void {
    this.awaitingReplyFrom = fromMs;
  }

  swapParty(): void {
    this.partiesUsed++;
    this.telemetry('parties_used', this.partiesUsed);
  }

  async close(delayMs: number): Promise<void> {
    await new Promise((r) => setTimeout(r, delayMs));
    this.closed = true;
    this.pacer.stop();
    await this.mic?.close();
    this.mic = null;
    this.far.hangup();
  }

  telemetry(metric: string, value: number, detail?: string): void {
    this.control.report(this.callId, metric, value, detail);
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * The week-1 script: navigate the menu, then the first representative answers.
 * Input during a prompt interrupts it, as IVRs allow ("barge-in").
 */
async function runMenuScript(s: Session, navMode: HarnessNavMode, noInputMs: number, queueHoldMs: number): Promise<void> {
  const nav = new MenuNavigator();
  let noInput: NodeJS.Timeout | null = null;
  // Each action supersedes the one before: a digit that barges into a prompt
  // stops the pacer, and the interrupted action must not go on to its next line.
  let generation = 0;
  const cancelTimeout = () => {
    if (noInput) clearTimeout(noInput);
    noInput = null;
  };

  /**
   * Fires a `perform` that nobody awaits, and reports what it threw.
   *
   * `perform` is re-entered from two places that cannot await it — a digit
   * arriving and the no-input timer — and `void perform(...)` turned any failure
   * inside those into an unhandled rejection, which ends the process rather than
   * the call. The `.catch` on the initial `perform` only ever covered the first
   * one. Found in module 4.1, because HUMAN_REP with no device configured is the
   * first failure reachable from a digit; it was always reachable from a stale
   * asset (§10.2) and would have taken the harness down mid-rehearsal.
   */
  const fireAndReport = (action: MenuAction): void => {
    void perform(action).catch((err: unknown) => {
      s.telemetry('harness_error', 1, String(err));
    });
  };

  const perform = async (action: MenuAction): Promise<void> => {
    cancelTimeout();
    s.pacer.stop();
    const mine = ++generation;
    for (const line of action.lines) {
      if (s.isClosed || mine !== generation) return;
      await s.speakAs(0, line);
    }
    if (s.isClosed || mine !== generation) return;

    switch (action.kind) {
      case 'play':
        noInput = setTimeout(() => fireAndReport(nav.timeout()), noInputMs);
        return;
      case 'goodbye':
        s.telemetry('menu_abandoned', 1, nav.level.id);
        await s.close(0);
        return;
      case 'representative':
        s.telemetry('menu_completed', action.path.length, action.path.join('>'));
        if (queueHoldMs > 0) await s.playHold(queueHoldMs, false);
        if (s.isClosed) return;
        s.telemetry('parties_used', 1);
        await s.repSays(1, 'rep1_greeting');
        s.telemetry('rep_line_done', 1, 'rep1_greeting');
        return;
    }
  };

  let inMenu = true;
  const onChoice = (from: string, action: MenuAction, via: 'dtmf' | 'speech') => {
    if (!inMenu) return;
    // One report per level, when the level is left: 1 if the first input given
    // there was the one that moved on (§10.4 dtmf_decode_first_try).
    const left = action.kind === 'representative' || (action.kind === 'play' && action.level !== from);
    if (left) s.telemetry(via === 'dtmf' ? 'dtmf_decode_first_try' : 'speech_choice_first_try', action.firstTry ? 1 : 0, from);
    if (action.kind !== 'play') inMenu = false;
    fireAndReport(action);
  };

  if (navMode !== 'speech') s.onDigit((d) => onChoice(nav.level.id, nav.choose(d), 'dtmf'));
  if (navMode !== 'dtmf') s.onSpokenChoice((t) => onChoice(nav.level.id, nav.say(t), 'speech'));

  await perform(nav.start());
}

export class HarnessServer {
  private constructor(
    readonly server: http.Server,
    readonly endpoint: LoopbackEndpoint,
    readonly control: ControlServer,
    readonly sessions: Map<string, Session>,
  ) {}

  static async start(options: HarnessOptions): Promise<HarnessServer> {
    if (options.navMode !== 'dtmf' && !options.recognizer) {
      throw new Error(`navMode "${options.navMode}" needs a speech recognizer, and none is configured (see SpeechRecognizer in harness.ts)`);
    }

    const endpoint = LoopbackEndpoint.detached({
      profile: options.profile,
      ...(options.playoutDepthMs !== undefined ? { playoutDepthMs: options.playoutDepthMs } : {}),
    });
    const control = new ControlServer();
    const sessions = new Map<string, Session>();
    const pendingIds: string[] = [];
    let counter = 0;

    const server = http.createServer((_req, res) => {
      res.writeHead(426).end('WebSocket only: /call, /control');
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://harness');
      if (url.pathname === '/call') {
        pendingIds.push(url.searchParams.get('callId') ?? `harness-call-${++counter}`);
        endpoint.handleUpgrade(req, socket, head);
      } else if (url.pathname === '/control') {
        control.wss.handleUpgrade(req, socket, head, (ws) => control.wss.emit('connection', ws, req));
      } else {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      }
    });

    endpoint.onSession((far) => {
      const callId = pendingIds.shift() ?? `harness-call-${++counter}`;
      const session = new Session(callId, far, options.assets, control, options.recognizer?.(), options.repMode ?? 'BOT_REP', options.microphone);
      sessions.set(callId, session);
      void runMenuScript(session, options.navMode, options.noInputTimeoutMs ?? NO_INPUT_TIMEOUT_MS, options.queueHoldMs ?? 0).catch((err: unknown) => {
        session.telemetry('harness_error', 1, String(err));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host ?? '127.0.0.1', () => resolve());
    });
    return new HarnessServer(server, endpoint, control, sessions);
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  callUrl(callId?: string): string {
    return `ws://127.0.0.1:${this.port}/call${callId ? `?callId=${encodeURIComponent(callId)}` : ''}`;
  }

  controlUrl(): string {
    return `ws://127.0.0.1:${this.port}/control`;
  }

  async close(): Promise<void> {
    this.control.close();
    await this.endpoint.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
