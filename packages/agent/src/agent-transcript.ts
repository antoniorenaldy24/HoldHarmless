/**
 * Agent-turn finalization — §7.6: "packages/agent therefore owns finalization."
 *
 * The API emits `transcript.agent` finals rarely (E2: 56 deltas, zero finals),
 * so the final that feeds onTurn and the disclosure detector is constructed
 * here. Three behaviors below go beyond what §7.6 specified, each forced by a
 * Day-0 log rather than by preference:
 *
 *  1. Buffers are keyed by reply_id, not reset on reply.started. In
 *     e-reply.CONTAMINATED.jsonl, where replies overlapped, one reply's deltas
 *     arrived AFTER its own reply.done and after the next reply.started. A single
 *     buffer reset on reply.started would have filed them under the wrong reply;
 *     a buffer emitted on reply.done would have been empty. Every delta carries
 *     its reply_id, so there is no need to infer ownership from order.
 *
 *  2. An API final, when one arrives, is used in preference to the deltas. In
 *     e-auth2-full.jsonl two replies had a final and ZERO deltas; built from
 *     deltas alone, "Please go ahead." would not exist.
 *
 *  3. Deltas are joined with a space when neither side of the join has one. In
 *     the contaminated run the deltas were "I ", "need", "to", "check"; joined
 *     naively that is "I needtocheck", and a disclosure spelled that way
 *     ("onbehalfof") would never match. Every delta observed is a whole word, so
 *     inserting a space cannot split one. If the API ever sends sub-word pieces
 *     this rule is wrong, and the disclosure detector's negative direction would
 *     be the one to suffer.
 *
 * Emission is exactly once per reply. A reply with no text at all — the usual
 * shape of a tool-call-only reply (28 of 59 in e-auth2-full) — emits nothing.
 */

export type AgentMessage =
  | { type: 'reply.started'; reply_id: string }
  | { type: 'transcript.agent.delta'; reply_id: string; delta: string }
  | { type: 'transcript.agent'; reply_id: string; text: string; interrupted?: boolean }
  | { type: 'reply.done'; reply_id: string; status: string };

export type AgentTurn = {
  replyId: string;
  text: string;
  /** Where the text came from — logged, so a disagreement is traceable. */
  source: 'api_final' | 'deltas';
  /** reply.done status; 'interrupted' turns are still emitted (§7.6). */
  status: string;
};

/** Material that arrived for a reply after its turn was already emitted. */
export type LateMaterial = { replyId: string; kind: 'delta' | 'final'; text: string };

export type Scheduler = (fn: () => void, ms: number) => () => void;

const realScheduler: Scheduler = (fn, ms) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

/** How long to wait after reply.done for text that has not yet arrived. */
export const LATE_TEXT_GRACE_MS = 4000;

type Pending = {
  deltas: string;
  apiFinal?: string;
  doneStatus?: string;
  cancelGrace?: () => void;
};

export function joinDelta(buffer: string, delta: string): string {
  if (buffer === '' || delta === '') return buffer + delta;
  const needsSpace = !/\s$/.test(buffer) && !/^\s/.test(delta);
  return needsSpace ? `${buffer} ${delta}` : buffer + delta;
}

export class AgentTranscriptAssembler {
  private readonly pending = new Map<string, Pending>();
  private readonly emitted = new Set<string>();

  constructor(
    private readonly onTurn: (turn: AgentTurn) => void,
    private readonly onLate: (late: LateMaterial) => void = () => {},
    private readonly schedule: Scheduler = realScheduler,
    private readonly graceMs: number = LATE_TEXT_GRACE_MS,
  ) {}

  handle(msg: AgentMessage): void {
    const id = msg.reply_id;

    if (this.emitted.has(id)) {
      if (msg.type === 'transcript.agent.delta') this.onLate({ replyId: id, kind: 'delta', text: msg.delta });
      if (msg.type === 'transcript.agent') this.onLate({ replyId: id, kind: 'final', text: msg.text });
      return;
    }

    const p = this.pendingFor(id);
    switch (msg.type) {
      case 'reply.started':
        return;
      case 'transcript.agent.delta':
        p.deltas = joinDelta(p.deltas, msg.delta);
        // Text is still arriving after reply.done: restart the wait.
        if (p.doneStatus !== undefined) this.armGrace(id, p);
        return;
      case 'transcript.agent':
        p.apiFinal = msg.text;
        // The API's own final is complete by definition; once the reply is also
        // done there is nothing left to wait for.
        if (p.doneStatus !== undefined) this.emit(id, p);
        return;
      case 'reply.done':
        p.doneStatus = msg.status;
        if (p.apiFinal !== undefined || p.deltas.trim() !== '') this.emit(id, p);
        else this.armGrace(id, p);
        return;
    }
  }

  /** Emits anything still held, e.g. when the session ends. */
  flush(): void {
    for (const [id, p] of this.pending) if (p.doneStatus !== undefined) this.emit(id, p);
  }

  private pendingFor(id: string): Pending {
    let p = this.pending.get(id);
    if (!p) this.pending.set(id, (p = { deltas: '' }));
    return p;
  }

  private armGrace(id: string, p: Pending): void {
    p.cancelGrace?.();
    p.cancelGrace = this.schedule(() => this.emit(id, p), this.graceMs);
  }

  private emit(id: string, p: Pending): void {
    p.cancelGrace?.();
    this.pending.delete(id);
    this.emitted.add(id);
    const fromApi = p.apiFinal !== undefined && p.apiFinal.trim() !== '';
    const text = (fromApi ? p.apiFinal! : p.deltas).trim();
    if (text === '') return; // a tool-call-only reply: no turn to report
    this.onTurn({ replyId: id, text, source: fromApi ? 'api_final' : 'deltas', status: p.doneStatus ?? 'unknown' });
  }
}
