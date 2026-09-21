/**
 * scripts/check-invariants.ts — module 1.6.
 *
 * Runs the static invariants against the real tables and the real SSOT, and exits
 * non-zero on any problem so CI goes red. §0: every error class has an automated
 * checker, because manual cross-reading "has demonstrably missed whole classes".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStaticChecks } from '@holdharmless/invariants';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// HH_SSOT lets the test suite point the checker at a deliberately broken copy
// and confirm the process exits non-zero — the path CI actually depends on.
const ssotPath = process.env.HH_SSOT ?? path.join(root, 'holdharmless-ssot-v1.2.md');
const ssot = fs.readFileSync(ssotPath, 'utf8');

const results = runStaticChecks(ssot);
let failed = 0;
for (const r of results) {
  const ok = r.problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(7)} ${r.title}`);
  for (const p of r.problems) console.log(`        - ${p}`);
}
console.log(`\n${results.length - failed}/${results.length} static checks passed`);
process.exit(failed === 0 ? 0 : 1);
