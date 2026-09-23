/**
 * record_outcome's state-dependent rules — §8.5 and §8.5.1.
 *
 * Separate from the handler because these are the rules most likely to be
 * argued with, and they should be readable without the plumbing around them.
 *
 * WHAT IS HERE AND WHAT IS NOT. The five status rules and the operational
 * definition of a non-generic denial reason are here. Idempotency on requestId
 * (§8.5's redial case) belongs to the Work Queue, which owns AuthRequest
 * status across calls, and lands with module 3.3; the escalation rule below
 * asks its caller whether the log holds the evidence, because the handler does
 * not read the event log itself.
 */

import type { ToolRejectionReason } from '@holdharmless/events';
import type { ToolCallState } from './tools.js';

export type OutcomeValidation = { ok: true } | { ok: false; reason: string; category: ToolRejectionReason };

/**
 * §8.5.1's blocklist, verbatim. These may appear INSIDE a longer reason; what
 * is refused is a reason consisting of nothing else.
 */
export const DENIAL_BLOCKLIST = [
  'not medically necessary',
  'does not meet criteria',
  'not covered',
  'benefit exclusion',
  'insufficient documentation',
  'denied per policy',
  'member not eligible',
];

/** §8.5.1: a number, a code, or a time unit. Only these three. */
const SPECIFIC_TOKENS: readonly RegExp[] = [
  /\d/,
  /\b[A-Z]\d{2,}\b/,
  /\b(day|days|week|weeks|month|months|year|years)\b/i,
];

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!]+$/, '').trim();

/**
 * §8.5.1, as three conditions that must all hold. Returns null when accepted,
 * or the sentence the model is asked to replace it with.
 *
 * Drug and therapy names are deliberately not checked: that would need a
 * lexicon this project does not maintain, and a check that pretends to know
 * more than it does is worse than one that states its limit.
 */
export function denialReasonProblem(reason: string): string | null {
  if (reason.trim().length < 25) return 'denial_reason must be at least 25 characters and name the specific criterion, document or therapy step cited.';
  const normalized = normalize(reason);
  if (DENIAL_BLOCKLIST.some((entry) => normalized === entry)) {
    return `"${reason.trim()}" is boilerplate on its own. Ask which criterion was unmet, which document is missing, or which therapy step is required, and record that.`;
  }
  if (!SPECIFIC_TOKENS.some((re) => re.test(reason))) {
    return 'denial_reason contains no specific detail. Include the criterion number, the code, the document, or the time period the representative cited.';
  }
  return null;
}

export type OutcomeEvidence = {
  /** §8.5: the log holds a valid escalate_to_human call or a deterministic §8.6 summary. */
  hasEscalationSummary?: boolean;
};

/** §8.5's table, one branch per status. */
export function validateOutcomeArgs(
  args: Record<string, unknown>,
  state: ToolCallState,
  evidence: OutcomeEvidence = {},
): OutcomeValidation {
  const status = String(args['status']);

  if (status === 'approved') {
    const given = typeof args['auth_number'] === 'string' ? args['auth_number'] : '';
    const captured = state.call.capturedAuthNumber;
    if (!captured) {
      return {
        ok: false,
        category: 'validation_failed',
        reason: 'No authorization number was captured on this call, so an approval cannot be recorded. Call capture_auth_number when the representative states it.',
      };
    }
    // §8.2: compared against the STORED capture, byte for byte, with no
    // normalization. A comparison that trimmed or upper-cased would be
    // comparing the model against itself.
    if (given !== captured) {
      return {
        ok: false,
        category: 'validation_failed',
        reason: `auth_number "${given}" does not match the number captured during this call. Record exactly the value confirmed during read-back.`,
      };
    }
    return { ok: true };
  }

  if (status === 'denied') {
    const reason = typeof args['denial_reason'] === 'string' ? args['denial_reason'] : '';
    const problem = denialReasonProblem(reason);
    return problem ? { ok: false, category: 'validation_failed', reason: problem } : { ok: true };
  }

  if (status === 'pending_info') {
    const items = Array.isArray(args['missing_info']) ? (args['missing_info'] as unknown[]) : [];
    if (items.length === 0 || items.some((i) => typeof i !== 'string' || i.trim() === '')) {
      return { ok: false, category: 'validation_failed', reason: 'missing_info must list at least one document or data item the representative asked for.' };
    }
    return { ok: true };
  }

  if (status === 'escalated') {
    // INV-9: an escalation is recorded only where the log can show why.
    if (evidence.hasEscalationSummary === false) {
      return {
        ok: false,
        category: 'validation_failed',
        reason: 'No escalation summary exists for this call. Call escalate_to_human with a context summary first.',
      };
    }
    return { ok: true };
  }

  // call_failed carries no requirement (§8.5).
  return { ok: true };
}
