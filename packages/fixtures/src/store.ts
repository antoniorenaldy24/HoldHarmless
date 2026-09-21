/**
 * Fixtures on disk: one directory each, holding
 *   fixture.json    everything but the timeline and events
 *   timeline.jsonl  one TimelineItem per line
 *   events.jsonl    one CallEvent per line
 *
 * WHERE THEY LIVE. Fixtures contain real, consented voices (§6.6), so fixture
 * DATA stays out of any public repository. The default root, packages/fixtures/
 * data/, is gitignored, and a test fails if anything under it is tracked. The
 * recorder and player code is in the repository: it holds no voice, and code
 * kept out of the repository would be code CI never runs.
 *
 * Both save and load refuse a fixture that fails INV-12 (synthetic data only)
 * or has no valid network profile. A fixture is loaded far more often than it
 * is saved, and a file edited by hand is still a fixture.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallEvent, NetworkProfileName } from '@holdharmless/events';
import { syntheticViolations } from '@holdharmless/invariants';
import { FIXTURE_FORMAT_VERSION, type Fixture, type TimelineItem } from './format.js';

export const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');

const PROFILES: readonly NetworkProfileName[] = ['CLEAN', 'TELEPHONY', 'DEGRADED'];
const KINDS = new Set<TimelineItem['kind']>(['server', 'client', 'far_end_audio', 'agent_audio', 'timer']);

export function validateFixture(fx: Fixture): string[] {
  const problems: string[] = [];
  if (fx.formatVersion !== FIXTURE_FORMAT_VERSION) problems.push(`formatVersion ${String(fx.formatVersion)} is not ${FIXTURE_FORMAT_VERSION}`);
  if (!PROFILES.includes(fx.networkProfile)) problems.push(`networkProfile "${String(fx.networkProfile)}" is not one of ${PROFILES.join(', ')}`);
  for (const v of syntheticViolations(fx.request)) problems.push(`INV-12: request.${String(v.field)} = "${v.value}" — ${v.rule}`);

  let last = 0;
  fx.timeline.forEach((item, i) => {
    if (!KINDS.has(item.kind)) problems.push(`timeline[${i}]: unknown kind "${String(item.kind)}"`);
    if (typeof item.atMs !== 'number' || !Number.isFinite(item.atMs)) problems.push(`timeline[${i}]: atMs is not a number`);
    else if (item.atMs < last) problems.push(`timeline[${i}]: atMs ${item.atMs} goes backwards from ${last}`);
    else last = item.atMs;
  });
  fx.events.forEach((e, i) => {
    if (e.seq !== i + 1) problems.push(`events[${i}]: seq ${e.seq}, expected ${i + 1}`);
  });
  return problems;
}

function assertValid(fx: Fixture, where: string): void {
  const problems = validateFixture(fx);
  if (problems.length > 0) throw new Error(`fixture ${fx.id} (${where}) is invalid:\n  ${problems.join('\n  ')}`);
}

const toJsonl = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r) + '\n').join('');

function fromJsonl<T>(file: string): T[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as T;
    } catch {
      // Unlike an event log, a fixture is written once and whole: a bad line
      // anywhere, including the last, means the file is not what was recorded.
      throw new Error(`${file}:${i + 1} is not valid JSON`);
    }
  });
}

export function saveFixture(fx: Fixture, root: string = FIXTURE_ROOT): string {
  assertValid(fx, 'save');
  const dir = path.join(root, fx.id);
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const { timeline, events, ...meta } = fx;
  fs.writeFileSync(path.join(tmp, 'fixture.json'), JSON.stringify(meta, null, 2) + '\n');
  fs.writeFileSync(path.join(tmp, 'timeline.jsonl'), toJsonl(timeline));
  fs.writeFileSync(path.join(tmp, 'events.jsonl'), toJsonl(events));

  // Written aside and moved into place, so a crash never leaves half a fixture
  // under the real name.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  return dir;
}

export function loadFixture(dir: string): Fixture {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8')) as Omit<Fixture, 'timeline' | 'events'>;
  const fx: Fixture = {
    ...meta,
    timeline: fromJsonl<TimelineItem>(path.join(dir, 'timeline.jsonl')),
    events: fromJsonl<CallEvent>(path.join(dir, 'events.jsonl')),
  };
  assertValid(fx, 'load');
  return fx;
}

export function listFixtures(root: string = FIXTURE_ROOT): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'fixture.json')))
    .map((d) => d.name)
    .sort();
}
