/**
 * scripts/check-doc-claims.ts — module 1.7, the twelve checks of §17.3.
 *
 * Exits non-zero on any problem so CI goes red. Reads the SSOT, the prompt files
 * in packages/prompts/files, and the code tables in packages/callmodel.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDocChecks } from '@holdharmless/invariants';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ssot = fs.readFileSync(process.env.HH_SSOT ?? path.join(root, 'holdharmless-ssot-v1.2.md'), 'utf8');
const promptDir = process.env.HH_PROMPTS ?? path.join(root, 'packages/prompts/files');
const prompts = new Map(
  fs.readdirSync(promptDir).filter((f) => f.endsWith('.txt')).map((f) => [f, fs.readFileSync(path.join(promptDir, f), 'utf8')]),
);

const results = runDocChecks({ ssot, prompts });
let failed = 0;
for (const r of results) {
  const ok = r.problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} ${r.title}`);
  for (const p of r.problems) console.log(`        - ${p}`);
}
console.log(`\n${results.length - failed}/${results.length} document checks passed`);
process.exit(failed === 0 ? 0 : 1);
