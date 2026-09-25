/**
 * INV-1 … INV-21 — §17.1, interface in §12.8.
 *
 * Every invariant checks the EVENT LOG, because the log is the runtime source of
 * truth (ADR-012) and because a check that reads live state can be satisfied by
 * the same code it is meant to audit. A check returns null when satisfied and a
 * human-readable reason when not. Nothing here repairs anything (§3.3 rule 3):
 * a system that silently corrects itself cannot be audited.
 *
 * Where the log cannot carry the whole of an invariant, the check says so in its
 * description rather than pretending to more coverage than it has.
 */

import {
  gateAdmitsProduct,
  isFinalStatus,
  PRODUCER_KINDS,
  type AuthRequest,
  type Call,
  type CallEvent,
  type Channel,
  type GateIntent,
  type NetworkProfileName,
  type Phase,
} from '@holdharmless/events';
import {
  CHANNEL_TRANSITIONS,
  PHASE_TRANSITIONS,
  POSITION_POLICY,
  deadEnds,
  gateFor,
  positionId,
  reachablePositions,
  TOOL_EFFECT,
  type PositionId,
} from '@holdharmless/callmodel';
import { gateAdmits, gateTransitionRequiresClear } from '@holdharmless/transport';
import { syntheticViolations } from './synthetic.js';
import { replay, type ReplayState } from './replay.js';

export { replay };
export type { ReplayState };

export interface InvariantContext {
  call: Readonly<Call>;
  request: Readonly<AuthRequest>;
  log: readonly CallEvent[];
  /** Ground truth from the harness (ADR-018). Falls back to parties_used telemetry. */
  harnessParties?: number;
}

export interface Invariant {
  id: string;
  description: string;
  /** Null when satisfied. */
  check(ctx: InvariantContext): string | null;
  when: 'transition' | 'call-end' | 'replay';
  /** The §0.1 error class this invariant closes, where it closes one. */
  errorClass?: 'K-1' | 'K-2' | 'K-3' | 'K-4' | 'K-5' | 'K-6';
}

/** §13 — kept here rather than imported from a config module that does not exist yet. */
export const PARTY_CONTINUITY_MS = 5000;

const ms = (iso: string) => Date.parse(iso);

/** The §8.1 content rules for a context summary (INV-9). */
export function summaryProblems(summary: unknown, priority: AuthRequest['priority']): string | null {
  if (typeof summary !== 'string') return 'summary is not a string';
  if (summary.length < 40) return `summary is ${summary.length} characters; §8.1 requires at least 40`;
  const first = summary.startsWith('EXPEDITED.') ? 'EXPEDITED' : summary.startsWith('Routine.') ? 'Routine' : null;
  if (first === null) return 'first sentence must be exactly "EXPEDITED." or "Routine."';
  const expected = priority === 'expedited' ? 'EXPEDITED' : 'Routine';
  if (first !== expected) return `summary says ${first} but the request priority is ${priority}`;
  return null;
}

/** Evidence of an escalation that INV-9 and INV-19 accept. */
function validEscalationEvidence(ctx: InvariantContext, before = Infinity): boolean {
  const accepted = new Set(
    ctx.log.filter((e, i) => i < before && e.t === 'tool.returned').map((e) => (e as { toolCallId: string }).toolCallId),
  );
  return ctx.log.some((e, i) => {
    if (i >= before) return false;
    if (e.t === 'escalation.summary') return summaryProblems(e.summary, ctx.request.priority) === null;
    if (e.t === 'tool.called' && e.name === 'escalate_to_human' && accepted.has(e.toolCallId)) {
      const args = e.args as { context_summary?: unknown } | undefined;
      return summaryProblems(args?.context_summary, ctx.request.priority) === null;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// The invariants.
// ---------------------------------------------------------------------------

export const INVARIANTS: readonly Invariant[] = [
  {
    id: 'INV-1',
    when: 'transition',
    description:
      'gateIntent always equals gateFor(channel, holdSuspected, navMode). Every gate.changed must match the ' +
      'derivation, and no turn, tool, reply, DTMF or prompt may occur while the gate is stale.',
    check(ctx) {
      const states = replay(ctx.log);
      for (const s of states) {
        const e = s.event;
        if (e.t === 'gate.changed') {
          const derived = gateFor(e.channel, e.holdSuspected, ctx.call.navMode);
          if (e.to !== derived) return `seq ${e.seq}: gate set to ${e.to} but gateFor() gives ${derived}`;
          if (e.channel !== s.channel) {
            return `seq ${e.seq}: gate.changed records channel ${e.channel} while the log is in ${s.channel}`;
          }
          if (e.holdSuspected !== s.holdSuspected) {
            return `seq ${e.seq}: gate.changed records holdSuspected=${e.holdSuspected} but the log has it ${s.holdSuspected}`;
          }
        }
      }
      // The gate must match the derivation before anything ACTS on it. A channel
      // change, its atomic phase follow-up, and the gate change arrive as a group
      // from one handler (§5.5), so demanding the gate.changed as the literally
      // next event would flag every representative who answers. What must never
      // happen is a turn, tool, reply, DTMF or prompt under a stale gate.
      const BOOKKEEPING = new Set([
        'channel.changed', 'phase.changed', 'gate.changed', 'hold.suspected', 'hold.cleared', 'party.changed',
        'network.profile_changed',
      ]);
      for (const s of states) {
        if (BOOKKEEPING.has(s.event.t)) continue;
        const derived = gateFor(s.channel, s.holdSuspected, ctx.call.navMode);
        if (s.gate !== derived) {
          return `seq ${s.event.seq}: ${s.event.t} occurred with the gate ${s.gate} while the derivation gives ${derived}`;
        }
      }
      return null;
    },
  },
  {
    id: 'INV-2',
    when: 'transition',
    description:
      'No agent audio reaches the transport while the gate is not open, except DTMF while dtmf_only. ' +
      'Frames are not logged individually, so this checks the two things the log does hold: every dtmf.sent ' +
      'occurred while the gate admitted DTMF, and the harness heard zero agent speech during hold (§16.2).',
    check(ctx) {
      for (const s of replay(ctx.log)) {
        const e = s.event;
        if (e.t === 'dtmf.sent' && !gateAdmits(s.gate, 'dtmf')) {
          return `seq ${e.seq}: DTMF sent while the gate was ${s.gate}`;
        }
        if (e.t === 'harness.telemetry' && e.metric === 'agent_speech_during_hold_ms' && e.value > 0) {
          return `seq ${e.seq}: the harness heard ${e.value} ms of agent speech during hold`;
        }
      }
      return null;
    },
  },
  {
    id: 'INV-3',
    when: 'transition',
    description:
      'Every gate change that narrows what is admitted — including dtmf_only -> closed — sends a clear, and ' +
      'the harness reports zero unplayed agent frames afterwards. "Within 50 ms" is met structurally: the ' +
      'transport issues clear() synchronously inside applyGate(); its ARRIVAL is bounded by the network profile.',
    check(ctx) {
      for (const e of ctx.log) {
        if (e.t === 'gate.changed' && gateTransitionRequiresClear(e.from, e.to) && !e.clearSent) {
          return `seq ${e.seq}: gate narrowed ${e.from} -> ${e.to} without a clear`;
        }
        if (e.t === 'harness.telemetry' && e.metric === 'unplayed_agent_frames_after_clear' && e.value > 0) {
          return `seq ${e.seq}: ${e.value} agent frames were still queued after a clear`;
        }
      }
      return null;
    },
  },
  {
    id: 'INV-4',
    when: 'transition',
    description:
      'No reply.requested unless the gate ADMITS WHAT THE REPLY MAY PRODUCE, and never while hold is suspected. ' +
      'The hold probe §6.7 once permitted was removed in v1.3 because it fired where the gate is always closed; ' +
      'IVR silence recovery, by contrast, produces DTMF and passes a dtmf_only gate (§5.7, ADR-022 condition 1).',
    check(ctx) {
      for (const s of replay(ctx.log)) {
        const e = s.event;
        if (e.t !== 'reply.requested') continue;
        // Checked against the reply's own product, not against 'open'. Before
        // module 3.7 this read `s.gate !== 'open'`, which was the rule §5.7's
        // decision replaced on 2026-09-23 — so a correct IVR re-prompt would
        // have been reported as a violation the moment one was built.
        if (!gateAdmitsProduct(s.gate, e.produces)) {
          return `seq ${e.seq}: ${e.cause} reply producing ${e.produces} requested while the gate was ${s.gate}`;
        }
        if (s.holdSuspected) return `seq ${e.seq}: ${e.cause} reply requested while hold was suspected`;
      }
      return null;
    },
  },
  {
    id: 'INV-5',
    when: 'transition',
    description:
      'Re-prompt counters never advance while hold is suspected, and never exceed the §5.7 limit for the position. ' +
      'A counter segment ends at any channel or phase change or at a final far-end turn. The log proves the limit is ' +
      'never EXCEEDED; that the after-limit action fires exactly at it is observable only by the position that follows.',
    check(ctx) {
      let count = 0;
      for (const s of replay(ctx.log)) {
        const e = s.event;
        if (e.t === 'channel.changed' || e.t === 'phase.changed' || (e.t === 'turn.transcribed' && e.speaker === 'far_end' && !e.partial)) {
          count = 0;
          continue;
        }
        if (e.t !== 'reply.requested' || e.cause !== 'silence_recovery') continue;
        if (s.holdSuspected) return `seq ${e.seq}: a silence re-prompt advanced while hold was suspected`;
        count++;
        const limit = POSITION_POLICY[positionId(s.channel, s.phase)]?.rePromptLimit;
        if (limit === undefined) return `seq ${e.seq}: a silence re-prompt at ${s.channel}/${s.phase}, which has no recovery`;
        if (count > limit) return `seq ${e.seq}: re-prompt ${count} at ${s.channel}/${s.phase} exceeds the limit of ${limit}`;
      }
      return null;
    },
  },
  {
    id: 'INV-6',
    when: 'transition',
    errorClass: 'K-2',
    description:
      'Both directions. Every return to HUMAN from HOLD or TRANSFER without assured continuity loads PARTY_HEDGE.txt; ' +
      'and no prompt ever carries both PARTY_HEDGE.txt and DISCLOSURE.txt.',
    check(ctx) {
      const states = replay(ctx.log);
      for (const s of states) {
        const e = s.event;
        if (e.t === 'prompt.loaded') {
          const both = e.files.includes('PARTY_HEDGE.txt') && e.files.includes('DISCLOSURE.txt');
          if (both || (e.hedged && e.disclosureIncluded)) {
            return `seq ${e.seq}: one prompt carries both the hedge and the disclosure instruction`;
          }
        }
        if (e.t !== 'channel.changed' || e.to !== 'HUMAN') continue;
        if (e.from !== 'HOLD' && e.from !== 'TRANSFER') continue;

        const segmentMs = s.holdSegmentStartMs === null ? Infinity : ms(e.at) - s.holdSegmentStartMs;
        const continuityAssured = e.from === 'HOLD' && segmentMs < PARTY_CONTINUITY_MS;
        if (continuityAssured) continue;

        const nextPrompt = states.slice(s.index + 1).find((x) => x.event.t === 'prompt.loaded')?.event;
        if (nextPrompt?.t !== 'prompt.loaded' || !nextPrompt.hedged) {
          return `seq ${e.seq}: returned to HUMAN from ${e.from} without the party hedge`;
        }
      }
      return null;
    },
  },
  {
    id: 'INV-7',
    when: 'call-end',
    errorClass: 'K-2',
    description:
      'Every call that reached HUMAN delivered at least as many disclosures as the harness used parties. ' +
      'The denominator is harness ground truth, never an internal estimate (ADR-018); if it is absent the ' +
      'invariant FAILS, because a compliance figure divided by nothing is not a figure.',
    check(ctx) {
      if (!ctx.log.some((e) => e.t === 'channel.changed' && e.to === 'HUMAN')) return null;
      const delivered = ctx.log.filter((e) => e.t === 'disclosure.delivered').length;
      const telemetry = [...ctx.log].reverse().find((e) => e.t === 'harness.telemetry' && e.metric === 'parties_used');
      const parties = ctx.harnessParties ?? (telemetry?.t === 'harness.telemetry' ? telemetry.value : undefined);
      if (parties === undefined) return 'no parties_used ground truth from the harness — disclosure compliance is unverified';
      if (delivered < parties) return `${delivered} disclosure(s) delivered to ${parties} part(ies)`;
      return null;
    },
  },
  {
    id: 'INV-8',
    when: 'transition',
    description:
      'An accepted notify_transfer moves the channel to TRANSFER next, and resets disclosure: a party.changed ' +
      'with reason "transfer" is logged before the next return to HUMAN.',
    check(ctx) {
      for (let i = 0; i < ctx.log.length; i++) {
        const e = ctx.log[i]!;
        if (e.t !== 'tool.returned' || e.name !== 'notify_transfer') continue;
        const rest = ctx.log.slice(i + 1);
        const nextChannel = rest.find((x) => x.t === 'channel.changed');
        if (nextChannel?.t !== 'channel.changed' || nextChannel.to !== 'TRANSFER') {
          return `seq ${e.seq}: notify_transfer accepted but the next channel change is ${nextChannel?.t === 'channel.changed' ? nextChannel.to : 'absent'}`;
        }
        const backToHuman = rest.findIndex((x) => x.t === 'channel.changed' && x.to === 'HUMAN');
        const window = backToHuman === -1 ? rest : rest.slice(0, backToHuman);
        if (!window.some((x) => x.t === 'party.changed' && x.reason === 'transfer')) {
          return `seq ${e.seq}: notify_transfer accepted but disclosure was not reset for the new party`;
        }
      }
      return null;
    },
  },
  {
    id: 'INV-9',
    when: 'transition',
    errorClass: 'K-4',
    description:
      'An escalated outcome is backed by a valid summary in the log — an accepted escalate_to_human or an ' +
      'escalation.summary event — meeting §8.1: at least 40 characters, opening with exactly "EXPEDITED." or ' +
      '"Routine.", and matching the request priority. Checked against the log, never against record_outcome.',
    check(ctx) {
      for (let i = 0; i < ctx.log.length; i++) {
        const e = ctx.log[i]!;
        if (e.t !== 'outcome.written' || e.skipped || e.status !== 'escalated') continue;
        if (!validEscalationEvidence(ctx, i)) {
          const summaries = ctx.log.slice(0, i).filter((x) => x.t === 'escalation.summary');
          const why = summaries.length
            ? summaryProblems((summaries.at(-1) as { summary: string }).summary, ctx.request.priority)
            : 'no escalation summary precedes it';
          return `seq ${e.seq}: escalated outcome without a valid summary — ${why}`;
        }
      }
      return null;
    },
  },
  {
    id: 'INV-10',
    when: 'transition',
    description:
      'record_outcome is accepted only while the request status is not final, keyed on requestId. Within one log, ' +
      'no record_outcome is accepted after a final status has been written.',
    check(ctx) {
      let finalWritten = false;
      for (const e of ctx.log) {
        if (e.t === 'outcome.written' && !e.skipped && isFinalStatus(e.status)) finalWritten = true;
        if (e.t === 'tool.returned' && e.name === 'record_outcome' && finalWritten) {
          return `seq ${e.seq}: record_outcome accepted after the status was already final`;
        }
      }
      return null;
    },
  },
  {
    id: 'INV-11',
    when: 'replay',
    errorClass: 'K-1',
    description:
      'Every reachable (channel, phase) pair has a policy and an exit, evaluated over the cartesian product with ' +
      'reachability COMPUTED from §5.3/§5.4 rather than read from §18.',
    check() {
      const reachable = reachablePositions();
      const uncovered = [...reachable].filter((id) => POSITION_POLICY[id] === undefined);
      if (uncovered.length) return `reachable without policy: ${uncovered.join(', ')}`;
      const stuck = deadEnds();
      if (stuck.length) return `reachable dead ends: ${stuck.join(', ')}`;
      return null;
    },
  },
  {
    id: 'INV-12',
    when: 'transition',
    description:
      'No AuthRequest contains non-synthetic data, under the mechanical definition in synthetic.ts: NPIs that fail ' +
      'the check digit, fictional 555-01xx phones, loopback endpoints, SYN-prefixed patient and member identifiers.',
    check(ctx) {
      const v = syntheticViolations(ctx.request);
      return v.length ? v.map((x) => `${x.field} ${JSON.stringify(x.value)} ${x.rule}`).join('; ') : null;
    },
  },
  {
    id: 'INV-13',
    when: 'transition',
    errorClass: 'K-1',
    description:
      'Phase never moves because the channel moved, except the two atomic follow-ups: NOT_STARTED -> EXCHANGE ' +
      'on entering HUMAN (semantic), and any -> DONE on entering CLOSED (transport).',
    check(ctx) {
      for (const e of ctx.log) {
        if (e.t !== 'phase.changed') continue;
        const k = e.producer.kind;
        if (k === 'acoustic') return `seq ${e.seq}: phase ${e.from} -> ${e.to} produced by an acoustic observation`;
        if (k === 'semantic' && !(e.from === 'NOT_STARTED' && e.to === 'EXCHANGE')) {
          return `seq ${e.seq}: phase ${e.from} -> ${e.to} produced by a semantic observation`;
        }
        if (k === 'transport' && e.to !== 'DONE') {
          return `seq ${e.seq}: phase ${e.from} -> ${e.to} produced by a transport event`;
        }
      }
      return null;
    },
  },
  {
    id: 'INV-14',
    when: 'call-end',
    description: 'Every tool.called has exactly one tool.returned, tool.rejected, or tool.result_discarded.',
    check(ctx) {
      const outcomes = new Map<string, number>();
      const called = new Set<string>();
      for (const e of ctx.log) {
        if (e.t === 'tool.called') called.add(e.toolCallId);
        if (e.t === 'tool.returned' || e.t === 'tool.rejected' || e.t === 'tool.result_discarded') {
          outcomes.set(e.toolCallId, (outcomes.get(e.toolCallId) ?? 0) + 1);
        }
      }
      for (const id of called) {
        const n = outcomes.get(id) ?? 0;
        if (n !== 1) return `tool call ${id} has ${n} outcomes`;
      }
      for (const id of outcomes.keys()) if (!called.has(id)) return `outcome for ${id}, which was never called`;
      return null;
    },
  },
  {
    id: 'INV-15',
    when: 'transition',
    description:
      'A tool.rejected with reason state_not_allowed is never paired with a safety.violation for the same toolCallId. ' +
      'Validation rejections that touch a safety class correctly emit both.',
    check(ctx) {
      const notAllowed = new Set(
        ctx.log.filter((e) => e.t === 'tool.rejected' && e.reason === 'state_not_allowed').map((e) => (e as { toolCallId: string }).toolCallId),
      );
      for (const e of ctx.log) {
        if (e.t === 'safety.violation' && e.toolCallId !== undefined && notAllowed.has(e.toolCallId)) {
          return `seq ${e.seq}: safety.violation for ${e.toolCallId}, which was rejected as state_not_allowed`;
        }
      }
      return null;
    },
  },
  {
    id: 'INV-16',
    when: 'replay',
    description:
      'The network profile in force is derivable for every transition and metric: the log opens with call.started ' +
      'naming it, and every network.profile_changed chains from the profile in force. CLEAN runs are permitted and ' +
      'visible; refusing to REPORT their figures is the job of isReportable().',
    check(ctx) {
      const first = ctx.log[0];
      if (first?.t !== 'call.started') return 'the log does not open with call.started, so no profile is in force';
      for (const s of replay(ctx.log)) {
        const e = s.event;
        if (e.t === 'network.profile_changed' && e.from !== s.profile) {
          return `seq ${e.seq}: profile change from ${e.from}, but ${s.profile} was in force`;
        }
        if ((e.t === 'channel.changed' || e.t === 'phase.changed' || e.t === 'harness.telemetry') && s.profile === null) {
          return `seq ${e.seq}: ${e.t} with no network profile in force`;
        }
      }
      return null;
    },
  },
  {
    id: 'INV-17',
    when: 'replay',
    errorClass: 'K-3',
    description: 'Every tool whose TOOL_EFFECT names a channel or phase has a §5.3/§5.4 transition that produces it.',
    check() {
      for (const [tool, effect] of Object.entries(TOOL_EFFECT)) {
        if (effect.none) continue;
        const rows = [...CHANNEL_TRANSITIONS, ...PHASE_TRANSITIONS].filter((t) => t.tool === tool);
        if (rows.length === 0) return `${tool} declares an effect but no transition is produced by it`;
      }
      return null;
    },
  },
  {
    id: 'INV-18',
    when: 'transition',
    description:
      'AuthRequest.status is written only while not final, by either writer. Once a final status is written, ' +
      'every further outcome.written must be marked skipped.',
    check(ctx) {
      let final: string | null = null;
      for (const e of ctx.log) {
        if (e.t !== 'outcome.written') continue;
        if (final !== null && !e.skipped) {
          return `seq ${e.seq}: ${e.writer} wrote ${e.status} over the final status ${final}`;
        }
        if (!e.skipped && isFinalStatus(e.status)) final = e.status;
      }
      return null;
    },
  },
  {
    id: 'INV-19',
    when: 'transition',
    errorClass: 'K-5',
    description:
      'A call whose log holds escalation evidence is never recorded as failed, and when the link drops with that ' +
      'evidence present, escalated is what gets written.',
    check(ctx) {
      const evidence = validEscalationEvidence(ctx);
      if (!evidence) return null;
      const written = ctx.log.filter((e) => e.t === 'outcome.written' && !e.skipped);
      const failed = written.find((e) => e.t === 'outcome.written' && e.status === 'failed');
      if (failed) return `seq ${failed.seq}: recorded as failed although the log holds a valid escalation`;
      if (ctx.log.some((e) => e.t === 'call.dropped') && !written.some((e) => e.t === 'outcome.written' && e.status === 'escalated')) {
        return 'the link dropped with escalation evidence in the log, but escalated was never written';
      }
      return null;
    },
  },
  {
    id: 'INV-20',
    when: 'transition',
    errorClass: 'K-5',
    description:
      'In a call that produces an outcome, no agent closing turn precedes outcome.written. The static half — ' +
      '[[RECORD_OUTCOME]] before [[CLOSING]] in every prompt file — is check #5 in check-doc-claims.',
    check(ctx) {
      const outcomeAt = ctx.log.findIndex((e) => e.t === 'outcome.written' && !e.skipped);
      if (outcomeAt === -1) return null;
      const early = ctx.log.find(
        (e, i) => i < outcomeAt && e.t === 'turn.transcribed' && e.speaker === 'agent' && !e.partial && e.isClosing,
      );
      return early ? `seq ${early.seq}: the agent closed before the outcome was written` : null;
    },
  },
  {
    id: 'INV-21',
    when: 'transition',
    errorClass: 'K-6',
    description:
      'Every channel.changed and phase.changed names a producer from the closed set of six, and a row in ' +
      '§5.3/§5.4 exists for that transition with that producer.',
    check(ctx) {
      for (const e of ctx.log) {
        if (e.t !== 'channel.changed' && e.t !== 'phase.changed') continue;
        if (!(PRODUCER_KINDS as readonly string[]).includes(e.producer.kind)) {
          return `seq ${e.seq}: producer kind ${e.producer.kind} is not in the closed set`;
        }
        const rows =
          e.t === 'channel.changed'
            ? CHANNEL_TRANSITIONS.filter((t) => (t.from === '*' || t.from === e.from) && t.to === e.to)
            : PHASE_TRANSITIONS.filter((t) => (t.from === '*' || t.from === e.from) && t.to === e.to);
        if (!rows.some((t) => t.producer === e.producer.kind)) {
          return `seq ${e.seq}: ${e.t} ${e.from} -> ${e.to} by ${e.producer.kind} has no §5.3/§5.4 row`;
        }
      }
      return null;
    },
  },
];

export type InvariantResult = { id: string; violation: string };

/** Runs the invariants for a given moment. Returns violations; repairs nothing. */
export function checkInvariants(
  ctx: InvariantContext,
  when: Invariant['when'] | 'all' = 'all',
): InvariantResult[] {
  return INVARIANTS.filter((inv) => when === 'all' || inv.when === when).flatMap((inv) => {
    const violation = inv.check(ctx);
    return violation === null ? [] : [{ id: inv.id, violation }];
  });
}

/** False when any figure in the log was produced under CLEAN — §4.5, INV-16. */
export function isReportable(log: readonly CallEvent[]): boolean {
  return replay(log).every((s) => s.profile !== 'CLEAN' || s.event.t !== 'harness.telemetry');
}

export type { PositionId };
