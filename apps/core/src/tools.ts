/**
 * Tool handlers — §8, interface in §12.9, module 3.1.
 *
 * THE ORDER OF THE THREE CHECKS IS THE DESIGN, and it is why this file exists
 * separately from the effects it drives:
 *
 *   1. AUTHORIZE against the position's allowlist (§5.6, §8.7) — before the
 *      arguments are even looked at. A tool the position forbids is refused
 *      whatever it carries, so a malformed argument can never be the reason a
 *      forbidden tool was noticed.
 *   2. VALIDATE the arguments against the §8.1 schema, then the §8.5 rules that
 *      depend on call state.
 *   3. EXECUTE, which is the first step with a side effect.
 *
 * Every refusal returns a reason the model can act on (§8.5: "Rejection returns
 * a tool.result asking for the specific criterion, document, or therapy cited"),
 * and is logged as tool.rejected with its category.
 *
 * SIDE EFFECTS PERSIST WHEN THE RESULT DOES NOT (§8.8 rule 3). This handler
 * writes its effect as soon as it executes; whether the RESULT MESSAGE reaches
 * the model is the session's business, and an interrupted reply discards the
 * message while the write stands. A handler that deferred its effect until the
 * result was delivered would lose a captured authorization number to a barge-in.
 */

import type {
  AuthRequest,
  Call,
  Channel,
  Outcome,
  Phase,
  ToolName,
  ToolRejectionReason,
} from '@holdharmless/events';
import { toolsAllowedAt } from '@holdharmless/callmodel';
import { schemaFor, type PropertySchema } from './tool-schemas.js';
import { validateOutcomeArgs, type OutcomeValidation } from './outcome-validation.js';

export type ToolCallState = {
  channel: Channel;
  phase: Phase;
  call: Readonly<Call>;
  request: Readonly<AuthRequest>;
};

/** What the handler is allowed to change. Each is a write the model asked for. */
export interface ToolEffects {
  sendDtmf(digits: string, reason: string): void;
  captureAuthNumber(value: string, spokenForm?: string): void;
  confirmReadback(matched: boolean, correctedValue?: string): void;
  notifyTransfer(destination: string, quote?: string): void;
  captureReference(reference: string, kind?: string): void;
  escalate(reason: string, contextSummary: string): void;
  recordOutcome(outcome: Outcome): void;
}

export type ToolEvent =
  | { t: 'tool.called'; toolCallId: string; name: ToolName; args: unknown }
  | { t: 'tool.returned'; toolCallId: string; name: ToolName; result: unknown; latencyMs: number }
  | { t: 'tool.rejected'; toolCallId: string; name: ToolName; reason: ToolRejectionReason; detail: string };

export type ToolHandlerOptions = {
  state: () => ToolCallState;
  effects: ToolEffects;
  emit?: (event: ToolEvent) => void;
  now?: () => number;
};

export type ToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; reason: string; category: ToolRejectionReason };

export interface ToolHandlers {
  handle(callId: string, toolCallId: string, name: ToolName, args: unknown): ToolOutcome;
}

// ---------------------------------------------------------------------------
// §8.1 schema conformance
// ---------------------------------------------------------------------------

/** Structural validation only: §8.5's state-dependent rules come after. */
export function validateAgainstSchema(name: ToolName, args: unknown): string | null {
  const schema = schemaFor(name).parameters;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'arguments must be an object';
  const record = args as Record<string, unknown>;

  for (const key of schema.required ?? []) {
    if (record[key] === undefined || record[key] === null) return `${key} is required`;
  }
  for (const [key, value] of Object.entries(record)) {
    const property = schema.properties[key];
    // An unknown argument is not fatal: models add fields, and refusing a call
    // for a harmless extra would cost a turn. It is simply not read.
    if (!property || value === undefined || value === null) continue;
    const problem = checkProperty(key, property, value);
    if (problem) return problem;
  }
  return null;
}

function checkProperty(key: string, property: PropertySchema, value: unknown): string | null {
  if (property.type === 'string') {
    if (typeof value !== 'string') return `${key} must be a string`;
    if (property.minLength !== undefined && value.length < property.minLength) {
      return `${key} must be at least ${property.minLength} characters`;
    }
    if (property.pattern !== undefined && !new RegExp(property.pattern).test(value)) {
      return `${key} does not match ${property.pattern}`;
    }
    if (property.enum && !property.enum.includes(value)) {
      return `${key} must be one of ${property.enum.join(', ')}`;
    }
    return null;
  }
  if (property.type === 'boolean') {
    return typeof value === 'boolean' ? null : `${key} must be true or false`;
  }
  // array
  if (!Array.isArray(value)) return `${key} must be an array`;
  if (property.minItems !== undefined && value.length < property.minItems) {
    return `${key} must have at least ${property.minItems} item${property.minItems === 1 ? '' : 's'}`;
  }
  if (property.items?.enum) {
    const bad = value.find((v) => typeof v !== 'string' || !property.items!.enum!.includes(v));
    if (bad !== undefined) return `${key} contains ${JSON.stringify(bad)}, which is not one of ${property.items.enum.join(', ')}`;
  }
  return null;
}

// ---------------------------------------------------------------------------

export function createToolHandlers(options: ToolHandlerOptions): ToolHandlers {
  const emit = options.emit ?? (() => {});
  const now = options.now ?? Date.now;

  return {
    handle(_callId: string, toolCallId: string, name: ToolName, args: unknown): ToolOutcome {
      const started = now();
      const state = options.state();
      emit({ t: 'tool.called', toolCallId, name, args });

      const refuse = (category: ToolRejectionReason, reason: string): ToolOutcome => {
        emit({ t: 'tool.rejected', toolCallId, name, reason: category, detail: reason });
        return { ok: false, reason, category };
      };
      const done = (result: unknown): ToolOutcome => {
        emit({ t: 'tool.returned', toolCallId, name, result, latencyMs: now() - started });
        return { ok: true, result };
      };

      // 1. Authorization, before anything else is considered.
      const allowed = toolsAllowedAt(state.channel, state.phase);
      if (!allowed.includes(name)) {
        return refuse(
          'state_not_allowed',
          `${name} is not available right now (${state.channel}/${state.phase}). Available: ${allowed.length > 0 ? allowed.join(', ') : 'none'}.`,
        );
      }

      // 2. Arguments: shape first, then the rules that need call state.
      const structural = validateAgainstSchema(name, args);
      if (structural) return refuse('validation_failed', structural);
      const a = args as Record<string, unknown>;

      if (name === 'record_outcome') {
        const verdict: OutcomeValidation = validateOutcomeArgs(a, state);
        if (!verdict.ok) return refuse(verdict.category, verdict.reason);
      }
      if (name === 'confirm_readback' && a['matched'] === false && typeof a['corrected_value'] !== 'string') {
        return refuse('validation_failed', 'corrected_value is required when matched is false: give the number the representative said instead.');
      }

      // 3. Execution. Every write below stands even if the reply that asked for
      // it is interrupted and its result message is discarded (§8.8 rule 3).
      switch (name) {
        case 'send_dtmf':
          options.effects.sendDtmf(String(a['digits']), String(a['reason']));
          return done({ ok: true, digits: a['digits'] });

        case 'get_auth_request': {
          const fields = a['fields'] as string[];
          const values = Object.fromEntries(fields.map((f) => [f, fieldValue(state.request, f)]));
          // §8.5's honest privacy note: `fields` limits the FIRST disclosure,
          // not later ones — once returned, a field stays in the context.
          return done({ ok: true, fields: values });
        }

        case 'capture_auth_number': {
          const value = String(a['value']);
          const spoken = typeof a['spoken_form'] === 'string' ? a['spoken_form'] : undefined;
          options.effects.captureAuthNumber(value, spoken);
          return done({ ok: true, captured: value });
        }

        case 'confirm_readback': {
          const matched = a['matched'] === true;
          const corrected = typeof a['corrected_value'] === 'string' ? a['corrected_value'] : undefined;
          options.effects.confirmReadback(matched, corrected);
          return done({ ok: true, matched });
        }

        case 'notify_transfer': {
          const destination = String(a['destination']);
          options.effects.notifyTransfer(destination, typeof a['quote'] === 'string' ? a['quote'] : undefined);
          return done({ ok: true, destination });
        }

        case 'capture_reference': {
          const reference = String(a['reference']);
          options.effects.captureReference(reference, typeof a['kind'] === 'string' ? a['kind'] : undefined);
          return done({ ok: true, reference });
        }

        case 'escalate_to_human': {
          options.effects.escalate(String(a['reason']), String(a['context_summary']));
          return done({ ok: true, escalated: true });
        }

        case 'record_outcome': {
          const outcome = outcomeFrom(a);
          options.effects.recordOutcome(outcome);
          // ADR-015: recording an outcome does NOT end the call. Saying so in
          // the result keeps the model from treating it as a goodbye.
          return done({ ok: true, recorded: outcome.status, call_continues: true });
        }

        default:
          return refuse('validation_failed', `unknown tool ${String(name)}`);
      }
    },
  };
}

function fieldValue(request: Readonly<AuthRequest>, field: string): unknown {
  switch (field) {
    case 'member_id': return request.memberId;
    case 'patient_dob': return request.patientDob;
    case 'cpt_code': return request.cptCode;
    case 'icd_code': return request.icdCode;
    case 'provider_npi': return request.providerNpi;
    case 'service_date': return request.serviceDate;
    case 'priority': return request.priority;
    case 'clinical_summary': return request.clinicalSummary;
    default: return null;
  }
}

function outcomeFrom(a: Record<string, unknown>): Outcome {
  const status = a['status'] as Outcome['status'];
  return {
    status,
    ...(typeof a['auth_number'] === 'string' ? { authNumber: a['auth_number'] } : {}),
    ...(typeof a['denial_reason'] === 'string' ? { denialReason: a['denial_reason'] } : {}),
    ...(Array.isArray(a['missing_info']) ? { missingInfo: a['missing_info'] as string[] } : {}),
    ...(typeof a['notes'] === 'string' ? { notes: a['notes'] } : {}),
  };
}
