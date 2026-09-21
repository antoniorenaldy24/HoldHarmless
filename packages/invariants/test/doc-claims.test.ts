/**
 * Acceptance criteria for module 1.7 (§21 week 1):
 *   "All twelve checks implemented; FAILS on an inverted marker order, on an
 *    invariant naming a missing field, and on an unresolvable prompt placeholder"
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  runDocChecks, check1, check2, check3, check4, check5, check7, check8, check10, check11, check12, camel,
  type DocInputs,
} from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Normalized to LF on read. Editors and tools on Windows write CRLF, and a
// mutation containing a line break would silently match nothing on such a
// checkout: a test that passes in CI and fails locally is not a test.
const SSOT = fs
  .readFileSync(path.join(ROOT, 'holdharmless-ssot-v1.2.md'), 'utf8')
  .replaceAll(String.fromCharCode(13), '');
const PROMPT_DIR = path.join(ROOT, 'packages/prompts/files');
const PROMPTS = new Map(fs.readdirSync(PROMPT_DIR).map((f) => [f, fs.readFileSync(path.join(PROMPT_DIR, f), 'utf8')]));

const real: DocInputs = { ssot: SSOT, prompts: PROMPTS };
const withSsot = (ssot: string): DocInputs => ({ ssot, prompts: PROMPTS });
const withPrompt = (name: string, text: string): DocInputs => ({ ssot: SSOT, prompts: new Map([...PROMPTS, [name, text]]) });

function mutate(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), `mutation target not found: ${from.slice(0, 60)}`);
  return text.replace(from, to);
}

describe('the real SSOT and prompt files pass all twelve', () => {
  test('12/12', () => {
    const results = runDocChecks(real);
    assert.equal(results.length, 12);
    for (const r of results) assert.deepEqual(r.problems, [], `${r.id}: ${r.problems.join('; ')}`);
  });
});

describe('the three failures acceptance 1.7 names', () => {
  test('#5 — an inverted marker order', () => {
    const wrapup = PROMPTS.get('CLOSING_WRAPUP.txt')!;
    const inverted = wrapup.replace('[[RECORD_OUTCOME]]', '@@TMP@@').replace('[[CLOSING]]', '[[RECORD_OUTCOME]]').replace('@@TMP@@', '[[CLOSING]]');
    const r = check5(withPrompt('CLOSING_WRAPUP.txt', inverted));
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0]!, /CLOSING_WRAPUP\.txt: \[\[CLOSING\]\] comes before \[\[RECORD_OUTCOME\]\]/);
  });

  test('#7 — an invariant naming a field that exists on no type', () => {
    const broken = mutate(SSOT, '| **INV-8** | `notify_transfer` accepted implies', '| **INV-8** | `transferLatencyBudget` and `notify_transfer` accepted implies');
    const r = check7(withSsot(broken));
    assert.deepEqual(r.problems, ['`transferLatencyBudget` is named in §17.1 but declared on no §9 type']);
  });

  test('#12 — a placeholder that resolves to no field', () => {
    const r = check12(withPrompt('EXCHANGE.txt', PROMPTS.get('EXCHANGE.txt')! + '\nGreet <PATIENT_FAVORITE_COLOR>.\n'));
    assert.deepEqual(r.problems, ['EXCHANGE.txt: <PATIENT_FAVORITE_COLOR> maps to "patientFavoriteColor", which is not a §9.1 field']);
  });
});

describe('every other check can fail too', () => {
  test('#1 — a dangling section reference (the §12.11 that v1.2 shipped with)', () => {
    const r = check1(withSsot(mutate(SSOT, 'Interface in §12.10.', 'Interface in §12.11.')));
    assert.deepEqual(r.problems, ['§12.11 does not exist']);
  });

  test('#2 — a rule naming a tool parameter the schema lacks', () => {
    const broken = mutate(SSOT, '`record_outcome.auth_number` must equal', '`record_outcome.auth_code` must equal');
    assert.match(check2(withSsot(broken)).problems[0]!, /record_outcome\.auth_code .* no parameter "auth_code"/);
  });

  test('#3 — a configuration variable used in prose but not declared', () => {
    const broken = SSOT + '\n\nThe ramp waits `HOLD_RAMP_INTERVAL_MS` between steps.\n';
    assert.deepEqual(check3(withSsot(broken)).problems, ['HOLD_RAMP_INTERVAL_MS is used but not declared in §13']);
  });

  test('#4 — a prompt file named in §7.3 but missing', () => {
    const fewer = new Map([...PROMPTS].filter(([n]) => n !== 'PARTY_HEDGE.txt'));
    assert.deepEqual(check4({ ssot: SSOT, prompts: fewer }).problems, ['PARTY_HEDGE.txt is named in §7.3 but absent from packages/prompts/files']);
  });

  test('#8 — a tool enum value with no mapping', () => {
    const broken = mutate(SSOT, '"enum": ["call_reference", "case_number", "ticket_number", "other"]', '"enum": ["call_reference", "case_number", "ticket_number", "other", "fax_confirmation"]');
    assert.deepEqual(check8(withSsot(broken)).problems, ['capture_reference.kind = "fax_confirmation" appears in no table']);
  });

  test('#10 — a §5.6 row claiming an unreachable position', () => {
    const broken = mutate(SSOT, '| `HUMAN`, `HOLD`, `IVR`, `TRANSFER` | `DONE` |', '| any but `CLOSED` | `DONE` |');
    assert.deepEqual(check10(withSsot(broken)).problems, ['§5.6 documents DIALING/DONE, which is unreachable']);
  });

  test('#10 — a reachable position with no §5.6 row (the IVR gap v1.2 had)', () => {
    const broken = mutate(SSOT, '| `IVR` | any working phase |', '| `IVR` | `NOT_STARTED` |');
    const problems = check10(withSsot(broken)).problems;
    for (const p of ['EXCHANGE', 'READBACK', 'CLOSING']) {
      assert.ok(problems.includes(`IVR/${p} is reachable but has no §5.6 row`), problems.join('; '));
    }
  });

  test('#11 — an audio link whose endpoint §4 never describes', () => {
    const broken = mutate(SSOT, '    LB --> GZ\n', '    LB --> GZ\n    LB --> REC\n    REC[Audio recorder]\n');
    assert.match(check11(withSsot(broken)).problems[0]!, /"Audio recorder" is not described in §4/);
  });
});

describe('helpers', () => {
  test('camel() maps placeholder names to field names', () => {
    assert.equal(camel('CLINIC_NAME'), 'clinicName');
    assert.equal(camel('CAPTURED_AUTH_NUMBER'), 'capturedAuthNumber');
    assert.equal(camel('LAST_REFERENCE'), 'lastReference');
  });
});

describe('scripts/check-doc-claims.ts — the process CI runs', () => {
  const run = (env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts/check-doc-claims.ts')], {
      cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8',
    });

  test('exits 0 on the real SSOT', () => {
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /12\/12 document checks passed/);
  });

  test('exits 1 when a prompt inverts its markers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-prompts-'));
    for (const [n, t] of PROMPTS) fs.writeFileSync(path.join(dir, n), t);
    const wrapup = PROMPTS.get('CLOSING_WRAPUP.txt')!;
    fs.writeFileSync(
      path.join(dir, 'CLOSING_WRAPUP.txt'),
      wrapup.replace('[[RECORD_OUTCOME]]', '@@').replace('[[CLOSING]]', '[[RECORD_OUTCOME]]').replace('@@', '[[CLOSING]]'),
    );
    const r = run({ HH_PROMPTS: dir });
    assert.equal(r.status, 1, 'CI must go red');
    assert.match(r.stdout, /FAIL\s+#5/);
  });
});
