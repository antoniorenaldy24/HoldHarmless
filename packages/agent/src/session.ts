/**
 * The AssemblyAI session client — §12.6, ADR-022, §8.8, §15.
 *
 * Every wire shape here was observed, not assumed: Day-0 logs (E0, E2, E-AUTH,
 * E-REPLY) and the A-8 probe (scripts/a8-resume-probe.ts). Where the observed
 * behavior contradicts the documentation, the observed behavior wins and the
 * contradiction is recorded in the SSOT.
 *
 * THREE RULES THIS CLASS ENFORCES RATHER THAN DOCUMENTS
 *
 *  1. createReply refuses unless the gate is open, hold is not suspected, and no
 *     reply is outstanding (ADR-022). The Call Model is supposed to check first;
 *     checking again here makes INV-2 and INV-4 true by construction at the one
 *     place a reply can be requested, instead of at every caller.
 *  2. tool.result is sent only after reply.done, one per call_id, and discarded
 *     on an interrupted reply (§8.8).
 *  3. The session is ended with session.end, never by closing the socket (§15:
 *     a bare close is billed through the grace window).
 *
 * RECOVERY (§15), AS OBSERVED. The A-8 probe could not resume a session in any
 * form: the documented `{type:'session.resume', session_id}`, with and without
 * the undocumented `resume_token` that session.ready carries, after a TCP reset
 * and after a clean close, at gaps of 1.5-2.8 s — `session_not_found` every
 * time. So one resume attempt is made (it is documented and costs well under a
 * second), and on any failure the client opens a NEW session with the full
 * configuration and reports the context as lost; the Call Model then sets
 * pendingContextCorrection. The new-session path is therefore the one that
 * carries calls today, not a fallback.
 */

import type { GateIntent, ToolName } from '@holdharmless/events';
import { AgentTranscriptAssembler, type AgentMessage, type Scheduler } from './agent-transcript.js';

// ---------------------------------------------------------------------------
// Types — §12.6
// ---------------------------------------------------------------------------

export type TranscriptionMode = 'min_latency' | 'balanced' | 'max_accuracy';

export interface ToolDefinition {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SessionConfig {
  systemPrompt: string;
  tools: ToolDefinition[];
  transcriptionMode: TranscriptionMode;
  keyterms: string[];
  interruptResponse: boolean;
  /** Sent only when ENABLE_INTERRUPTION_DELAY (ADR-011). */
  interruptionDelayMs?: number;
}

export type InitialConfig = SessionConfig & {
  /** Lowercase and immutable (§7.1). */
  voice: string;
  inputFormat: 'audio/pcmu';
  outputFormat: 'audio/pcmu';
};

/** No hold probe (§6.7). */
export type ReplyCause = 'silence_recovery' | 'escalation_instruction';

/** What the Call Model knows and the session must respect (ADR-022). */
export type ReplyGuardState = { gateIntent: GateIntent; holdSuspected: boolean };

export type ConnectionState = 'lost' | 'restored' | 'context_lost' | 'failed';

export type ReplyRefusal = 'gate_not_open' | 'hold_suspected' | 'reply_outstanding' | 'not_connected';

export class ReplyRefused extends Error {
  constructor(readonly reason: ReplyRefusal) {
    super(`createReply refused: ${reason}`);
  }
}

export class SessionError extends Error {
  constructor(readonly code: string, message: string, readonly param?: string) {
    super(`${code}: ${message}`);
  }
}

/** Events this class reports for the log (§9.3); the core assigns seq. */
export type AgentEvent =
  | { t: 'reply.requested'; cause: ReplyCause; instructions?: string }
  | { t: 'tool.result_discarded'; toolCallId: string; name: ToolName }
  | { t: 'session.resumed'; sessionId: string; gapMs: number }
  | { t: 'session.replaced'; previousSessionId: string; sessionId: string; gapMs: number; reason: string };

/** The minimal WebSocket surface used, so tests can substitute a fake server. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  terminate?(): void;
  on(event: 'open', h: () => void): void;
  on(event: 'message', h: (data: unknown) => void): void;
  on(event: 'close', h: (code: number) => void): void;
  on(event: 'error', h: (err: Error) => void): void;
}
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export type AgentSessionOptions = {
  url: string;
  apiKey: string;
  socket: SocketFactory;
  /** Read at every createReply — never cached. */
  guard: () => ReplyGuardState;
  /** Whether the reply being generated was produced under a reached [[CLOSING]] (§7.6). */
  isClosing?: () => boolean;
  enableInterruptionDelay?: boolean;
  /** §15: 30 s. A gap longer than this skips the resume attempt. */
  resumeWindowMs?: number;
  /** Stop trying to reconnect after this long, and report 'failed'. */
  recoveryGiveUpMs?: number;
  /** How long to wait for any single server acknowledgement. */
  ackTimeoutMs?: number;
  now?: () => number;
  schedule?: Scheduler;
};

const OPEN = 1;

// ---------------------------------------------------------------------------
// Payloads — §7.1
// ---------------------------------------------------------------------------

function mutablePayload(c: Partial<SessionConfig>, enableDelay: boolean): Record<string, unknown> {
  const session: Record<string, unknown> = {};
  if (c.systemPrompt !== undefined) session['system_prompt'] = c.systemPrompt;
  // Each tool needs the "type": "function" discriminator (§7.1 point 1).
  if (c.tools !== undefined) session['tools'] = c.tools.map((t) => ({ type: 'function', ...t }));

  const input: Record<string, unknown> = {};
  if (c.transcriptionMode !== undefined) input['transcription_mode'] = c.transcriptionMode;
  if (c.keyterms !== undefined) input['keyterms'] = c.keyterms;
  const turn: Record<string, unknown> = {};
  if (c.interruptResponse !== undefined) turn['interrupt_response'] = c.interruptResponse;
  // Never min_silence / max_silence (ADR-009).
  if (enableDelay && c.interruptionDelayMs !== undefined) turn['interruption_delay'] = c.interruptionDelayMs;
  if (Object.keys(turn).length > 0) input['turn_detection'] = turn;
  if (Object.keys(input).length > 0) session['input'] = input;
  return session;
}

export function initialPayload(c: InitialConfig, enableDelay: boolean): Record<string, unknown> {
  if (c.voice !== c.voice.toLowerCase()) {
    // Uppercase raises session.error invalid_value (§7.1 point 3), and voice is
    // immutable, so the mistake would cost a whole session to discover.
    throw new Error(`voice "${c.voice}" must be lowercase`);
  }
  const session = mutablePayload(c, enableDelay);
  const input = (session['input'] as Record<string, unknown> | undefined) ?? {};
  input['format'] = { encoding: c.inputFormat, sample_rate: 8000 };
  session['input'] = input;
  session['output'] = { voice: c.voice, format: { encoding: c.outputFormat, sample_rate: 8000 } };
  // `greeting` is omitted entirely, never set to '' (§7.1 point 4).
  return session;
}

// ---------------------------------------------------------------------------

type Handlers = {
  delta: ((text: string) => void)[];
  turn: ((speaker: 'agent' | 'far_end', text: string, isClosing: boolean) => void)[];
  speech: (() => void)[];
  audio: ((bytes: Uint8Array) => void)[];
  replyStarted: (() => void)[];
  replyDone: ((status: 'completed' | 'interrupted') => void)[];
  tool: ((callId: string, name: ToolName, args: unknown) => void)[];
  event: ((e: AgentEvent) => void)[];
  connection: ((state: ConnectionState) => void)[];
};

export class AgentSession {
  private ws: SocketLike | null = null;
  private id: string | undefined;
  private initial: InitialConfig | null = null;
  /** The configuration currently in force: initial, plus every update since. */
  private current: InitialConfig | null = null;
  private ending = false;
  private recovering = false;

  /** A reply.create sent and not yet started, or a reply between started and done. */
  private replyOutstanding = false;
  private replyActive = false;
  private readonly toolNames = new Map<string, ToolName>();
  private pendingResults: { callId: string; result: unknown; isError: boolean }[] = [];
  private readonly assembler: AgentTranscriptAssembler;

  private readonly h: Handlers = { delta: [], turn: [], speech: [], audio: [], replyStarted: [], replyDone: [], tool: [], event: [], connection: [] };
  private waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void }[] = [];
  private droppedFrames = 0;

  constructor(private readonly opts: AgentSessionOptions) {
    this.assembler = new AgentTranscriptAssembler(
      (turn) => {
        const closing = this.opts.isClosing?.() ?? false;
        for (const f of this.h.turn) f('agent', turn.text, closing);
      },
      () => {},
      opts.schedule,
    );
  }

  // --- handlers -----------------------------------------------------------

  onTranscriptDelta(f: (text: string) => void): void { this.h.delta.push(f); }
  onTurn(f: (speaker: 'agent' | 'far_end', text: string, isClosing: boolean) => void): void { this.h.turn.push(f); }
  onSpeechStarted(f: () => void): void { this.h.speech.push(f); }
  /** μ-law bytes as received; framing into 20 ms is the Audio Bridge's job. */
  onReplyAudio(f: (bytes: Uint8Array) => void): void { this.h.audio.push(f); }
  onReplyStarted(f: () => void): void { this.h.replyStarted.push(f); }
  onReplyDone(f: (status: 'completed' | 'interrupted') => void): void { this.h.replyDone.push(f); }
  onToolCall(f: (callId: string, name: ToolName, args: unknown) => void): void { this.h.tool.push(f); }
  onEvent(f: (e: AgentEvent) => void): void { this.h.event.push(f); }
  /**
   * 'lost': the socket dropped. The Call Model must force holdSuspected until
   * 'restored' or 'context_lost' (§15 step 4) — that closes the gate by derivation.
   * 'context_lost': a new session replaced the old one; set pendingContextCorrection.
   * 'failed': recovery gave up (RECOVERY_GIVE_UP_MS); the call cannot continue.
   */
  onConnection(f: (state: ConnectionState) => void): void { this.h.connection.push(f); }

  sessionId(): string | undefined { return this.id; }
  framesDroppedWhileDisconnected(): number { return this.droppedFrames; }

  // --- lifecycle ----------------------------------------------------------

  async connect(initial: InitialConfig): Promise<void> {
    const payload = initialPayload(initial, this.opts.enableInterruptionDelay ?? false);
    this.initial = initial;
    this.current = { ...initial };
    await this.open();
    this.send({ type: 'session.update', session: payload });
    const ready = await this.waitFor((m) => m['type'] === 'session.ready');
    this.id = String(ready['session_id']);
  }

  /** Mutable fields only. Resolves on session.updated; rejects on session.error. */
  async update(config: Partial<SessionConfig>): Promise<void> {
    if (!this.current) throw new Error('update before connect');
    Object.assign(this.current, config);
    this.send({ type: 'session.update', session: mutablePayload(config, this.opts.enableInterruptionDelay ?? false) });
    await this.waitFor((m) => m['type'] === 'session.updated');
  }

  /** ADR-022. Refuses — never queues — when any condition fails. */
  async createReply(cause: ReplyCause, oneShotInstructions?: string): Promise<void> {
    const g = this.opts.guard();
    if (!this.ws || this.ws.readyState !== OPEN || this.recovering) throw new ReplyRefused('not_connected');
    if (g.gateIntent !== 'open') throw new ReplyRefused('gate_not_open');
    if (g.holdSuspected) throw new ReplyRefused('hold_suspected');
    // The server QUEUES a reply.create sent during a reply (E-REPLY): a second
    // call buys a second utterance, not a faster one.
    if (this.replyOutstanding || this.replyActive) throw new ReplyRefused('reply_outstanding');

    this.replyOutstanding = true;
    this.emit({ t: 'reply.requested', cause, ...(oneShotInstructions !== undefined ? { instructions: oneShotInstructions } : {}) });
    this.send({ type: 'reply.create', ...(oneShotInstructions !== undefined ? { instructions: oneShotInstructions } : {}) });
  }

  sendAudio(mulawFrame: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== OPEN || this.recovering) {
      this.droppedFrames++;
      return;
    }
    this.ws.send(JSON.stringify({ type: 'input.audio', audio: Buffer.from(mulawFrame).toString('base64') }));
  }

  /**
   * §8.8. Held until reply.done. A result queued AFTER its turn's reply.done
   * (a slow handler) is sent at once if no reply is active — the model is
   * waiting on it — and otherwise held for the next reply.done.
   */
  queueToolResult(callId: string, result: unknown, isError = false): void {
    this.pendingResults.push({ callId, result, isError });
    if (!this.replyActive && !this.replyOutstanding) this.flushResults();
  }

  /**
   * session.end, then close — never a bare close (§15). Called during recovery,
   * it stops the loop; a session the loop was opening at that moment is ended
   * by the loop as soon as it opens.
   */
  async end(): Promise<void> {
    this.ending = true;
    await this.endSocket();
    this.assembler.flush();
  }

  private async endSocket(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    this.send({ type: 'session.end' });
    await this.waitFor((m) => m['type'] === 'session.ended').catch(() => undefined);
    ws.close(1000);
  }

  /**
   * §12.6 names resume(sessionId) as a method. It is driven internally on a
   * drop; exposed for completeness and for a caller that stored the id itself.
   */
  async resume(sessionId: string): Promise<void> {
    await this.open();
    this.send({ type: 'session.resume', session_id: sessionId });
    const ready = await this.waitFor((m) => m['type'] === 'session.ready');
    this.id = String(ready['session_id']);
  }

  // --- internals ----------------------------------------------------------

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.opts.socket(this.opts.url, { Authorization: `Bearer ${this.opts.apiKey}` });
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.ws = ws;
        resolve();
      });
      ws.on('error', (err) => {
        if (!opened) reject(err);
      });
      ws.on('message', (data) => this.onMessage(ws, data));
      ws.on('close', () => this.onClose(ws));
    });
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== OPEN) throw new Error(`cannot send ${String(msg['type'])}: not connected`);
    this.ws.send(JSON.stringify(msg));
  }

  private emit(e: AgentEvent): void {
    for (const f of this.h.event) f(e);
  }

  private waitFor(pred: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const ms = this.opts.ackTimeoutMs ?? 8000;
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`timed out after ${ms} ms`));
        }
      }, ms);
    });
  }

  private onMessage(from: SocketLike, data: unknown): void {
    if (from !== this.ws) return; // a superseded socket's late traffic
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(m['type']);

    if (type === 'session.error') {
      // An error answers whichever request is waiting: settle the oldest waiter.
      const w = this.waiters.shift();
      const err = new SessionError(String(m['code']), String(m['message'] ?? ''), m['param'] ? String(m['param']) : undefined);
      if (w) w.reject(err);
      return;
    }
    for (const w of [...this.waiters]) {
      if (w.pred(m)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }

    switch (type) {
      case 'transcript.user.delta':
        for (const f of this.h.delta) f(String(m['delta'] ?? m['text'] ?? ''));
        return;
      case 'transcript.user':
        for (const f of this.h.turn) f('far_end', String(m['text'] ?? ''), false);
        return;
      case 'input.speech.started':
        for (const f of this.h.speech) f();
        return;
      case 'reply.audio':
        for (const f of this.h.audio) f(Uint8Array.from(Buffer.from(String(m['data'] ?? ''), 'base64')));
        return;
      case 'reply.started':
        this.replyOutstanding = false;
        this.replyActive = true;
        this.assembler.handle(m as unknown as AgentMessage);
        for (const f of this.h.replyStarted) f();
        return;
      case 'transcript.agent.delta':
      case 'transcript.agent':
        this.assembler.handle(m as unknown as AgentMessage);
        return;
      case 'reply.done': {
        this.replyActive = false;
        this.replyOutstanding = false;
        const status = m['status'] === 'interrupted' ? 'interrupted' : 'completed';
        this.assembler.handle(m as unknown as AgentMessage);
        if (status === 'interrupted') this.discardResults();
        else this.flushResults();
        for (const f of this.h.replyDone) f(status);
        return;
      }
      case 'tool.call': {
        const callId = String(m['call_id']);
        const name = String(m['name']) as ToolName;
        this.toolNames.set(callId, name);
        for (const f of this.h.tool) f(callId, name, m['arguments']);
        return;
      }
    }
  }

  private flushResults(): void {
    const results = this.pendingResults;
    this.pendingResults = [];
    for (const r of results) {
      // `result` is a JSON STRING on the wire, not an object (§12.6, E-AUTH).
      this.send({ type: 'tool.result', call_id: r.callId, result: JSON.stringify(r.result), is_error: r.isError });
    }
  }

  private discardResults(): void {
    const results = this.pendingResults;
    this.pendingResults = [];
    // Side effects are kept; only the messages die with the turn (§8.8 rule 3).
    for (const r of results) this.emit({ t: 'tool.result_discarded', toolCallId: r.callId, name: this.toolNames.get(r.callId) ?? ('unknown' as ToolName) });
  }

  private onClose(ws: SocketLike): void {
    if (ws !== this.ws) return;
    for (const w of this.waiters.splice(0)) w.reject(new Error('socket closed'));
    // A refused resume is answered with session.error AND a close (1008). The
    // recovery loop already owns that socket; starting another would recurse.
    if (this.ending || !this.initial || this.recovering) return;
    void this.recover();
  }

  /**
   * §15, as observed by A-8. Retries until connected or RECOVERY_GIVE_UP_MS:
   * inside the resume window each attempt tries resume first; outside it, or
   * after resume is refused, it opens a new session with the full configuration.
   */
  private async recover(): Promise<void> {
    const now = this.opts.now ?? Date.now;
    const droppedAt = now();
    const previous = this.id;
    this.recovering = true;
    this.ws = null;
    // Whatever turn was in flight died with the socket.
    this.replyActive = false;
    this.replyOutstanding = false;
    this.discardResults();
    this.assembler.flush();
    for (const f of this.h.connection) f('lost');

    const window = this.opts.resumeWindowMs ?? 30_000;
    const giveUp = this.opts.recoveryGiveUpMs ?? 120_000;
    let resumeRefused = false;
    let reason = 'beyond_window';
    let backoff = 250;

    while (!this.ending) {
      const elapsed = now() - droppedAt;
      if (elapsed > giveUp) break;
      try {
        if (previous && !resumeRefused && elapsed < window) {
          try {
            await this.resume(previous);
            if (this.ending) {
              this.recovering = false;
              await this.endSocket();
              return;
            }
            // Documented as unnecessary; harmless if so, and §15 step 3 requires it.
            await this.update(this.mutableCurrent());
            this.recovering = false;
            this.emit({ t: 'session.resumed', sessionId: this.id!, gapMs: now() - droppedAt });
            for (const f of this.h.connection) f('restored');
            return;
          } catch (e) {
            if (!(e instanceof SessionError)) throw e; // could not reach the server: retry
            // Refused (A-8: session_not_found, every time). Do not ask again.
            resumeRefused = true;
            reason = e.code;
            this.closeQuietly();
          }
        }
        // A NEW session, with the FULL configuration, immutable fields included.
        await this.connect(this.current!);
        this.recovering = false;
        if (this.ending) {
          // end() was called while this session was being opened. Close it
          // properly: a session nobody ends is billed until it times out (§15).
          await this.endSocket();
          return;
        }
        this.emit({ t: 'session.replaced', previousSessionId: previous ?? '', sessionId: this.id!, gapMs: now() - droppedAt, reason });
        for (const f of this.h.connection) f('context_lost');
        return;
      } catch {
        this.closeQuietly();
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 5000);
      }
    }
    this.recovering = false;
    for (const f of this.h.connection) f('failed');
  }

  private closeQuietly(): void {
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000);
    } catch {
      /* already closed */
    }
  }

  private mutableCurrent(): Partial<SessionConfig> {
    const { voice: _v, inputFormat: _i, outputFormat: _o, ...mutable } = this.current!;
    return mutable;
  }
}

