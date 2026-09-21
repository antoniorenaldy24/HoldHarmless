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
import { LINES, type LineId, type Role } from './lines.js';
import { MENU, MenuNavigator, NO_INPUT_TIMEOUT_MS, type MenuAction } from './menu.js';
import { Pacer } from './pacer.js';

export type HarnessNavMode = 'dtmf' | 'speech' | 'both';

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
};

class Session implements HarnessSession {
  readonly pacer: Pacer;
  private readonly digitHandlers: ((d: string) => void)[] = [];
  private readonly speechHandlers: ((t: string) => void)[] = [];
  private partiesUsed = 1;
  private closed = false;

  constructor(
    readonly callId: string,
    private readonly far: FarEndSession,
    private readonly assets: AssetSource,
    private readonly control: ControlServer,
    recognizer: SpeechRecognizer | undefined,
  ) {
    this.pacer = new Pacer((f) => far.sendAudio(f));

    // DTMF is decoded from what reaches the harness's speaker, not from what
    // arrives: a tone the core clear()ed from the queue was never heard.
    const goertzel = createGoertzelDetector();
    far.onPlayed((frame) => {
      const digit = goertzel.push(frame);
      if (digit !== null) for (const h of this.digitHandlers) h(digit);
      recognizer?.feed(frame);
    });
    recognizer?.onUtterance((text) => {
      for (const h of this.speechHandlers) h(text);
    });
    far.onHangup(() => {
      this.closed = true;
      this.pacer.stop();
      recognizer?.close?.();
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
    await this.pacer.play(this.assets.line(lineId));
  }

  streamMicrophone(_persona: number): Promise<void> {
    return Promise.reject(new Error('HUMAN_REP (§10.6) is not built yet — week 2'));
  }

  swapParty(): void {
    this.partiesUsed++;
    this.telemetry('parties_used', this.partiesUsed);
  }

  async close(delayMs: number): Promise<void> {
    await new Promise((r) => setTimeout(r, delayMs));
    this.closed = true;
    this.pacer.stop();
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
        noInput = setTimeout(() => void perform(nav.timeout()), noInputMs);
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
        await s.speakAs(1, 'rep1_greeting');
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
    void perform(action);
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
      const session = new Session(callId, far, options.assets, control, options.recognizer?.());
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
