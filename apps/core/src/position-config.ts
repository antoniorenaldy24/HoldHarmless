/**
 * Per-position configuration — module 4.0, reply half, step 3.
 *
 * §7.3 and §5.6 say WHAT the session is told at every position: a prompt
 * assembled by `promptFor`, and a policy row from `POSITION_POLICY` (tools,
 * transcription mode, whether the far end may interrupt). Both existed, tested,
 * since week 1; nothing ever sent either to a session. This is that sender.
 *
 * THREE RULES, and where each comes from:
 *
 * 1. ONE UPDATE PER SETTLED POSITION. A channel change and its atomic phase
 *    follow-up (§5.3) arrive as two events in one handler. Configuring on the
 *    first would ask `promptFor` about HUMAN/NOT_STARTED — the position that
 *    must never be observed, and on which it throws. Requests are coalesced to
 *    the end of the current task, so the position read is the settled one.
 *
 * 2. UPDATES ARE SERIAL, AND THE LATEST STATE WINS. `session.update` resolves
 *    on `session.updated`; two in flight could be applied out of order by
 *    nothing more than timing. One is in flight at a time, and a request made
 *    meanwhile re-reads the state when the first completes — so a position the
 *    call has already left is never sent after the one it moved to.
 *
 * 3. `channelCameFrom` IS THE TRANSITION BEING PROCESSED, NEVER STORED (§7.3).
 *    It is captured from the channel change that asked for this update and
 *    used once. That is what makes PARTY_HEDGE.txt appear on the return to a
 *    human and not on every later update — and what lets the next update, once
 *    the agent has actually disclosed, drop it.
 *
 * Only what differs from the last update is sent. A new prompt is logged as
 * `prompt.loaded` once the session has accepted it, because INV-6 and panel 6
 * read it as what the agent is working from.
 */

import { policyFor, positionId, type DisclosureTracker, type PositionPolicy } from '@holdharmless/callmodel';
import type { SessionConfig, ToolDefinition } from '@holdharmless/agent';
import type { AuthRequest, Call, Channel, NavMode, ToolName } from '@holdharmless/events';
import { promptFor, type PromptBundle } from '@holdharmless/prompts';
import { schemaFor } from './tool-schemas.js';
import type { EventLog } from './log.js';

/** The session surface this file uses: one method. */
export interface SessionUpdater {
  update(config: Partial<SessionConfig>): Promise<void>;
}

/** Everything the position depends on, read at the moment the update is built. */
export type PositionInputs = {
  call: Readonly<Call>;
  request: Readonly<AuthRequest>;
  navMode: NavMode;
  disclosure: DisclosureTracker;
  /** The hold segment that just ended, from holdSuspectedAt (ADR-017). */
  holdSegmentMs: number;
};

export type PositionConfig = {
  bundle: PromptBundle | null;
  policy: PositionPolicy | undefined;
  config: Partial<SessionConfig>;
};

export function toolDefinitions(names: readonly ToolName[]): ToolDefinition[] {
  return names.map((n) => {
    const s = schemaFor(n);
    return { name: s.name, description: s.description, parameters: s.parameters };
  });
}

/**
 * What the session should hold at this position. Pure: the same inputs give the
 * same configuration, which is what lets a test state it without a session.
 */
export function positionConfig(inputs: PositionInputs, channelCameFrom?: Channel): PositionConfig {
  const { call } = inputs;
  const policy = policyFor(positionId(call.channel, call.phase));
  const hedge = inputs.disclosure.promptInputs({
    channel: call.channel,
    ...(channelCameFrom ? { channelCameFrom } : {}),
    holdSegmentMs: inputs.holdSegmentMs,
  });
  const bundle = promptFor({
    channel: call.channel,
    phase: call.phase,
    ...(call.closingKind ? { closingKind: call.closingKind } : {}),
    navMode: inputs.navMode,
    ...(hedge.channelCameFrom ? { channelCameFrom: hedge.channelCameFrom } : {}),
    partyContinuityAssured: hedge.partyContinuityAssured,
    disclosedToCurrentParty: hedge.disclosedToCurrentParty,
    pendingContextCorrection: call.pendingContextCorrection,
    discardedToolResults: call.discardedToolResults,
    request: inputs.request,
    call,
  });

  // A position with no policy row is a position §5.6 says cannot be reached.
  // Sending nothing there would leave the previous position's tools live, so
  // the safe configuration is no tools at all.
  const config: Partial<SessionConfig> = {
    tools: toolDefinitions(policy?.tools ?? []),
    transcriptionMode: policy?.transcriptionMode ?? 'balanced',
    interruptResponse: policy?.interruptResponse ?? false,
    ...(policy?.interruptionDelayMs !== undefined ? { interruptionDelayMs: policy.interruptionDelayMs } : {}),
    // No prompt applies (DIALING, CLOSED, any DONE): the last one stays, and
    // with no tools there is nothing it can make the agent do.
    ...(bundle ? { systemPrompt: bundle.text } : {}),
  };
  return { bundle, policy, config };
}

export type ConfiguratorDeps = {
  session: SessionUpdater;
  log: EventLog;
  read: () => PositionInputs;
  /** A rejected update (session.error). Surfaced, never swallowed. */
  onFault: (err: unknown) => void;
  /** Where coalesced work runs. `queueMicrotask` by default. */
  defer?: (fn: () => void) => void;
};

export interface Configurator {
  /** Ask for the session to be brought to the current position. */
  request(channelCameFrom?: Channel): void;
  /** Resolves once nothing is pending or in flight. For tests and for shutdown. */
  idle(): Promise<void>;
  readonly updatesSent: number;
  stop(): void;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function createConfigurator(deps: ConfiguratorDeps): Configurator {
  const defer = deps.defer ?? queueMicrotask;
  const sent: Partial<SessionConfig> = {};
  let scheduled = false;
  let inFlight: Promise<void> | null = null;
  let again = false;
  let cameFrom: Channel | undefined;
  let updates = 0;
  let stopped = false;

  /** One update, for the state as it is NOW. A request made meanwhile starts another. */
  const run = async (): Promise<void> => {
    const from = cameFrom;
    cameFrom = undefined;
    const { bundle, config } = positionConfig(deps.read(), from);

    const diff: Partial<SessionConfig> = {};
    for (const [k, v] of Object.entries(config) as [keyof SessionConfig, unknown][]) {
      if (!same(sent[k], v)) (diff as Record<string, unknown>)[k] = v;
    }
    if (Object.keys(diff).length === 0) return;
    try {
      await deps.session.update(diff);
    } catch (err) {
      // Not recorded as sent: the next request will try the same fields again.
      deps.onFault(err);
      return;
    }
    Object.assign(sent, diff);
    updates++;
    // Logged once the session has ACCEPTED it: `prompt.loaded` is a claim
    // about what the agent is working from, and INV-6 reads it as one. Only
    // when the prompt itself changed — under today's §5.6 table no two
    // positions share a prompt and differ in policy, so the condition cannot
    // yet be told apart from "on every update" by any test; it is kept for the
    // day a row makes them differ.
    if (bundle && diff.systemPrompt !== undefined) {
      deps.log.append({
        t: 'prompt.loaded',
        files: bundle.files,
        hedged: bundle.hedged,
        disclosureIncluded: bundle.disclosureIncluded,
        substitutions: bundle.substitutions,
      });
    }
  };

  const start = (): void => {
    if (scheduled || inFlight) return;
    scheduled = true;
    defer(() => {
      scheduled = false;
      // Checked HERE, where the work would run, and nowhere earlier: this also
      // catches a stop() that arrives after the request was scheduled.
      if (stopped) return;
      inFlight = run().finally(() => {
        inFlight = null;
        // Requests that arrived while this one was in flight: ONE more update,
        // built from the state as it is then — so a position the call passed
        // through meanwhile is never sent after the one it moved on to.
        if (again) {
          again = false;
          start();
        }
      });
    });
  };

  return {
    request(channelCameFrom?: Channel): void {
      // The LAST transition in a batch is the one into the settled channel.
      // HUMAN → HOLD → HUMAN inside one task settles in HUMAN having come from
      // HOLD; keeping the first ("from HUMAN") would drop the party hedge.
      // A request with no transition (a phase change, a disclosure) keeps it.
      if (channelCameFrom !== undefined) cameFrom = channelCameFrom;
      if (inFlight) {
        again = true;
        return;
      }
      start();
    },
    async idle(): Promise<void> {
      for (;;) {
        await new Promise<void>((r) => defer(r));
        if (inFlight) await inFlight;
        else if (!scheduled) return;
      }
    },
    get updatesSent() {
      return updates;
    },
    stop(): void {
      stopped = true;
    },
  };
}
