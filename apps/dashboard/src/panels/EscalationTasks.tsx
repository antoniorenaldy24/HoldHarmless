/**
 * Panel 8 — Escalation Tasks. SSOT §11, ADR-014, module 3.6.
 *
 * "Panel 8 is the destination ADR-014 depends on. An escalation with no
 * destination is not a handoff."
 *
 * This component decides nothing. Which escalations exist, what they say, and
 * what order they are worked in are read from the event log by
 * `escalationCards` in apps/core, which is where those rules are tested. What
 * is left here is the one command the dashboard is permitted to send (§11):
 * mark handled.
 *
 * TWO BUTTONS, BECAUSE THERE ARE TWO ENDINGS. "Mark handled" writes
 * `escalated_resolved` and the request is done. "Handled — call again" is the
 * only path by which a request leaves a final status (§9.1), and it is a human
 * saying so, never the system deciding it.
 *
 * A card with no summary is rendered as a card with no summary, in the same
 * colour as the rest. It means INV-9 was violated and somebody is still waiting
 * for a call back; hiding it would make the screen agree with the bug.
 */

import type { EscalationCard } from '@holdharmless/core/view';

export type EscalationTasksProps = {
  cards: readonly EscalationCard[];
  /** The one command this panel sends. `requeue` is the second button. */
  onMarkHandled: (requestId: string, requeue: boolean) => void;
};

const time = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
};

export function EscalationTasks({ cards, onMarkHandled }: EscalationTasksProps) {
  return (
    <section className="panel panel-8" aria-labelledby="panel-8-title">
      <h2 id="panel-8-title">
        Escalation Tasks
        <span className="count">{cards.filter((c) => !c.resolved).length} open</span>
      </h2>

      {cards.length === 0 ? (
        <p className="empty">No escalations. A call that needs a person appears here.</p>
      ) : (
        <ul className="cards">
          {cards.map((card) => (
            <li key={card.callId} className={card.resolved ? 'card resolved' : 'card'}>
              <header>
                <span className={card.urgency === 'EXPEDITED' ? 'urgency expedited' : 'urgency'}>{card.urgency}</span>
                <span className="req">{card.requestId}</span>
                <span className="when">{time(card.at)}</span>
                {card.attempts > 1 && <span className="attempts">attempt {card.attempts}</span>}
              </header>

              {card.summary ? (
                <p className="summary">{card.summary}</p>
              ) : (
                <p className="summary missing">
                  This escalation reached the log without a summary (INV-9). Someone is waiting for a call back and
                  the reason was not recorded — open the transcript for this call.
                </p>
              )}

              <dl className="facts">
                {card.reference && (
                  <>
                    <dt>Reference</dt>
                    <dd>{card.reference}</dd>
                  </>
                )}
                {card.authNumber && (
                  <>
                    <dt>Auth number</dt>
                    <dd>{card.authNumber}</dd>
                  </>
                )}
                {card.source && (
                  <>
                    <dt>Summary by</dt>
                    <dd>{card.source === 'model' ? 'the agent' : 'the deterministic path'}</dd>
                  </>
                )}
              </dl>

              {card.resolved ? (
                <p className="done">Handled</p>
              ) : (
                <div className="actions">
                  <button type="button" onClick={() => onMarkHandled(card.requestId, false)}>
                    Mark handled
                  </button>
                  <button type="button" className="secondary" onClick={() => onMarkHandled(card.requestId, true)}>
                    Handled — call again
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
