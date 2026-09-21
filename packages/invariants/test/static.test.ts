/**
 * Acceptance criteria for module 1.6 (§21 week 1):
 *   "Runs INV-11, INV-16, INV-17, INV-21 statically; FAILS on a deliberately
 *    removed producer and on a deliberately added ? cell"
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { TABLES, POSITION_POLICY, TOOL_EFFECT, TOOL_ALLOWLIST, type TransitionTables } from '@holdharmless/callmodel';
import {
  checkPolicyCoverage, checkProducers, checkToolEffects, checkProfiles, checkUnconsideredCells, runStaticChecks,
} from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Normalized to LF on read. Editors and tools on Windows write CRLF, and a
// mutation containing a line break would silently match nothing on such a
// checkout: a test that passes in CI and fails locally is not a test.
const SSOT = fs
  .readFileSync(path.join(ROOT, 'holdharmless-ssot-v1.2.md'), 'utf8')
  .replaceAll(String.fromCharCode(13), '');

describe('the real tables and the real SSOT pass', () => {
  test('all five static checks', () => {
    for (const r of runStaticChecks(SSOT)) assert.deepEqual(r.problems, [], `${r.id}: ${r.problems.join('; ')}`);
  });
});

describe('INV-21 — fails on a deliberately removed producer (acceptance 1.6)', () => {
  test('a row with its producer deleted', () => {
    const mutated: TransitionTables = {
      channel: TABLES.channel.map((r, i) => (i === 5 ? ({ ...r, producer: undefined } as never) : r)),
      phase: TABLES.phase,
    };
    const r = checkProducers(mutated);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0]!, /names no producer/);
  });

  test('a producer outside the closed set', () => {
    const mutated: TransitionTables = {
      channel: TABLES.channel,
      phase: TABLES.phase.map((r, i) => (i === 0 ? ({ ...r, producer: 'intuition' } as never) : r)),
    };
    assert.match(checkProducers(mutated).problems[0]!, /not in the closed set/);
  });

  test('a tool-produced row that forgets which tool', () => {
    const i = TABLES.phase.findIndex((r) => r.tool === 'capture_auth_number');
    const { tool: _dropped, ...withoutTool } = TABLES.phase[i]!;
    const mutated: TransitionTables = { channel: TABLES.channel, phase: TABLES.phase.map((r, j) => (j === i ? withoutTool : r)) };
    assert.match(checkProducers(mutated).problems[0]!, /names no tool/);
  });
});

describe('INV-17 and INV-11 — removing the only producer of a tool effect', () => {
  // Removing the capture_auth_number row is the K-3 failure — a tool permitted
  // somewhere with no transition to carry its effect — and it also strands READBACK.
  const mutated: TransitionTables = {
    channel: TABLES.channel,
    phase: TABLES.phase.filter((r) => r.tool !== 'capture_auth_number'),
  };

  test('INV-17 reports the tool whose effect no transition produces', () => {
    const r = checkToolEffects(mutated);
    assert.ok(r.problems.some((p) => p.includes('capture_auth_number')), r.problems.join('; '));
  });

  test('INV-11 reports the positions that became unreachable yet keep a policy', () => {
    const r = checkPolicyCoverage(mutated);
    assert.ok(r.problems.some((p) => p.startsWith('HUMAN/READBACK has a policy but is unreachable')), r.problems.join('; '));
  });

  test('a tool permitted somewhere with no declared effect', () => {
    const { confirm_readback: _gone, ...fewer } = TOOL_EFFECT;
    const r = checkToolEffects(TABLES, fewer as typeof TOOL_EFFECT, TOOL_ALLOWLIST);
    assert.ok(r.problems.some((p) => p.includes('confirm_readback, which declares no TOOL_EFFECT')));
  });

  test('a reachable position with its policy removed', () => {
    const { 'IVR/READBACK': _gone, ...fewer } = POSITION_POLICY;
    assert.match(checkPolicyCoverage(TABLES, fewer).problems[0]!, /IVR\/READBACK is reachable but has no policy/);
  });
});

describe('§18 — fails on a deliberately added ? cell (acceptance 1.6)', () => {
  test('a "?" in a matrix cell', () => {
    const broken = SSOT.replace('| **`clear` on entry** | yes |', '| **`clear` on entry** | ? |');
    assert.notEqual(broken, SSOT, 'the mutation must actually change the text');
    const r = checkUnconsideredCells(broken);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0]!, /clear.*on entry.*IVR\/NOT_STARTED.*"\?"/);
  });

  test('the legend row that DEFINES "?" is not itself a violation', () => {
    assert.deepEqual(checkUnconsideredCells(SSOT).problems, []);
  });
});

describe('INV-16 — static', () => {
  test('a non-TELEPHONY default in §13 fails', () => {
    const broken = SSOT.replace('| `NETWORK_PROFILE` | `TELEPHONY` |', '| `NETWORK_PROFILE` | `CLEAN` |');
    assert.match(checkProfiles(broken).problems[0]!, /defaults to `CLEAN`, not TELEPHONY/);
  });
});

describe('scripts/check-invariants.ts — the process CI runs', () => {
  const run = (ssotPath?: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts/check-invariants.ts')], {
      cwd: ROOT,
      env: { ...process.env, ...(ssotPath ? { HH_SSOT: ssotPath } : {}) },
      encoding: 'utf8',
    });

  test('exits 0 on the real SSOT', () => {
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test('exits 1 on an SSOT with a "?" cell, and names it', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hh-ssot-')), 'broken.md');
    fs.writeFileSync(tmp, SSOT.replace('| **`clear` on entry** | yes |', '| **`clear` on entry** | ? |'));
    const r = run(tmp);
    assert.equal(r.status, 1, 'CI must go red');
    assert.match(r.stdout, /FAIL\s+§18/);
  });
});
