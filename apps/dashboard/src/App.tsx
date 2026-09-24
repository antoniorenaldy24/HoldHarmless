/**
 * Dashboard shell — SSOT §11.
 *
 * Deliberately empty. The eight panels are module 3.8 in the build order (§21,
 * week 3) and are not written until the event log they read actually exists.
 * This file exists so the framework decision is settled and Day 0 is not held up
 * by it.
 *
 * The one rule that governs everything added here: the dashboard is a READER.
 * It holds no state and sends no commands, except the demo controls in §19.3 and
 * "mark handled" on panel 8. Anything else belongs in the core.
 *
 * PANEL 8 LANDED EARLY, in module 3.6, because it is the destination ADR-014
 * depends on and the Work Queue module is where that destination is owed. The
 * event feed is module 3.8, so the cards below come from a SAMPLE, and the
 * screen says so in as many words. A dashboard that shows invented data without
 * labelling it is worse than one that shows nothing.
 */

import { useState } from 'react';
import type { EscalationCard } from '@holdharmless/core';
import { EscalationTasks } from './panels/EscalationTasks.js';

/** Not live data. Shaped exactly as escalationCards() returns it. */
const SAMPLE: EscalationCard[] = [
  {
    callId: 'CALL-8821', requestId: 'SYN-REQ-14', at: new Date().toISOString(),
    urgency: 'EXPEDITED', source: 'deterministic', attempts: 2, resolved: false,
    reference: 'REF-99', authNumber: 'A472-91',
    summary: 'EXPEDITED. Read-back failed three times; the representative gave a different number each time. GIVEN: member ID, date of birth, CPT. ASKED: "is this the induction or the maintenance dose?" NEXT: clinical staff need to call back.',
  },
  {
    callId: 'CALL-8817', requestId: 'SYN-REQ-09', at: new Date(Date.now() - 3_600_000).toISOString(),
    urgency: 'Routine', attempts: 1, resolved: false,
  },
  {
    callId: 'CALL-8802', requestId: 'SYN-REQ-02', at: new Date(Date.now() - 7_200_000).toISOString(),
    urgency: 'Routine', source: 'model', attempts: 1, resolved: true,
    summary: 'Routine. The plan requires a peer-to-peer review before this code is authorized.',
  },
];

const PANELS = [
  { n: 1, name: 'Queue', note: 'All requests with full status, expedited first' },
  { n: 2, name: 'Active call', note: 'channel and phase as TWO separate indicators' },
  { n: 3, name: 'Classifier', note: 'Three acoustic bars with tier, three semantic bars' },
  { n: 4, name: 'Gate', note: 'gateIntent timeline OVERLAID on the channel timeline' },
  { n: 5, name: 'Transcript', note: 'Two columns, barge-in / hedge / closing markers' },
  { n: 6, name: 'Tool calls', note: 'Latency; rejections in red; discarded results marked' },
  { n: 7, name: 'Compliance and cost', note: 'disclosure_delivered_per_party vs parties_used' },
  { n: 8, name: 'Escalation Tasks', note: 'context_summary + "mark handled" -> escalated_resolved' },
] as const;

export default function App() {
  const [cards, setCards] = useState<EscalationCard[]>(SAMPLE);
  const [showSample, setShowSample] = useState(true);

  // Module 3.8 replaces this with the one command §11 permits, sent to the
  // core, which calls WorkQueue.markEscalationHandled. Until the feed exists,
  // the button does locally what that write would do, so the interaction is
  // real even though the data is not.
  const onMarkHandled = (requestId: string, requeue: boolean) => {
    setCards((current) =>
      requeue
        ? current.filter((c) => c.requestId !== requestId)
        : current.map((c) => (c.requestId === requestId ? { ...c, resolved: true } : c)),
    );
  };

  return (
    <main>
      <header>
        <h1>HoldHarmless</h1>
        <p className="sub">
          Dashboard shell · panels land in week 3 (§21 module 3.8)
        </p>
      </header>

      <section className="sample-note">
        <label>
          <input type="checkbox" checked={showSample} onChange={(e) => setShowSample(e.target.checked)} />
          Show panel 8 with <strong>sample data</strong> — not a live call. The event feed is module 3.8.
        </label>
      </section>

      <EscalationTasks cards={showSample ? cards : []} onMarkHandled={onMarkHandled} />

      <ul className="panels">
        {PANELS.map((p) => (
          <li key={p.n}>
            <span className="num">{p.n}</span>
            <div>
              <strong>{p.name}</strong>
              <span className="note">{p.note}</span>
            </div>
          </li>
        ))}
      </ul>

      <footer>
        <p>
          Panel 4 is the one that earns its place: the gate timeline drawn over the
          channel timeline makes the interval where the gate is closed and the
          channel has not yet moved <em>directly visible</em>. That interval is
          ADR-007, and it is the argument.
        </p>
        <p className="profile">
          Every panel carries the network profile in force — INV-16 refuses a figure
          produced under CLEAN.
        </p>
      </footer>
    </main>
  );
}
