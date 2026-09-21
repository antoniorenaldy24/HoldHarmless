/**
 * The twelve checks of §17.3 — module 1.7, run by scripts/check-doc-claims.ts.
 *
 * "A document can state that something is enforced while naming a mechanism that
 * cannot enforce it. Nothing runs, so no runtime check sees it." These read the
 * SSOT, the prompt files, and the code tables, and fail on the specific ways a
 * claim can point at nothing.
 *
 * Each check states its own limit where it has one. A checker that implies more
 * coverage than it has is the error class it was built to catch.
 */

import {
  POSITION_POLICY,
  TOOL_ALLOWLIST,
  TOOL_EFFECT,
  CHANNELS,
  PHASES,
  positionId,
  reachablePositions,
  type PositionId,
} from '@holdharmless/callmodel';
import type { Channel, Phase } from '@holdharmless/events';
import { codeBlocks, declaredFields, section, sectionNumbers, tables } from './ssot.js';
import { checkUnconsideredCells, type CheckResult } from './static.js';

export type DocInputs = {
  ssot: string;
  /** Prompt file name -> contents, as they exist in packages/prompts/files. */
  prompts: ReadonlyMap<string, string>;
};

const result = (id: string, title: string, problems: string[]): CheckResult => ({ id, title, problems });

const unique = <T>(xs: Iterable<T>) => [...new Set(xs)];

/** snake / UPPER_SNAKE to camelCase: CLINIC_NAME -> clinicName. */
export function camel(name: string): string {
  return name.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Shared readers
// ---------------------------------------------------------------------------

type ToolSchema = { name: string; parameters: { properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }> } };

function toolSchemas(ssot: string): ToolSchema[] {
  const json = codeBlocks(section(ssot, '8.1'), 'json')[0];
  if (!json) throw new Error('§8.1 has no JSON tool schema block');
  return JSON.parse(json) as ToolSchema[];
}

/** Field names declared in the §9.1 entity types and the §9.3 event types. */
function modelFields(ssot: string): { entity: Set<string>; all: Set<string> } {
  const entity = new Set<string>();
  for (const block of codeBlocks(section(ssot, '9.1'))) for (const f of declaredFields(block)) entity.add(f);
  const all = new Set(entity);
  for (const block of codeBlocks(section(ssot, '9.3'))) for (const f of declaredFields(block)) all.add(f);
  for (const block of codeBlocks(section(ssot, '9.2'))) for (const f of declaredFields(block)) all.add(f);
  return { entity, all };
}

// ---------------------------------------------------------------------------
// The twelve
// ---------------------------------------------------------------------------

/** #1 — every §N cross-reference resolves to a section that exists. */
export function check1(i: DocInputs): CheckResult {
  const defined = sectionNumbers(i.ssot);
  const refs = unique([...i.ssot.matchAll(/§(\d+(?:\.\d+)*)/g)].map((m) => m[1]!));
  // Exact match only. An earlier, lenient version accepted "§12.11" because a
  // section 12 exists — and so missed that 12.11 does not.
  const dangling = refs.filter((r) => !defined.has(r)).sort();
  return result('#1', 'every § cross-reference resolves', dangling.map((r) => `§${r} does not exist`));
}

/**
 * #2 — every tool parameter named in an invariant or validation rule exists in
 * that tool's schema. Recognizes `tool.param` and `tool(param: …)`.
 */
export function check2(i: DocInputs): CheckResult {
  const schemas = new Map(toolSchemas(i.ssot).map((t) => [t.name, new Set(Object.keys(t.parameters.properties))]));
  const text = [section(i.ssot, '17.1'), section(i.ssot, '8.2'), section(i.ssot, '8.5')].join('\n');
  const problems: string[] = [];
  const seen = new Set<string>();
  const patterns = [/`?([a-z_]+)\.([a-z_]+)`?/g, /([a-z_]+)\(([a-z_]+):/g];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const [tool, param] = [m[1]!, m[2]!];
      const params = schemas.get(tool);
      if (!params) continue;
      const key = `${tool}.${param}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!params.has(param)) problems.push(`${key} is named in a rule but ${tool} has no parameter "${param}"`);
    }
  }
  return result('#2', 'every tool parameter named in a rule exists in the schema', problems);
}

const CONFIG_SUFFIX = /_(MS|STEPS|MARGIN|WEIGHT|FLOOR|ATTEMPTS|URL|KEY|MODE|ENCODING|PROFILE|DIFFICULTY|TRANSCRIPT|DELAY|RATE|VOICE|N)$/;

/**
 * #3 — every configuration variable named in prose appears in §13.
 * Limit: a configuration variable is recognized by its suffix (…_MS, …_MODE and
 * so on) or an ENABLE_ prefix. A setting named with neither would be missed.
 */
export function check3(i: DocInputs): CheckResult {
  const declared = new Set<string>();
  for (const tb of tables(section(i.ssot, '13'))) {
    for (const row of tb.rows) for (const m of (row[0] ?? '').matchAll(/`([A-Z][A-Z0-9_]+)`/g)) declared.add(m[1]!);
  }
  const named = unique(
    [...i.ssot.matchAll(/`([A-Z][A-Z0-9_]+)`/g)]
      .map((m) => m[1]!)
      .filter((n) => n.includes('_') && (CONFIG_SUFFIX.test(n) || n.startsWith('ENABLE_'))),
  );
  const missing = named.filter((n) => !declared.has(n)).sort();
  return result('#3', 'every configuration variable in prose is declared in §13', missing.map((n) => `${n} is used but not declared in §13`));
}

/** #4 — every prompt file named in §7.3 exists in packages/prompts. */
export function check4(i: DocInputs): CheckResult {
  const named = unique([...section(i.ssot, '7.3').matchAll(/`([A-Z_]+\.txt)`/g)].map((m) => m[1]!));
  const missing = named.filter((n) => !i.prompts.has(n));
  const problems = missing.map((n) => `${n} is named in §7.3 but absent from packages/prompts/files`);
  if (named.length === 0) problems.push('§7.3 names no prompt files — the parser found nothing to check');
  return result('#4', 'every prompt file named in §7.3 exists', problems);
}

/** #5 — [[RECORD_OUTCOME]] precedes [[CLOSING]] in every file carrying both. The static half of INV-20. */
export function check5(i: DocInputs): CheckResult {
  const problems: string[] = [];
  for (const [name, text] of i.prompts) {
    const record = text.indexOf('[[RECORD_OUTCOME]]');
    const closing = text.indexOf('[[CLOSING]]');
    if (record === -1 || closing === -1) continue;
    if (closing < record) problems.push(`${name}: [[CLOSING]] comes before [[RECORD_OUTCOME]]`);
  }
  return result('#5', '[[RECORD_OUTCOME]] precedes [[CLOSING]] in every prompt (INV-20, static)', problems);
}

/** #6 — no §18 cell is "?". */
export function check6(i: DocInputs): CheckResult {
  const r = checkUnconsideredCells(i.ssot);
  return result('#6', 'no §18 cell is left as "?"', r.problems);
}

/**
 * Names that invariants use but that are DERIVED, never stored, and so correctly
 * appear on no type. Each needs a reason, or this list becomes a hiding place.
 */
export const DERIVED_NAMES: Readonly<Record<string, string>> = {
  gateIntent: 'ADR-007: computed by gateFor(), never stored',
};

/**
 * #7 — every field named in an invariant exists on a §9 type.
 * Scope: §17.1 names event fields as well as entity fields, so §9.1 through §9.3
 * are all searched. Limit: this proves a name exists on SOME type, not on the
 * type the invariant means. INV-15 named `toolCallId` against safety.violation,
 * which lacked it while tool.* events had it; that was found by implementing the
 * invariant, not by this check.
 */
export function check7(i: DocInputs): CheckResult {
  const { all } = modelFields(i.ssot);
  const inv = section(i.ssot, '17.1');
  // camelCase only: bare lowercase words in §17.1 are as often values
  // ('acoustic', 'open') as fields, and cannot be told apart by form.
  const named = unique([...inv.matchAll(/`([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)`/g)].map((m) => m[1]!));
  const missing = named.filter((n) => !all.has(n) && !(n in DERIVED_NAMES)).sort();
  return result('#7', 'every field named in an invariant exists on a §9 type', missing.map((n) => `\`${n}\` is named in §17.1 but declared on no §9 type`));
}

/**
 * #8 — every enum value in every tool schema appears in a table somewhere, so a
 * value cannot exist with no stated downstream behavior.
 */
export function check8(i: DocInputs): CheckResult {
  const cellText = tables(i.ssot).flatMap((tb) => [...tb.header, ...tb.rows.flat()]).join('\n');
  const problems: string[] = [];
  for (const tool of toolSchemas(i.ssot)) {
    for (const [param, spec] of Object.entries(tool.parameters.properties)) {
      const values = spec.enum ?? spec.items?.enum ?? [];
      for (const v of values) {
        if (!new RegExp(`\\b${v}\\b`).test(cellText)) problems.push(`${tool.name}.${param} = "${v}" appears in no table`);
      }
    }
  }
  return result('#8', 'every tool enum value appears in a mapping table', problems);
}

/** #9 — every tool in TOOL_ALLOWLIST appears in TOOL_EFFECT. */
export function check9(): CheckResult {
  const problems: string[] = [];
  for (const [position, tools] of Object.entries(TOOL_ALLOWLIST)) {
    for (const t of tools ?? []) if (!(t in TOOL_EFFECT)) problems.push(`${position} permits ${t}, absent from TOOL_EFFECT`);
  }
  return result('#9', 'every allowlisted tool has a declared effect', problems);
}

/** Expands a §5.6 channel cell: `IVR`, or "`HUMAN`, `HOLD`, …". */
function channelsIn(cell: string): Channel[] {
  const named = [...cell.matchAll(/`([A-Z]+)`/g)].map((m) => m[1] as Channel).filter((c) => (CHANNELS as readonly string[]).includes(c));
  if (/any but/i.test(cell)) return CHANNELS.filter((c) => !named.includes(c));
  return named;
}

/** Expands a §5.6 phase cell: `DONE`, "any working phase", or a list. */
function phasesIn(cell: string): Phase[] {
  if (/any working phase/i.test(cell)) return PHASES.filter((p) => p !== 'DONE');
  if (/^any$/i.test(cell.trim())) return [...PHASES];
  return [...cell.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1] as Phase).filter((p) => (PHASES as readonly string[]).includes(p));
}

/**
 * #10 — every REACHABLE (channel, phase) pair has a §5.6 row, and no §5.6 row
 * claims an unreachable pair; every reachable pair with silence recovery has a
 * §5.7 row.
 *
 * Amended in v1.3, with the project owner's approval: reachability is COMPUTED
 * from §5.3/§5.4 by reachablePositions(), not read from §18. The original check
 * trusted §18's own statement of what was reachable — and that statement was
 * wrong for IVR, so the check as first specified could not have caught the gap
 * it exists to catch.
 */
export function check10(i: DocInputs): CheckResult {
  const reachable = reachablePositions();
  const problems: string[] = [];

  const doc56 = new Set<PositionId>();
  const policyTable = tables(section(i.ssot, '5.6')).find((tb) => tb.header[0] === 'channel');
  if (!policyTable) return result('#10', 'reachable positions are documented', ['§5.6 policy table not found']);
  for (const row of policyTable.rows) {
    for (const c of channelsIn(row[0] ?? '')) for (const p of phasesIn(row[1] ?? '')) doc56.add(positionId(c, p));
  }
  for (const id of reachable) if (!doc56.has(id)) problems.push(`${id} is reachable but has no §5.6 row`);
  for (const id of doc56) if (!reachable.has(id)) problems.push(`§5.6 documents ${id}, which is unreachable`);

  const doc57 = new Set<PositionId>();
  const recoveryTable = tables(section(i.ssot, '5.7')).find((tb) => tb.header[0] === 'Position');
  for (const row of recoveryTable?.rows ?? []) {
    const cell = row[0] ?? '';
    const channel = cell.match(/`([A-Z]+)`/)?.[1] as Channel | undefined;
    if (!channel) continue;
    const phase = cell.match(/\/\s*`([A-Z_]+)`/)?.[1] as Phase | undefined;
    for (const p of phase ? [phase] : PHASES) doc57.add(positionId(channel, p));
  }
  for (const id of reachable) {
    if (POSITION_POLICY[id]?.silenceTimeoutMs !== undefined && !doc57.has(id)) {
      problems.push(`${id} has silence recovery in code but no §5.7 row`);
    }
  }
  return result('#10', 'every reachable position is documented in §5.6 and, where it recovers, §5.7', problems);
}

/**
 * #11 — every audio link in the §3.1 diagram has its endpoints described in §4,
 * and §4 states the audio format.
 * Scope: "every link" is read as every AUDIO link. Most edges in the diagram
 * carry control or data and have no audio format to state. Limit: direction is
 * not checked — §4.1 draws it as ASCII art, which no strict parser should guess
 * at. A wrong arrow is caught by reading, as the two corrected in v1.3 were.
 */
export function check11(i: DocInputs): CheckResult {
  const diagram = codeBlocks(section(i.ssot, '3.1'), 'mermaid')[0] ?? '';
  const four = section(i.ssot, '4');
  const labels = new Map<string, string>();
  for (const m of diagram.matchAll(/(\w+)(?:\[([^\]]+)\]|\{\{"([^"]+)"\}\}|\(\(([^)]+)\)\)|\[\(([^)]+)\)\])/g)) {
    labels.set(m[1]!, (m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').replace(/<br\/>.*/, '').trim());
  }
  const isAudio = (id: string) => /audio|loopback|playout|goertzel|assemblyai|acoustic|agent session/i.test(labels.get(id) ?? '');
  const problems: string[] = [];

  if (!/μ-law|pcmu/i.test(four)) problems.push('§4 does not state the audio format');

  // A label is described when §4 mentions what DISTINGUISHES it. The first
  // version matched a label's first word, so "Audio recorder" passed on the
  // strength of "Audio Bridge" — any audio component at all would have passed.
  // Generic audio-path words are therefore ignored; a label made only of them
  // must appear as a whole phrase.
  const GENERIC = new Set(['audio', 'link', 'layer', 'queue', 'bridge', 'session', 'api', 'voice', 'agent', 'assets', 'decoder', 'detector', 'local', 'windows', 'ms', 'live', 'mic', 'for', 'and', 'the']);
  const described = (label: string): boolean => {
    const words = label.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 1);
    const distinctive = words.filter((w) => !GENERIC.has(w) && !/^\d+$/.test(w));
    if (distinctive.length === 0) return four.toLowerCase().includes(label.toLowerCase());
    return distinctive.some((w) => four.toLowerCase().includes(w));
  };

  const edges = [...diagram.matchAll(/^\s*(\w+)\s*(<-->|-->)\s*(\w+)/gm)];
  for (const [, a, , b] of edges) {
    if (!isAudio(a!) || !isAudio(b!)) continue;
    for (const id of [a!, b!]) {
      const label = labels.get(id) ?? id;
      if (!described(label)) problems.push(`audio link ${a} - ${b}: "${label}" is not described in §4`);
    }
  }
  return result('#11', 'every audio link in §3.1 is described in §4', unique(problems));
}

/** #12 — every <UPPER_CASE> placeholder in every prompt maps to a §9.1 field. */
export function check12(i: DocInputs): CheckResult {
  const { entity } = modelFields(i.ssot);
  const problems: string[] = [];
  for (const [name, text] of i.prompts) {
    for (const m of text.matchAll(/<([A-Z][A-Z0-9_]*)>/g)) {
      const field = camel(m[1]!);
      if (!entity.has(field)) problems.push(`${name}: <${m[1]}> maps to "${field}", which is not a §9.1 field`);
    }
  }
  return result('#12', 'every prompt placeholder resolves to a §9.1 field', unique(problems));
}

export function runDocChecks(i: DocInputs): CheckResult[] {
  return [check1(i), check2(i), check3(i), check4(i), check5(i), check6(i), check7(i), check8(i), check9(), check10(i), check11(i), check12(i)];
}
