/**
 * The eight tool schemas — §8.1, in code.
 *
 * They are duplicated from the SSOT deliberately: the model needs them at
 * session.update time and the handler needs them to validate arguments, and
 * neither can parse a Markdown document at runtime. The duplication is held
 * honest by a test that parses §8.1 and compares it with this table field by
 * field, so a schema changed in one place and not the other fails the suite
 * rather than drifting quietly.
 */

import type { ToolName } from '@holdharmless/events';

export type JsonSchema = {
  type: 'object';
  properties: Record<string, PropertySchema>;
  required?: string[];
};

export type PropertySchema = {
  type: 'string' | 'boolean' | 'array';
  description?: string;
  pattern?: string;
  minLength?: number;
  minItems?: number;
  enum?: string[];
  items?: { type: 'string'; enum?: string[] };
  examples?: string[];
};

export type ToolSchema = { type: 'function'; name: ToolName; description: string; parameters: JsonSchema };

export const AUTH_REQUEST_FIELDS = [
  'member_id', 'patient_dob', 'cpt_code', 'icd_code',
  'provider_npi', 'service_date', 'priority', 'clinical_summary',
] as const;

export const OUTCOME_STATUSES = ['approved', 'denied', 'pending_info', 'escalated', 'call_failed'] as const;
export const REFERENCE_KINDS = ['call_reference', 'case_number', 'ticket_number', 'other'] as const;

export const TOOL_SCHEMAS: readonly ToolSchema[] = [
  {
    type: 'function',
    name: 'send_dtmf',
    description: 'Press digits on the telephone keypad to navigate an IVR menu. Use only after the menu has finished reading. One menu level per call.',
    parameters: {
      type: 'object',
      properties: {
        digits: { type: 'string', pattern: '^[0-9*#]{1,4}$', description: 'Digits for a single menu level.' },
        reason: { type: 'string', description: 'The menu option chosen, for the audit log.' },
      },
      required: ['digits', 'reason'],
    },
  },
  {
    type: 'function',
    name: 'get_auth_request',
    description: 'Retrieve details of the prior authorization request in progress. Request only the fields the representative has asked for.',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', enum: [...AUTH_REQUEST_FIELDS] },
          description: 'Fields the representative asked for.',
        },
      },
      required: ['fields'],
    },
  },
  {
    type: 'function',
    name: 'capture_auth_number',
    description: 'Call the moment the representative states the authorization number, before reading anything back. Capture it exactly as spoken, including letters, spelled-out letters, and separators.',
    parameters: {
      type: 'object',
      properties: {
        // NO `pattern` HERE, and that is a measured decision (A-24, 2026-09-24).
        // ADR-020 suggested one as a lever for entity-aware waiting; with
        // '^[A-Z0-9-]{3,20}$' the model heard the number correctly and then did
        // not call the tool at all in 19 of 20 cases. The cost was not a worse
        // value, it was no value.
        value: { type: 'string', minLength: 3, description: 'The authorization number exactly as the representative said it.' },
        spoken_form: { type: 'string', description: 'Optional: how they said it, if it differed from the value. Diagnostics only.' },
      },
      required: ['value'],
    },
  },
  {
    type: 'function',
    name: 'confirm_readback',
    description: 'Call after reading the authorization number back. Set matched to true only if the representative explicitly confirmed it.',
    parameters: {
      type: 'object',
      properties: {
        matched: { type: 'boolean', description: 'True only on an explicit confirmation. Silence is not confirmation.' },
        corrected_value: { type: 'string', description: 'Required when matched is false and the representative gave a different number.' },
      },
      required: ['matched'],
    },
  },
  {
    type: 'function',
    name: 'notify_transfer',
    description: 'Call immediately when the representative says they are transferring you to another department, team, or person.',
    parameters: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'The destination department or role, as named.' },
        quote: { type: 'string', description: 'The sentence indicating the transfer, for audit.' },
      },
      required: ['destination'],
    },
  },
  {
    type: 'function',
    name: 'capture_reference',
    description: 'Call immediately when the representative gives a call reference number, ticket number, or case number.',
    parameters: {
      type: 'object',
      properties: {
        reference: { type: 'string', description: 'The reference exactly as spoken, including letters.' },
        kind: { type: 'string', enum: [...REFERENCE_KINDS] },
      },
      required: ['reference'],
    },
  },
  {
    type: 'function',
    name: 'escalate_to_human',
    description: 'Flag that this question requires the clinic’s clinical staff.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why clinical staff are needed.' },
        context_summary: { type: 'string', minLength: 40, description: "The first sentence must be exactly 'EXPEDITED.' or 'Routine.'" },
      },
      required: ['reason', 'context_summary'],
    },
  },
  {
    type: 'function',
    name: 'record_outcome',
    description: 'Record the final result of this call. Call this BEFORE saying goodbye. Calling it does not end the call.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...OUTCOME_STATUSES] },
        auth_number: { type: 'string', description: 'Required when status is approved. Must be exactly the value confirmed during read-back.' },
        denial_reason: { type: 'string', minLength: 25, description: 'Required when status is denied.' },
        missing_info: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Required when status is pending_info.' },
        notes: { type: 'string' },
      },
      required: ['status'],
    },
  },
];

export function schemaFor(name: ToolName): ToolSchema {
  const schema = TOOL_SCHEMAS.find((s) => s.name === name);
  if (!schema) throw new Error(`no schema for tool ${name}`);
  return schema;
}
