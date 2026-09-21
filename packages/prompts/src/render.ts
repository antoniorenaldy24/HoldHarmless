/**
 * The prompt renderer — §7.3 ("substitutes placeholders, evaluates <if> blocks")
 * and §7.4 ("[[MARKER]] annotations are ... stripped before sending").
 *
 * The rule throughout is that anything the renderer does not understand is an
 * error, never passed through. A prompt that reaches the model with a literal
 * `<CLINIC_NAME>` or an unevaluated `<if>` in it is an instruction the model
 * will try to follow, and nothing downstream would notice.
 */

import type { AuthRequest, Call } from '@holdharmless/events';

export type RenderSources = { request: Readonly<AuthRequest>; call: Readonly<Call> };

export type Rendered = {
  text: string;
  /** Placeholder NAMES, in order of first use. Values are not logged here. */
  substitutions: string[];
  /** [[MARKER]] names in the order they appear, before stripping. */
  markerOrder: string[];
};

/**
 * Optional fields a prompt may name, and what to say when they are unset.
 *
 * Each entry needs a reason, or this becomes a way to hide a missing value.
 * lastReference: DISCLOSURE.txt names it inside `<if attempts > 0>`, and a
 * follow-up call can legitimately have no reference — the first call may have
 * ended before one was given. The prompt already says "if you have one".
 * Every other unset field is an error: READBACK.txt with no captured number,
 * for example, means READBACK was entered without capture_auth_number, which
 * §5.4 does not allow.
 */
export const UNSET_FALLBACK: Readonly<Record<string, string>> = {
  lastReference: 'none on file',
};

/** snake / UPPER_SNAKE to camelCase: CLINIC_NAME -> clinicName (same as check #12). */
export function camel(name: string): string {
  return name.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * The declared fields of each entity. Presence on the runtime object cannot be
 * used instead: an optional field that is unset is simply absent, and would be
 * indistinguishable from a name that exists on neither type. `Record<keyof X,
 * true>` makes the compiler reject a list that misses or invents a field.
 */
const REQUEST_FIELDS: Record<keyof AuthRequest, true> = {
  id: true, patientRef: true, memberId: true, patientDob: true, cptCode: true, icdCode: true,
  providerNpi: true, serviceDate: true, payerId: true, payerEndpoint: true, clinicName: true,
  clinicCallbackPhone: true, priority: true, clinicalSummary: true, status: true, attempts: true,
  lastReference: true,
};
const CALL_FIELDS: Record<keyof Call, true> = {
  id: true, requestId: true, transport: true, navMode: true, networkProfile: true, startedAt: true,
  endedAt: true, channel: true, phase: true, closingKind: true, holdSuspected: true, holdSuspectedAt: true,
  holdDurationMs: true, cumulativeHoldMs: true, humanChannelMs: true, disclosedToCurrentParty: true,
  partiesDetected: true, disclosuresDelivered: true, capturedAuthNumber: true, readbackAttempts: true,
  rePromptCounts: true, holdRampSteps: true, pendingContextCorrection: true, discardedToolResults: true,
  sessionId: true, outcomeWritten: true, billableSessionMs: true, outcome: true,
};

/**
 * Looks a field up on AuthRequest, then Call. A name present on both is
 * refused rather than resolved by precedence: `id` means different things on
 * each, and a silent precedence rule would pick one without saying so.
 */
function lookup(field: string, src: RenderSources): { found: boolean; value: unknown } {
  const onRequest = Object.hasOwn(REQUEST_FIELDS, field);
  const onCall = Object.hasOwn(CALL_FIELDS, field);
  if (onRequest && onCall) throw new Error(`placeholder field "${field}" is ambiguous: it exists on both AuthRequest and Call`);
  if (onRequest) return { found: true, value: (src.request as Record<string, unknown>)[field] };
  if (onCall) return { found: true, value: (src.call as Record<string, unknown>)[field] };
  return { found: false, value: undefined };
}

function resolve(token: string, src: RenderSources): string {
  const field = camel(token);
  const { found, value } = lookup(field, src);
  if (!found) {
    throw new Error(`placeholder <${token}> resolves to "${field}", which names no field on AuthRequest or Call`);
  }
  if (value === undefined || value === null || value === '') {
    const fallback = UNSET_FALLBACK[field];
    if (fallback !== undefined) return fallback;
    throw new Error(`placeholder <${token}> resolves to "${field}", which is unset`);
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`placeholder <${token}> resolves to "${field}", which is not a string or number`);
  }
  return String(value);
}

const IF_OPEN = /^<if\s+([a-z][A-Za-z0-9]*)\s*(=|!=|>=|<=|>|<)\s*([A-Za-z0-9_.-]+)\s*>$/;

function condition(line: string, src: RenderSources): boolean {
  const m = IF_OPEN.exec(line.trim());
  if (!m) throw new Error(`unrecognized <if> line: ${line.trim()}`);
  const [, field, op, literal] = m as unknown as [string, string, string, string];
  const { found, value } = lookup(field, src);
  if (!found) throw new Error(`<if ${field} ...> names no field on AuthRequest or Call`);

  if (op === '=' || op === '!=') {
    const eq = String(value) === literal;
    return op === '=' ? eq : !eq;
  }
  const a = Number(value);
  const b = Number(literal);
  if (typeof value !== 'number' || Number.isNaN(b)) {
    throw new Error(`<if ${field} ${op} ${literal}> is a numeric comparison on a non-number`);
  }
  switch (op) {
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    default: throw new Error(`unreachable operator ${op}`);
  }
}

/** Evaluates <if> blocks line by line. Blocks do not nest; a nested one is an error. */
function evaluateIfs(text: string, src: RenderSources): string {
  const out: string[] = [];
  let inside: boolean | undefined; // undefined = not in a block
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('<if')) {
      if (inside !== undefined) throw new Error('nested <if> blocks are not supported');
      inside = condition(t, src);
      continue;
    }
    if (t === '</if>') {
      if (inside === undefined) throw new Error('</if> without an open <if>');
      inside = undefined;
      continue;
    }
    if (inside === false) continue;
    out.push(line);
  }
  if (inside !== undefined) throw new Error('<if> block is never closed');
  return out.join('\n');
}

export function render(raw: string, src: RenderSources): Rendered {
  const text0 = raw.replaceAll('\r', '');
  const markerOrder = [...text0.matchAll(/\[\[([A-Z_]+)\]\]/g)].map((m) => m[1]!);

  // Markers occupy their own lines; the whole line goes.
  let text = text0
    .split('\n')
    .filter((line) => !/^\s*\[\[[A-Z_]+\]\]\s*$/.test(line))
    .join('\n');
  if (/\[\[|\]\]/.test(text)) throw new Error('a [[MARKER]] shares a line with prompt text, so it cannot be stripped cleanly');

  text = evaluateIfs(text, src);

  const substitutions: string[] = [];
  text = text.replace(/<([A-Z][A-Z0-9_]*)>/g, (_, token: string) => {
    if (!substitutions.includes(token)) substitutions.push(token);
    return resolve(token, src);
  });

  // Anything still shaped like a tag is a construct this renderer does not know.
  const leftover = /<\/?[A-Za-z][^>\n]*>/.exec(text);
  if (leftover) throw new Error(`unrendered construct left in prompt: ${leftover[0]}`);

  // Collapse the blank runs that removed blocks leave behind.
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { text, substitutions, markerOrder };
}
