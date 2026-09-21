/**
 * The static half of the invariants — module 1.6, run by scripts/check-invariants.ts.
 *
 *   INV-11  every reachable position has a policy and an exit      (K-1)
 *   INV-16  the network profiles exist and TELEPHONY is the default
 *   INV-17  every tool effect has a transition that produces it     (K-3)
 *   INV-21  every transition row names a producer from the six      (K-6)
 *   §18     no matrix cell is left as "?"
 *
 * Each check takes the tables it reads as parameters, with the real ones as
 * defaults. That is not a testing convenience: acceptance 1.6 requires the
 * checker to FAIL on a deliberately removed producer, which can only be shown by
 * handing it a table with one removed.
 */

import { PRODUCER_KINDS } from '@holdharmless/events';
import {
  TABLES,
  POSITION_POLICY,
  TOOL_EFFECT,
  TOOL_ALLOWLIST,
  reachablePositions,
  deadEnds,
  type TransitionTables,
} from '@holdharmless/callmodel';
import { PROFILES } from '@holdharmless/transport';
import { section, tables } from './ssot.js';

export type CheckResult = { id: string; title: string; problems: string[] };

const result = (id: string, title: string, problems: string[]): CheckResult => ({ id, title, problems });

export function checkPolicyCoverage(
  t: TransitionTables = TABLES,
  policy: Readonly<Partial<Record<string, unknown>>> = POSITION_POLICY,
): CheckResult {
  const problems: string[] = [];
  const reachable = reachablePositions(t);
  for (const id of reachable) if (policy[id] === undefined) problems.push(`${id} is reachable but has no policy`);
  for (const id of Object.keys(policy)) {
    if (!reachable.has(id as never)) problems.push(`${id} has a policy but is unreachable`);
  }
  for (const id of deadEnds(t)) problems.push(`${id} is reachable and has no exit`);
  return result('INV-11', 'every reachable position has a policy and an exit', problems);
}

export function checkProducers(t: TransitionTables = TABLES): CheckResult {
  const problems: string[] = [];
  for (const row of [...t.channel, ...t.phase]) {
    const label = `${row.from} -> ${row.to} ("${row.via}")`;
    if (row.producer === undefined || row.producer === null) {
      problems.push(`${label} names no producer`);
      continue;
    }
    if (!(PRODUCER_KINDS as readonly string[]).includes(row.producer)) {
      problems.push(`${label} names producer "${row.producer}", which is not in the closed set`);
    }
    if (row.producer === 'tool' && !row.tool) problems.push(`${label} is tool-produced but names no tool`);
  }
  return result('INV-21', 'every transition names a producer from the closed set of six', problems);
}

export function checkToolEffects(
  t: TransitionTables = TABLES,
  effects: typeof TOOL_EFFECT = TOOL_EFFECT,
  allowlist: typeof TOOL_ALLOWLIST = TOOL_ALLOWLIST,
): CheckResult {
  const problems: string[] = [];
  for (const [position, tools] of Object.entries(allowlist)) {
    for (const tool of tools ?? []) {
      if (!(tool in effects)) problems.push(`${position} permits ${tool}, which declares no TOOL_EFFECT`);
    }
  }
  for (const [tool, effect] of Object.entries(effects)) {
    if (effect.none) continue;
    const rows = [...t.channel, ...t.phase].filter((r) => r.tool === tool);
    if (rows.length === 0) {
      problems.push(`${tool} declares an effect on ${effect.channel ?? effect.phase} but no transition is produced by it`);
    }
  }
  return result('INV-17', 'every tool effect has a transition that produces it', problems);
}

export function checkProfiles(ssot: string): CheckResult {
  const problems: string[] = [];
  for (const name of ['CLEAN', 'TELEPHONY', 'DEGRADED'] as const) {
    if (!PROFILES[name]) problems.push(`profile ${name} is not defined`);
  }
  const config = tables(section(ssot, '13')).flatMap((tb) => tb.rows);
  const row = config.find((r) => r[0]?.includes('NETWORK_PROFILE'));
  if (!row) problems.push('§13 does not declare NETWORK_PROFILE');
  else if (!row[1]?.includes('TELEPHONY')) problems.push(`§13 NETWORK_PROFILE defaults to ${row[1]}, not TELEPHONY`);
  return result('INV-16', 'network profiles exist and TELEPHONY is the default', problems);
}

/**
 * §18: "a single symbol for both 'checked and irrelevant' and 'not yet examined'
 * is what lets an unexamined cell read as settled." A "?" is an unanswered
 * question shipped as decided.
 */
export function checkUnconsideredCells(ssot: string): CheckResult {
  const problems: string[] = [];
  for (const tb of tables(section(ssot, '18'))) {
    // The legend table defines the "?" symbol itself; it is not a matrix row.
    if (tb.header[0] === 'Symbol') continue;
    for (const row of tb.rows) {
      row.forEach((cell, col) => {
        if (cell.replace(/[`*]/g, '').trim() === '?') {
          problems.push(`§18 "${row[0]?.replace(/\*/g, '')}" x "${tb.header[col]?.replace(/`/g, '')}" is "?"`);
        }
      });
    }
  }
  return result('§18', 'no cross-check cell is left unconsidered', problems);
}

export function runStaticChecks(ssot: string): CheckResult[] {
  return [
    checkPolicyCoverage(),
    checkProducers(),
    checkToolEffects(),
    checkProfiles(ssot),
    checkUnconsideredCells(ssot),
  ];
}
