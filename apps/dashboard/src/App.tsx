/**
 * The dashboard — SSOT §11, module 3.8.
 *
 * Eight panels, all of them reading one event log. The dashboard is a READER:
 * it holds no state and sends no commands, except the demo controls in §19.3
 * and "mark handled" on panel 8. Everything it draws is derived by
 * `dashboardView` in apps/core — the same derivation the invariant checker
 * audits — so the screen cannot tell a story the checker would disagree with.
 *
 * The source is a replay of a stored call (§19.3) until the orchestrator lands
 * in week 4, and the header says so while it is playing. A screen that presents
 * a scripted call as a live one is worse than a screen showing nothing.
 */

import { useState } from 'react';
import { useLiveLog } from './useLiveLog.js';
import { EscalationTasks } from './panels/EscalationTasks.js';
import { ActiveCall, Classifier, Compliance, GateTimeline, QueuePanel, ToolCalls, Transcript } from './panels/Panels.js';

export default function App() {
  // §19: "Enable it during the presentation — and say that you did." The screen
  // says so, loudly, whenever it is on.
  const [redact, setRedact] = useState(import.meta.env['VITE_REDACT_TRANSCRIPT'] === 'true');
  const { view, connection, eventCount, markHandled, replay } = useLiveLog(redact);

  return (
    <main>
      <header>
        <h1>HoldHarmless</h1>
        <p className="sub">
          <span className={`conn conn-${connection}`}>{connection}</span>
          {eventCount} events · replayed call (§19.3), not a live line
          {redact && <strong className="redacting"> · redaction on</strong>}
        </p>
        <button type="button" className="secondary" onClick={() => void replay()}>Replay the stored call</button>
      </header>

      <div className="grid">
        <QueuePanel requests={view.queue} profile={view.profile} />
        <ActiveCall call={view.activeCall} />
        <GateTimeline channelSpans={view.channelSpans} gateSpans={view.gateSpans} profile={view.profile} />
        <Classifier classifier={view.classifier} profile={view.profile} />
        <Transcript lines={view.transcript} redact={redact} onRedactChange={setRedact} profile={view.profile} />
        <ToolCalls tools={view.tools} profile={view.profile} />
        <Compliance c={view.compliance} profile={view.profile} />
        <EscalationTasks cards={view.escalations} onMarkHandled={(id, requeue) => void markHandled(id, requeue)} />
      </div>

      <footer>
        <p>
          Panel 4 is the one that earns its place: the gate timeline drawn over the
          channel timeline makes the interval where the gate is closed and the
          channel has not yet moved <em>directly visible</em>. That interval is
          ADR-007, and it is the argument.
        </p>
        <p className="profile-note">
          Every panel carries the network profile in force — INV-16 refuses a figure
          produced under CLEAN.
        </p>
      </footer>
    </main>
  );
}
