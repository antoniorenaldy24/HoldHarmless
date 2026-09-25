/**
 * A call, played into the log in real time — §19.3 ("replay a stored call").
 *
 * WHY THIS IS NOT CHEATING, and where the line is. The orchestrator that runs a
 * live call is week 4; the dashboard is week 3. Without a source the eight
 * panels can only be shown against frozen data, and a panel that has never
 * updated is a panel whose update path has never been tested — which is exactly
 * the class of failure a rehearsal finds at the worst moment.
 *
 * So this appends a scripted call to the real `EventLog`, through the real
 * append path, at real timing. Every panel derives from it exactly as it will
 * from a live call, and the events are the same `CallEventBody` shapes the rest
 * of the system emits. What is synthetic is the CONTENT — a call that did not
 * happen — and the dashboard says so on screen while it is playing.
 *
 * The script is deliberately the awkward call rather than the happy one: the
 * gate shuts on suspicion twenty seconds before the channel reaches HOLD (the
 * interval panel 4 exists to show), the representative transfers to a second
 * party, and the read-back is corrected before it is confirmed.
 */

import type { CallEventBody } from '@holdharmless/events';
import type { EventLog } from './log.js';

export type ScriptStep = { atMs: number; body: CallEventBody };

/**
 * `hold.suspected.atMs` is EPOCH milliseconds — the zero point of the hold
 * segment — while a step's `atMs` is an offset into the call. The player
 * resolves the first from the second, because a script written by hand cannot
 * know when it will be played and writing an offset there put a fifty-six year
 * hold segment on panel 2.
 */
const withCallClock = (body: CallEventBody, baseMs: number, atMs: number): CallEventBody =>
  body.t === 'hold.suspected' ? { ...body, atMs: baseMs + atMs } : body;

const turn = (speaker: 'agent' | 'far_end', text: string, over: { partial?: boolean; redactable?: boolean; isClosing?: boolean } = {}): CallEventBody => ({
  t: 'turn.transcribed',
  speaker,
  text,
  partial: over.partial ?? false,
  redactable: over.redactable ?? false,
  isClosing: over.isClosing ?? false,
});

/**
 * Times are the call's own, in milliseconds from `call.started`. The player
 * compresses them; the RATIOS are what the panels show, so they are kept true
 * to the profile rather than made snappy.
 */
export const DEMO_SCRIPT: readonly ScriptStep[] = [
  { atMs: 0, body: { t: 'call.started', requestId: 'SYN-REQ-14', attempts: 1, priority: 'expedited', networkProfile: 'TELEPHONY' } },
  { atMs: 400, body: { t: 'channel.changed', from: 'DIALING', to: 'IVR', producer: { kind: 'transport', cause: 'link_established' } } },
  { atMs: 400, body: { t: 'gate.changed', from: 'closed', to: 'dtmf_only', channel: 'IVR', holdSuspected: false, clearSent: false, producer: { kind: 'transport', cause: 'link_established' } } },
  { atMs: 500, body: { t: 'prompt.loaded', files: ['IVR_DTMF.txt'], hedged: false, disclosureIncluded: false, substitutions: [] } },
  { atMs: 3000, body: turn('far_end', 'Thank you for calling. For prior authorization, press two.') },
  { atMs: 3200, body: { t: 'semantic.observed', obs: { at: '', seq: 3, scores: { IVR_PROMPT: 0.91, HUMAN: 0.06, HOLD_CUE: 0.03 }, winner: 'IVR_PROMPT', confidence: 0.91, effectiveMinWeight: 0.45, signalsAvailable: ['menu_language', 'ordinal_digits'], sourceDelta: 'For prior authorization, press', accepted: true } } },
  { atMs: 5000, body: { t: 'dtmf.sent', digits: '2', reason: 'prior authorization' } },
  { atMs: 5400, body: { t: 'dtmf.decoded', digits: '2', windowsUsed: 6 } },

  // The interval ADR-007 exists for: suspicion shuts the gate at 8 s; the
  // channel does not reach HOLD until the autocorrelation window fills at 28 s.
  { atMs: 8000, body: { t: 'acoustic.observed', obs: { at: '', seq: 32, scores: { SILENCE: 0.01, PERIODIC: 0.88, SPEECH_LIKE: 0.11 }, winner: 'PERIODIC', tier: 'provisional', confidence: 0.88, signalsAvailable: ['rms', 'pause_ratio', 'spectral_flatness'], windowsMs: { rms: 250, pause_ratio: 2000, spectral_flatness: 1000 }, accepted: true } } },
  // atMs below is a placeholder: the player rewrites it to epoch time.
  { atMs: 8000, body: { t: 'hold.suspected', trigger: 'periodic_provisional', atMs: 0 } },
  { atMs: 8000, body: { t: 'gate.changed', from: 'dtmf_only', to: 'closed', channel: 'IVR', holdSuspected: true, clearSent: true, producer: { kind: 'acoustic', seq: 32 } } },
  { atMs: 28000, body: { t: 'acoustic.observed', obs: { at: '', seq: 112, scores: { SILENCE: 0.01, PERIODIC: 0.94, SPEECH_LIKE: 0.05 }, winner: 'PERIODIC', tier: 'confirmed', confidence: 0.94, signalsAvailable: ['rms', 'pause_ratio', 'spectral_flatness', 'autocorrelation'], windowsMs: { rms: 250, pause_ratio: 2000, spectral_flatness: 1000, autocorrelation: 20000 }, accepted: true } } },
  { atMs: 28000, body: { t: 'channel.changed', from: 'IVR', to: 'HOLD', producer: { kind: 'acoustic', seq: 112 } } },
  { atMs: 28000, body: { t: 'hold.cleared', reason: 'hold_confirmed' } },
  { atMs: 28100, body: { t: 'prompt.loaded', files: ['HOLD.txt'], hedged: false, disclosureIncluded: false, substitutions: [] } },
  { atMs: 40000, body: { t: 'hold.tick', elapsedMs: 12000, rampStep: 1 } },
  { atMs: 60000, body: { t: 'hold.tick', elapsedMs: 32000, rampStep: 2 } },

  // A person. The atomic group of §5.5: channel, phase and gate together.
  { atMs: 74000, body: { t: 'semantic.observed', obs: { at: '', seq: 300, scores: { IVR_PROMPT: 0.08, HUMAN: 0.89, HOLD_CUE: 0.03 }, winner: 'HUMAN', confidence: 0.89, effectiveMinWeight: 0.45, signalsAvailable: ['first_person', 'responsiveness', 'no_menu_language'], sourceDelta: 'Prior auth, this is Dana', accepted: true } } },
  { atMs: 74000, body: { t: 'channel.changed', from: 'HOLD', to: 'HUMAN', producer: { kind: 'semantic', seq: 300 } } },
  { atMs: 74000, body: { t: 'phase.changed', from: 'NOT_STARTED', to: 'EXCHANGE', producer: { kind: 'semantic', seq: 300 } } },
  { atMs: 74000, body: { t: 'gate.changed', from: 'closed', to: 'open', channel: 'HUMAN', holdSuspected: false, clearSent: false, producer: { kind: 'semantic', seq: 300 } } },
  { atMs: 74200, body: { t: 'prompt.loaded', files: ['PARTY_HEDGE.txt', 'EXCHANGE.txt'], hedged: true, disclosureIncluded: false, substitutions: ['CLINIC_NAME'] } },
  { atMs: 74500, body: turn('far_end', 'Prior authorization, this is Dana.') },
  { atMs: 75800, body: { t: 'harness.telemetry', metric: 'perceived_response_ms', value: 387 } },
  { atMs: 76000, body: turn('agent', "Hi Dana — I'm an AI assistant calling on behalf of Riverside Oncology about an expedited prior authorization.") },
  { atMs: 76000, body: { t: 'disclosure.delivered', partyIndex: 1, quote: "I'm an AI assistant calling on behalf of Riverside Oncology" } },
  { atMs: 79000, body: turn('far_end', 'Sure — can I get the member ID and date of birth?') },
  { atMs: 80200, body: { t: 'harness.telemetry', metric: 'perceived_response_ms', value: 412 } },
  { atMs: 81000, body: { t: 'tool.called', toolCallId: 'tc-1', name: 'get_auth_request', args: { fields: ['memberId', 'patientDob'] } } },
  { atMs: 81006, body: { t: 'tool.returned', toolCallId: 'tc-1', name: 'get_auth_request', result: { ok: true }, latencyMs: 6 } },
  { atMs: 82000, body: turn('agent', 'Member ID M four four eight two one, date of birth March fourteenth, nineteen seventy.', { redactable: true }) },

  // A transfer: a second party, and a disclosure owed to them.
  { atMs: 88000, body: turn('far_end', 'That one goes to pharmacy review — let me put you through.') },
  { atMs: 88400, body: { t: 'tool.called', toolCallId: 'tc-2', name: 'notify_transfer', args: { destination: 'pharmacy review' } } },
  { atMs: 88404, body: { t: 'tool.returned', toolCallId: 'tc-2', name: 'notify_transfer', result: { ok: true }, latencyMs: 4 } },
  { atMs: 88410, body: { t: 'channel.changed', from: 'HUMAN', to: 'TRANSFER', producer: { kind: 'tool', seq: 0, name: 'notify_transfer' } } },
  { atMs: 88410, body: { t: 'gate.changed', from: 'open', to: 'closed', channel: 'TRANSFER', holdSuspected: false, clearSent: true, producer: { kind: 'tool', seq: 0, name: 'notify_transfer' } } },
  { atMs: 88410, body: { t: 'party.changed', reason: 'transfer', newIndex: 2 } },
  { atMs: 101000, body: { t: 'channel.changed', from: 'TRANSFER', to: 'HUMAN', producer: { kind: 'semantic', seq: 420 } } },
  { atMs: 101000, body: { t: 'gate.changed', from: 'closed', to: 'open', channel: 'HUMAN', holdSuspected: false, clearSent: false, producer: { kind: 'semantic', seq: 420 } } },
  { atMs: 101200, body: { t: 'prompt.loaded', files: ['PARTY_HEDGE.txt', 'EXCHANGE.txt'], hedged: true, disclosureIncluded: false, substitutions: ['CLINIC_NAME'] } },
  { atMs: 102000, body: turn('far_end', 'Pharmacy review, this is Marcus.') },
  { atMs: 103500, body: turn('agent', "Hi Marcus — I'm an AI assistant calling on behalf of Riverside Oncology. I'm following up on an expedited authorization.") },
  { atMs: 103500, body: { t: 'disclosure.delivered', partyIndex: 2, quote: "I'm an AI assistant calling on behalf of Riverside Oncology" } },

  // The number, read back, corrected, then confirmed.
  { atMs: 112000, body: turn('far_end', "It's approved. Authorization number P as in papa, A as in alpha, four nine two, one six seven nine.") },
  { atMs: 113000, body: { t: 'tool.called', toolCallId: 'tc-3', name: 'capture_auth_number', args: { value: 'PA4921679' } } },
  { atMs: 113008, body: { t: 'tool.returned', toolCallId: 'tc-3', name: 'capture_auth_number', result: { ok: true }, latencyMs: 8 } },
  { atMs: 113008, body: { t: 'auth_number.captured', value: 'PA4921679' } },
  { atMs: 113008, body: { t: 'phase.changed', from: 'EXCHANGE', to: 'READBACK', producer: { kind: 'tool', seq: 0, name: 'capture_auth_number' } } },
  { atMs: 113200, body: { t: 'prompt.loaded', files: ['READBACK.txt'], hedged: false, disclosureIncluded: false, substitutions: ['CAPTURED_AUTH_NUMBER'] } },
  { atMs: 115000, body: turn('agent', 'Let me read that back: P as in papa, A as in alpha, four', { partial: true }) },
  { atMs: 116500, body: turn('far_end', 'Sorry — four nine two, one six seven nine. The last two are seven nine.') },
  { atMs: 117200, body: { t: 'tool.called', toolCallId: 'tc-4', name: 'confirm_readback', args: { matched: false, corrected_value: 'PA4921679' } } },
  { atMs: 117206, body: { t: 'tool.returned', toolCallId: 'tc-4', name: 'confirm_readback', result: { ok: true }, latencyMs: 6 } },
  { atMs: 117206, body: { t: 'phase.changed', from: 'READBACK', to: 'EXCHANGE', producer: { kind: 'tool', seq: 0, name: 'confirm_readback' } } },
  { atMs: 119000, body: turn('agent', 'P as in papa, A as in alpha, four nine two one six seven nine. Is that right?') },
  { atMs: 121000, body: turn('far_end', "That's it.") },
  { atMs: 121600, body: { t: 'tool.called', toolCallId: 'tc-5', name: 'confirm_readback', args: { matched: true } } },
  { atMs: 121605, body: { t: 'tool.returned', toolCallId: 'tc-5', name: 'confirm_readback', result: { ok: true }, latencyMs: 5 } },
  { atMs: 121605, body: { t: 'phase.changed', from: 'EXCHANGE', to: 'CLOSING', producer: { kind: 'tool', seq: 0, name: 'confirm_readback' }, closingKind: 'wrapup' } },

  // ADR-015: the outcome is written BEFORE the closing is spoken.
  { atMs: 122000, body: { t: 'tool.called', toolCallId: 'tc-6', name: 'record_outcome', args: { status: 'approved', auth_number: 'PA4921679' } } },
  { atMs: 122007, body: { t: 'tool.returned', toolCallId: 'tc-6', name: 'record_outcome', result: { ok: true }, latencyMs: 7 } },
  { atMs: 122007, body: { t: 'outcome.written', writer: 'tool_handler', status: 'approved', skipped: false } },
  { atMs: 123000, body: turn('agent', "That's everything I needed — thank you for your help, Marcus.", { isClosing: true }) },
  { atMs: 126000, body: { t: 'phase.changed', from: 'CLOSING', to: 'DONE', producer: { kind: 'session', event: 'reply.done' } } },
  { atMs: 126500, body: { t: 'harness.telemetry', metric: 'billable_session_minutes', value: 2.1 } },
  { atMs: 127000, body: { t: 'call.ended', outcome: { status: 'approved', authNumber: 'PA4921679' } } },
];

export type PlayerOptions = {
  log: EventLog;
  script?: readonly ScriptStep[];
  /** 1 plays at the call's own pace; 8 makes a two-minute call fit a demo. */
  speed?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  onFinished?: () => void;
};

export interface DemoPlayer {
  stop(): void;
  readonly running: boolean;
}

export function playDemoCall(options: PlayerOptions): DemoPlayer {
  const script = options.script ?? DEMO_SCRIPT;
  const speed = options.speed ?? 8;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

  const handles: unknown[] = [];
  let running = true;
  // The call's own clock. Events are APPENDED fast and TIMESTAMPED true, so
  // panel 4 reports the twenty seconds the gate was actually shut rather than
  // the two and a half this replay takes to show them.
  const base = Date.now();

  script.forEach((step) => {
    handles.push(
      schedule(() => {
        if (!running) return;
        options.log.append(withCallClock(step.body, base, step.atMs), new Date(base + step.atMs).toISOString());
        if (step === script[script.length - 1]) {
          running = false;
          options.onFinished?.();
        }
      }, step.atMs / speed),
    );
  });

  return {
    stop(): void {
      running = false;
      for (const handle of handles) cancel(handle);
      handles.length = 0;
    },
    get running(): boolean {
      return running;
    },
  };
}
