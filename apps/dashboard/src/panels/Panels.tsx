/**
 * Panels 1–7 — §11, module 3.8. (Panel 8 landed with module 3.6.)
 *
 * These components draw and nothing else. Every number, span and marker below
 * comes from `dashboardView` in apps/core, which is where it is tested; a
 * component that computed something would be a second opinion about the call.
 *
 * EVERY PANEL CARRIES ITS NETWORK PROFILE. INV-16 refuses a figure produced
 * under CLEAN, and a screenshot of a latency figure with no profile beside it
 * is exactly the figure that gets quoted later without one.
 */

import type {
  ActiveCallPanel,
  ClassifierPanel,
  CompliancePanel,
  DashboardView,
  Span,
  ToolRow,
  TranscriptLine,
} from '@holdharmless/core/view';
import type { AuthRequest, Channel, GateIntent, NetworkProfileName } from '@holdharmless/events';

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function Panel({
  n, name, profile, children, wide,
}: {
  n: number; name: string; profile: NetworkProfileName | null; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <section className={wide ? 'panel wide' : 'panel'}>
      <h2>
        <span className="n">{n}</span>
        {name}
        {/* INV-16: the profile in force, on every panel, always. */}
        <span className={profile === 'TELEPHONY' ? 'profile' : 'profile off-profile'}>{profile ?? 'no call'}</span>
      </h2>
      {children}
    </section>
  );
}

export function QueuePanel({ requests, profile }: { requests: AuthRequest[]; profile: NetworkProfileName | null }) {
  return (
    <Panel n={1} name="Queue" profile={profile}>
      <table className="queue">
        <thead>
          <tr><th>Request</th><th>Priority</th><th>Status</th><th>Attempts</th><th>Reference</th></tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id} className={r.priority === 'expedited' ? 'expedited' : undefined}>
              <td className="mono">{r.id}</td>
              <td>{r.priority === 'expedited' ? 'EXPEDITED' : 'routine'}</td>
              <td><span className={`status status-${r.status}`}>{r.status.replace(/_/g, ' ')}</span></td>
              <td>{r.attempts}</td>
              <td className="mono dim">{r.lastReference ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

export function ActiveCall({ call }: { call: ActiveCallPanel }) {
  return (
    <Panel n={2} name="Active call" profile={call.profile}>
      <div className="indicators">
        {/* Two indicators, never one. §5: the dimensions are independent, and a
            single "state" chip is how a reader starts believing otherwise. */}
        <div className="indicator">
          <span className="label">Channel</span>
          <strong className={`chip channel-${call.channel}`}>{call.channel}</strong>
        </div>
        <div className="indicator">
          <span className="label">Phase</span>
          <strong className={`chip phase-${call.phase}`}>{call.phase}{call.closingKind ? ` · ${call.closingKind}` : ''}</strong>
        </div>
        <div className="indicator">
          <span className="label">Gate</span>
          <strong className={`chip gate-${call.gate}`}>{call.gate}</strong>
        </div>
      </div>
      <dl className="facts">
        <dt>Elapsed</dt><dd>{secs(call.elapsedMs)}</dd>
        <dt>Hold segment</dt><dd>{call.holdSegmentMs === 0 ? '—' : secs(call.holdSegmentMs)}</dd>
        <dt>Disclosed to this party</dt><dd>{call.disclosedToCurrentParty ? 'yes' : 'not yet'}</dd>
        <dt>Hold suspected</dt><dd>{call.holdSuspected ? 'yes' : 'no'}</dd>
      </dl>
    </Panel>
  );
}

function Bars({ scores, winner }: { scores: Record<string, number>; winner: string }) {
  return (
    <ul className="bars">
      {Object.entries(scores).map(([name, value]) => (
        <li key={name} className={name === winner ? 'won' : undefined}>
          <span className="bar-label">{name.toLowerCase().replace(/_/g, ' ')}</span>
          <span className="bar"><span style={{ width: `${Math.round(value * 100)}%` }} /></span>
          <span className="bar-value">{value.toFixed(2)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Classifier({ classifier, profile }: { classifier: ClassifierPanel; profile: NetworkProfileName | null }) {
  const { acoustic, semantic, holdCue } = classifier;
  return (
    <Panel n={3} name="Classifier" profile={profile}>
      <div className="two-up">
        <div>
          <h3>Acoustic <span className="dim">local, 250 ms</span></h3>
          {acoustic ? (
            <>
              <Bars scores={acoustic.scores} winner={acoustic.winner} />
              <p className="dim">
                tier <strong>{acoustic.tier}</strong> · signals {acoustic.signalsAvailable.join(', ')}
              </p>
            </>
          ) : <p className="dim">no observation yet</p>}
        </div>
        <div>
          <h3>Semantic <span className="dim">per transcript delta</span></h3>
          {semantic ? (
            <>
              <Bars scores={semantic.scores} winner={semantic.winner} />
              <p className="dim">
                effectiveMinWeight <strong>{semantic.effectiveMinWeight.toFixed(2)}</strong> · signals {semantic.signalsAvailable.join(', ')}
              </p>
            </>
          ) : <p className="dim">no observation yet</p>}
        </div>
      </div>
      {holdCue && (
        <p className="hold-cue">
          HOLD_CUE · “{holdCue.phrase}”{holdCue.transferHint ? ' · transfer hint' : ''}
        </p>
      )}
    </Panel>
  );
}

/**
 * Panel 4 — the one that earns its place.
 *
 * The gate timeline is drawn OVER the channel timeline on one axis, so the
 * interval where the gate is already closed and the channel has not yet moved
 * is a thing you can point at rather than a claim in a document. That interval
 * is ADR-007, and it is the argument.
 */
export function GateTimeline({
  channelSpans, gateSpans, profile,
}: {
  channelSpans: Span<Channel>[]; gateSpans: Span<GateIntent>[]; profile: NetworkProfileName | null;
}) {
  const end = Math.max(
    channelSpans[channelSpans.length - 1]?.toMs ?? 1,
    gateSpans[gateSpans.length - 1]?.toMs ?? 1,
    1,
  );
  const pct = (ms: number) => `${Math.max(0, Math.min(100, (ms / end) * 100))}%`;

  // The interval the panel exists to show: the gate closed while the channel
  // had not caught up. Labelled, because a viewer should not have to find it.
  const closedEarly = gateSpans
    .filter((g) => g.value === 'closed')
    .map((g) => {
      const channelThen = channelSpans.find((c) => c.fromMs <= g.fromMs && (c.toMs ?? Infinity) > g.fromMs);
      const nextChannel = channelSpans.find((c) => c.fromMs > g.fromMs);
      if (!channelThen || channelThen.value === 'HOLD' || !nextChannel || nextChannel.value !== 'HOLD') return null;
      return { fromMs: g.fromMs, toMs: nextChannel.fromMs };
    })
    .find((x): x is { fromMs: number; toMs: number } => x !== null);

  return (
    <Panel n={4} name="Gate over channel" profile={profile} wide>
      <div className="timeline">
        <div className="track">
          <span className="track-label">channel</span>
          <div className="lane">
            {channelSpans.map((s, i) => (
              <span
                key={`${s.value}-${i}`}
                className={`span channel-${s.value}`}
                style={{ left: pct(s.fromMs), width: pct((s.toMs ?? end) - s.fromMs) }}
                title={`${s.value} from ${secs(s.fromMs)}${s.cause ? ` (${s.cause})` : ''}`}
              >
                {s.value}
              </span>
            ))}
          </div>
        </div>
        <div className="track">
          <span className="track-label">gate</span>
          <div className="lane">
            {gateSpans.map((s, i) => (
              <span
                key={`${s.value}-${i}`}
                className={`span gate-${s.value}`}
                style={{ left: pct(s.fromMs), width: pct((s.toMs ?? end) - s.fromMs) }}
                title={`${s.value} from ${secs(s.fromMs)}${s.cause ? ` (${s.cause})` : ''}`}
              >
                {s.value}
              </span>
            ))}
          </div>
        </div>
        {closedEarly && (
          <div
            className="interval"
            style={{ left: pct(closedEarly.fromMs), width: pct(closedEarly.toMs - closedEarly.fromMs) }}
            title="the gate is closed and the channel has not moved"
          >
            <span>{secs(closedEarly.toMs - closedEarly.fromMs)} muted before the channel agreed — ADR-007</span>
          </div>
        )}
      </div>
    </Panel>
  );
}

export function Transcript({
  lines, redact, onRedactChange, profile,
}: {
  lines: TranscriptLine[]; redact: boolean; onRedactChange: (next: boolean) => void; profile: NetworkProfileName | null;
}) {
  return (
    <Panel n={5} name="Transcript" profile={profile} wide>
      <label className="redact-toggle">
        <input type="checkbox" checked={redact} onChange={(e) => onRedactChange(e.target.checked)} />
        Redaction mode {redact && <strong>on — member data is masked on this screen</strong>}
      </label>
      <ol className="transcript">
        {lines.map((line) => (
          <li key={line.seq} className={`line ${line.speaker}${line.partial ? ' partial' : ''}`}>
            <span className="at">{secs(line.atMs)}</span>
            <span className="who">{line.speaker === 'agent' ? 'agent' : 'far end'}</span>
            <span className={line.redacted ? 'text redacted' : 'text'}>{line.text}</span>
            <span className="markers">
              {line.bargeIn && <em className="marker barge">barge-in</em>}
              {line.partial && <em className="marker">partial</em>}
              {line.isClosing && <em className="marker closing">closing</em>}
            </span>
          </li>
        ))}
        {lines.length === 0 && <li className="dim">nothing said yet</li>}
      </ol>
    </Panel>
  );
}

export function ToolCalls({ tools, profile }: { tools: ToolRow[]; profile: NetworkProfileName | null }) {
  return (
    <Panel n={6} name="Tool calls" profile={profile}>
      <ul className="tools">
        {tools.map((t) => (
          <li key={t.toolCallId} className={t.rejected ? 'tool rejected' : 'tool'}>
            <span className="mono">{t.name}</span>
            <span className="dim">{t.latencyMs === null ? '—' : `${t.latencyMs} ms`}</span>
            {t.discarded && <em className="marker">result discarded</em>}
            {t.rejected && <span className="reason">{t.reason}: {t.detail}</span>}
          </li>
        ))}
        {tools.length === 0 && <li className="dim">no tool calls yet</li>}
      </ul>
    </Panel>
  );
}

export function Compliance({ c, profile }: { c: CompliancePanel; profile: NetworkProfileName | null }) {
  const median = (xs: number[]): string => {
    if (xs.length === 0) return '—';
    const s = [...xs].sort((a, b) => a - b);
    return `${s[Math.floor(s.length / 2)]} ms`;
  };
  return (
    <Panel n={7} name="Compliance and cost" profile={profile}>
      <dl className="facts">
        <dt>Disclosures per party</dt>
        <dd className={c.disclosurePerParty.length < c.partiesDetected ? 'bad' : 'good'}>
          {c.disclosurePerParty.join(' · ') || '—'} against {c.partiesDetected} part{c.partiesDetected === 1 ? 'y' : 'ies'}
        </dd>
        <dt>Over-disclosure</dt><dd>{c.overDisclosureCount}</dd>
        <dt>Party detection misses</dt><dd>{c.partyDetectionMissCount}</dd>
        <dt>Gate false closes</dt><dd>{c.gateFalseCloseCount}</dd>
        <dt>Perceived response</dt>
        {/* Measured at the harness (§16.1) — the core cannot see its own zero point. */}
        <dd>{median(c.perceivedResponseMs)} <span className="dim">median, measured at the far end</span></dd>
        <dt>Billable session</dt><dd>{c.billableSessionMinutes.toFixed(1)} min</dd>
        <dt>Transport faults</dt>
        <dd>{Object.keys(c.transportFaults).length === 0 ? 'none' : Object.entries(c.transportFaults).map(([k, v]) => `${k} ${v}`).join(' · ')}</dd>
      </dl>
      <div className={c.safetyViolations.length > 0 ? 'violations red' : 'violations'}>
        <strong>{c.safetyViolations.length}</strong> safety violation{c.safetyViolations.length === 1 ? '' : 's'}
        <ul>
          {c.safetyViolations.map((v, i) => <li key={i}><span className="mono">{v.kind}</span> — {v.detail}</li>)}
          {c.invariantViolations.map((v, i) => <li key={`inv-${i}`}><span className="mono">{v.id}</span> — {v.detail}</li>)}
        </ul>
      </div>
    </Panel>
  );
}

export type PanelsProps = {
  view: DashboardView;
  redact: boolean;
  onRedactChange: (next: boolean) => void;
};
