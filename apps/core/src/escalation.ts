/**
 * Escalation summaries and the closing sequence — §8.6, ADR-014, ADR-015,
 * INV-9, INV-20, module 3.4.
 *
 * FIVE PATHS REACH AN ESCALATION AND ALL FIVE MUST LEAVE A SUMMARY. Only one of
 * them is written by the model; the other four are written here, from the event
 * log, because nobody else holds the conversation. A path that escalated
 * without a summary is a task on the dashboard that nobody can act on — which
 * is why INV-9 checks the LOG rather than the tool's parameters.
 *
 * `[URGENCY]` IS MANDATORY ON BOTH PATHS. It is the first sentence and it is
 * exactly "EXPEDITED." or "Routine.", because whoever picks the task up decides
 * what to do next from that word before reading anything else.
 *
 * THE OUTCOME IS WRITTEN BEFORE THE CLOSING IS SPOKEN (ADR-015). A conversational
 * closing is the social signal to hang up; anything the system still needs after
 * it races the other party's hand toward the receiver. Losing that race turns a
 * successful call into a recorded failure that gets redialed — the duplicate
 * request this product exists to prevent.
 */

import type { AuthRequest, CallEvent, CallEventBody } from '@holdharmless/events';

export type EscalationCause =
  | 'escalate_to_human'      // the model called the tool
  | 'readback_limit'         // readbackAttempts reached 3
  | 'readback_reprompt'      // the §5.7 re-prompt limit in READBACK
  | 'exchange_timeout'       // the §5.4 phase timeout
  | 'auth_number_mismatch';  // §8.2, always deterministic

/** §8.6: the three cases that never wait for the model. */
export const ALWAYS_DETERMINISTIC: readonly EscalationCause[] = ['exchange_timeout', 'auth_number_mismatch'];

export type Urgency = 'EXPEDITED' | 'Routine';

export const urgencyOf = (request: Pick<AuthRequest, 'priority'>): Urgency =>
  request.priority === 'expedited' ? 'EXPEDITED' : 'Routine';

const CAUSE_SENTENCE: Readonly<Record<EscalationCause, string>> = {
  escalate_to_human: 'The representative raised a question beyond the approved clinical summary.',
  readback_limit: 'The authorization number failed read-back three times.',
  readback_reprompt: 'The representative did not confirm the authorization number after repeated read-backs.',
  exchange_timeout: 'The call spent its whole exchange budget without reaching an authorization number.',
  auth_number_mismatch: 'The recorded authorization number did not match the number captured on the call.',
};

/**
 * §8.6's required content, in order. Missing sections are omitted rather than
 * padded: a template that always fills every line teaches its reader to skim.
 */
export function buildEscalationSummary(input: {
  cause: EscalationCause;
  request: AuthRequest;
  log: readonly CallEvent[];
}): { summary: string; urgency: Urgency } {
  const { cause, request, log } = input;
  const urgency = urgencyOf(request);
  const parts: string[] = [`${urgency}.`, CAUSE_SENTENCE[cause]];

  // [GIVEN] — what was actually read aloud, from tool.returned rather than from
  // what the prompt intended to give.
  const given = new Set<string>();
  for (const e of log) {
    if (e.t !== 'tool.returned' || e.name !== 'get_auth_request') continue;
    const fields = (e.result as { fields?: Record<string, unknown> } | undefined)?.fields;
    for (const key of Object.keys(fields ?? {})) given.add(key.replace(/_/g, ' '));
  }
  if (given.size > 0) parts.push(`Already given: ${[...given].join(', ')}.`);

  // [ASKED] — the representative's last turn, verbatim.
  const asked = [...log].reverse().find((e) => e.t === 'turn.transcribed' && e.speaker === 'far_end');
  if (asked && asked.t === 'turn.transcribed' && asked.text.trim() !== '') {
    parts.push(`They asked: "${asked.text.trim()}"`);
  }

  // [HISTORY] — read-back paths only: every attempt and what was heard.
  if (cause === 'readback_limit' || cause === 'readback_reprompt' || cause === 'auth_number_mismatch') {
    const attempts: string[] = [];
    for (const e of log) {
      if (e.t === 'auth_number.captured') attempts.push(`captured ${e.value}`);
      if (e.t === 'tool.called' && e.name === 'confirm_readback') {
        const args = e.args as { matched?: unknown; corrected_value?: unknown };
        attempts.push(args.matched === true ? 'confirmed' : `corrected to ${String(args.corrected_value ?? 'nothing')}`);
      }
    }
    if (attempts.length > 0) parts.push(`Read-back history: ${attempts.join('; ')}.`);
  }

  // [REFERENCE]
  if (request.lastReference) parts.push(`Reference ${request.lastReference}.`);

  // [NEXT]
  parts.push(`Clinical staff need to call back on ${request.clinicCallbackPhone}.`);

  return { summary: parts.join(' '), urgency };
}

/**
 * §8.1's content rules for a summary, whoever wrote it. Returns the problems,
 * empty when the summary is acceptable. INV-9 uses this against the log.
 */
export function escalationSummaryProblems(summary: string, urgency: Urgency): string[] {
  const problems: string[] = [];
  const trimmed = summary.trim();
  if (trimmed.length < 40) problems.push('context_summary must be at least 40 characters');
  // The first sentence is exactly "EXPEDITED." or "Routine.", capitalized and
  // ending in a period — the one thing its reader acts on first.
  const first = trimmed.split(/(?<=\.)\s/)[0] ?? '';
  if (first !== `${urgency}.`) {
    problems.push(`the first sentence must be exactly "${urgency}." (it was ${JSON.stringify(first)})`);
  }
  if (!/call back/i.test(trimmed)) problems.push('the summary must say what needs to happen next');
  return problems;
}

/** INV-9's question, asked of the log: is there a summary to act on? */
export function escalationEvidencedIn(log: readonly CallEvent[], urgency: Urgency): boolean {
  return log.some((e) => e.t === 'escalation.summary' && e.urgency === urgency && escalationSummaryProblems(e.summary, urgency).length === 0);
}

// ---------------------------------------------------------------------------
// The three-tier procedure (§8.6)
// ---------------------------------------------------------------------------

export type EscalationOptions = {
  request: AuthRequest;
  log: () => readonly CallEvent[];
  emit: (event: CallEventBody) => void;
  /**
   * Tier 1: ask the model to write the summary itself. Returns false when the
   * reply could not be requested — a closed gate, a suspected hold (ADR-022) —
   * in which case the deterministic path runs immediately rather than waiting
   * for a turn that will never come.
   */
  requestModelSummary: (instruction: string) => boolean;
};

export interface EscalationCoordinator {
  /** Starts the procedure for a cause. Returns the tier that produced the summary. */
  begin(cause: EscalationCause): 'model_requested' | 'deterministic';
  /** The model called escalate_to_human. Returns false when the summary is unusable. */
  onModelSummary(summary: string): boolean;
  /** One turn has passed. Tier 2: write the summary ourselves if the model did not. */
  onTurnComplete(): void;
  readonly pending: boolean;
}

export const ONE_SHOT_INSTRUCTION =
  'Call escalate_to_human now. In context_summary, start with exactly "EXPEDITED." or "Routine.", then say what data you already gave, what they asked for, and what needs to happen next.';

export function createEscalationCoordinator(options: EscalationOptions): EscalationCoordinator {
  const urgency = urgencyOf(options.request);
  let pendingCause: EscalationCause | null = null;

  const writeDeterministic = (cause: EscalationCause): void => {
    const { summary } = buildEscalationSummary({ cause, request: options.request, log: options.log() });
    options.emit({ t: 'escalation.summary', source: 'deterministic', urgency, summary });
    pendingCause = null;
  };

  return {
    get pending() {
      return pendingCause !== null;
    },

    begin(cause: EscalationCause): 'model_requested' | 'deterministic' {
      // Mismatch and phase timeout never ask the model (§8.6). A mismatch means
      // the model's own account of the number is already in doubt; asking it to
      // summarize would be asking the unreliable witness to write the report.
      if (ALWAYS_DETERMINISTIC.includes(cause)) {
        writeDeterministic(cause);
        return 'deterministic';
      }
      pendingCause = cause;
      if (!options.requestModelSummary(ONE_SHOT_INSTRUCTION)) {
        writeDeterministic(cause);
        return 'deterministic';
      }
      return 'model_requested';
    },

    onModelSummary(summary: string): boolean {
      const problems = escalationSummaryProblems(summary, urgency);
      if (problems.length > 0) {
        // The model answered, but not usably. Tier 2 applies now rather than
        // after another turn: the log would otherwise hold a summary that
        // INV-9 rejects, which is worse than none.
        if (pendingCause) writeDeterministic(pendingCause);
        return false;
      }
      options.emit({ t: 'escalation.summary', source: 'model', urgency, summary });
      pendingCause = null;
      return true;
    },

    onTurnComplete(): void {
      // Tier 2: one turn, no summary, so the Call Model writes it (§8.6).
      if (pendingCause) writeDeterministic(pendingCause);
    },
  };
}
