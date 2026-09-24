/**
 * Panel 8's cards, projected from the event log — §11, ADR-014, module 3.6.
 *
 * "Panel 8 is the destination ADR-014 depends on. An escalation with no
 * destination is not a handoff." The dashboard holds no state (§11), so a card
 * is not a record anyone writes: it is a reading of the log, and this file is
 * the only place that reading is defined.
 *
 * TWO SOURCES, ONE CARD. A call reaches a human two ways. The model calls
 * `escalate_to_human`, or §8.6's deterministic path writes the summary without
 * asking the model — a read-back limit, a phase timeout, an auth-number
 * mismatch, none of which may ask the model anything. Both emit
 * `escalation.summary`, which is why that event was added in v1.3; a projection
 * keyed on the tool call alone would show a blank panel for exactly the
 * escalations that matter most.
 *
 * A CARD WITH NO SUMMARY IS STILL A CARD. If `escalate_to_human` was called and
 * no summary reached the log, INV-9 is violated, and the honest thing to show
 * is a card that says so. Dropping it would make the panel agree with the bug:
 * a person needing a call back, and nothing on screen.
 */

import type { AuthRequestStatus, CallEvent } from '@holdharmless/events';

export type EscalationCard = {
  callId: string;
  requestId: string;
  /** When the escalation was recorded, from the event that recorded it. */
  at: string;
  urgency: 'EXPEDITED' | 'Routine';
  /** Who wrote the summary, or undefined when nothing did (INV-9). */
  source?: 'model' | 'deterministic';
  summary?: string;
  /** The last reference captured for this REQUEST, on this call or an earlier one. */
  reference?: string;
  /** The number under discussion, when one was captured. */
  authNumber?: string;
  attempts: number;
  resolved: boolean;
};

export type EscalationTaskDeps = {
  /** The request's status now. `escalated_resolved` is what "mark handled" writes. */
  statusOf: (requestId: string) => AuthRequestStatus | undefined;
};

/**
 * ORDER IS PART OF THE PANEL. Unhandled before handled, expedited before
 * routine, newest first inside each group: a list that buries the urgent
 * unhandled task under yesterday's resolved ones is a list nobody works from.
 */
function compare(a: EscalationCard, b: EscalationCard): number {
  if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
  if (a.urgency !== b.urgency) return a.urgency === 'EXPEDITED' ? -1 : 1;
  return a.at < b.at ? 1 : a.at > b.at ? -1 : 0;
}

export function escalationCards(events: readonly CallEvent[], deps: EscalationTaskDeps): EscalationCard[] {
  const requestOf = new Map<string, string>();
  const attemptsOf = new Map<string, number>();
  const priorityOf = new Map<string, string>();
  /** Keyed by REQUEST: a reference given on the dropped call still helps here. */
  const referenceOf = new Map<string, string>();
  const authOf = new Map<string, string>();
  const cards = new Map<string, EscalationCard>();

  for (const e of events) {
    if (e.t === 'call.started') {
      requestOf.set(e.callId, e.requestId);
      attemptsOf.set(e.callId, e.attempts);
      priorityOf.set(e.callId, e.priority);
      continue;
    }
    const requestId = requestOf.get(e.callId);

    if (e.t === 'reference.captured' && requestId) referenceOf.set(requestId, e.reference);
    if (e.t === 'auth_number.captured' && requestId) authOf.set(requestId, e.value);

    const escalating =
      e.t === 'escalation.summary' ||
      (e.t === 'tool.called' && e.name === 'escalate_to_human');
    if (!escalating) continue;

    const card: EscalationCard = cards.get(e.callId) ?? {
      callId: e.callId,
      requestId: requestId ?? 'unknown',
      at: e.at,
      // Without a summary the urgency still has to come from somewhere, and the
      // request's own priority is the same fact §8.6 renders into `[URGENCY]`.
      urgency: priorityOf.get(e.callId) === 'expedited' ? 'EXPEDITED' : 'Routine',
      attempts: attemptsOf.get(e.callId) ?? 0,
      resolved: false,
    };

    if (e.t === 'escalation.summary') {
      // A later summary replaces an earlier one: §8.6's tier 2 rewrites a model
      // summary INV-9 rejected, and the rewrite is the one to act on.
      card.source = e.source;
      card.summary = e.summary;
      card.urgency = e.urgency;
      card.at = e.at;
    }
    cards.set(e.callId, card);
  }

  return [...cards.values()]
    .map((card) => ({
      ...card,
      ...(referenceOf.has(card.requestId) ? { reference: referenceOf.get(card.requestId)! } : {}),
      ...(authOf.has(card.requestId) ? { authNumber: authOf.get(card.requestId)! } : {}),
      resolved: deps.statusOf(card.requestId) === 'escalated_resolved',
    }))
    .sort(compare);
}
