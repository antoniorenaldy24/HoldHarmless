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
 */

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
  return (
    <main>
      <header>
        <h1>HoldHarmless</h1>
        <p className="sub">
          Dashboard shell · panels land in week 3 (§21 module 3.8)
        </p>
      </header>

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
