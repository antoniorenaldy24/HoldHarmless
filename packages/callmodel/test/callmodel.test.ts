/**
 * Acceptance criteria for module 1.4 (§21 week 1):
 *   "gateFor and positionId are total; POSITION_POLICY covers every reachable
 *    pair; TOOL_EFFECT and TOOL_ALLOWLIST agree; the compiler rejects an
 *    unhandled Channel or Phase"
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PRODUCER_KINDS, type Channel, type Phase, type ToolName } from '@holdharmless/events';
import {
  CHANNELS, PHASES, positionId, parsePositionId, allPositions, assertNever,
  gateFor,
  CHANNEL_TRANSITIONS, PHASE_TRANSITIONS, reachablePositions, deadEnds, edgesFrom, settle,
  POSITION_POLICY, TOOL_EFFECT, TOOL_ALLOWLIST,
} from '../src/index.js';

describe('gateFor (ADR-007)', () => {
  test('is total over every channel x holdSuspected x navMode', () => {
    for (const channel of CHANNELS) {
      for (const holdSuspected of [true, false]) {
        for (const navMode of ['dtmf', 'speech'] as const) {
          const gate = gateFor(channel, holdSuspected, navMode);
          assert.ok(['open', 'closed', 'dtmf_only'].includes(gate), `${channel}/${holdSuspected}/${navMode} -> ${gate}`);
        }
      }
    }
  });

  test('matches the ADR-007 table exactly', () => {
    assert.equal(gateFor('HUMAN', false, 'dtmf'), 'open');
    assert.equal(gateFor('IVR', false, 'dtmf'), 'dtmf_only');
    assert.equal(gateFor('IVR', false, 'speech'), 'open');
    for (const c of ['HOLD', 'TRANSFER', 'DIALING', 'CLOSED'] as const) {
      assert.equal(gateFor(c, false, 'speech'), 'closed');
    }
  });

  test('suspicion dominates the channel — even a HUMAN channel is closed', () => {
    // The interval where the gate is closed and the channel has not yet moved is
    // deliberate (§5.5): the system goes quiet while unsure, then decides.
    for (const channel of CHANNELS) {
      assert.equal(gateFor(channel, true, 'speech'), 'closed', channel);
    }
  });

  test('phase is not an input — the gate cannot depend on workflow progress', () => {
    assert.equal(gateFor.length, 3, 'gateFor(channel, holdSuspected, navMode) and nothing else');
  });
});

describe('positionId', () => {
  test('is total and round-trips over the full cartesian product', () => {
    const all = allPositions();
    assert.equal(all.length, CHANNELS.length * PHASES.length);
    assert.equal(new Set(all).size, all.length, 'no two positions share an id');
    for (const id of all) {
      const { channel, phase } = parsePositionId(id);
      assert.equal(positionId(channel, phase), id);
    }
  });
});

describe('reachability (INV-11, K-1)', () => {
  const reachable = reachablePositions();

  test('POSITION_POLICY covers every reachable pair (acceptance 1.4)', () => {
    const uncovered = [...reachable].filter((id) => POSITION_POLICY[id] === undefined);
    assert.deepEqual(uncovered, [], `reachable with no policy: ${uncovered.join(', ')}`);
  });

  test('no policy row exists for an unreachable pair', () => {
    // A row for a position that cannot occur is a claim that it can.
    const orphaned = Object.keys(POSITION_POLICY).filter((id) => !reachable.has(id as never));
    assert.deepEqual(orphaned, [], `policy for unreachable: ${orphaned.join(', ')}`);
  });

  test('every reachable position except CLOSED/DONE has an exit', () => {
    assert.deepEqual(deadEnds(), []);
  });

  test('IVR is reachable in every working phase — the §18 correction', () => {
    // §18 claimed "IVR with a later phase cannot occur". HUMAN -> HOLD -> IVR is
    // a path through §5.3's own rows, and INV-13 keeps the phase riding along.
    for (const phase of ['EXCHANGE', 'READBACK', 'CLOSING'] as const) {
      assert.ok(reachable.has(positionId('IVR', phase)), `IVR/${phase} should be reachable`);
    }
  });

  test('the most common path — queue hold answered by a person — reaches EXCHANGE', () => {
    // IVR -> HOLD -> HUMAN. If the NOT_STARTED -> EXCHANGE follow-up applied only
    // to IVR -> HUMAN, as §5.3's annotation alone suggests, this path would land
    // in HUMAN/NOT_STARTED: no policy, no tools, no prompt.
    const fromHold = edgesFrom('HOLD', 'NOT_STARTED').find((e) => e.via.startsWith('semantic HUMAN'));
    assert.equal(fromHold?.to, 'HUMAN/EXCHANGE');
    assert.equal(reachable.has('HUMAN/NOT_STARTED'), false, 'never a resting state');
  });

  test('TRANSFER is unreachable before a human has answered', () => {
    assert.equal(reachable.has('TRANSFER/NOT_STARTED'), false);
  });
});

describe('INV-13 — the two dimensions stay orthogonal', () => {
  test('a channel transition changes phase only through the two atomic follow-ups', () => {
    for (const channel of CHANNELS) {
      for (const phase of PHASES) {
        for (const edge of edgesFrom(channel, phase).filter((e) => e.kind === 'channel')) {
          const next = parsePositionId(edge.to);
          if (next.phase === phase) continue;
          const allowed =
            (next.channel === 'HUMAN' && phase === 'NOT_STARTED' && next.phase === 'EXCHANGE') ||
            (next.channel === 'CLOSED' && next.phase === 'DONE');
          assert.ok(allowed, `${edge.from} -> ${edge.to} via "${edge.via}" moved the phase`);
        }
      }
    }
  });

  test('settle() is idempotent', () => {
    for (const c of CHANNELS) {
      for (const p of PHASES) {
        const once = settle(c, p);
        assert.deepEqual(settle(once.channel, once.phase), once);
      }
    }
  });
});

describe('INV-21 — every transition names a producer (static half)', () => {
  test('every row carries a producer from the closed set of six', () => {
    for (const t of [...CHANNEL_TRANSITIONS, ...PHASE_TRANSITIONS]) {
      assert.ok((PRODUCER_KINDS as readonly string[]).includes(t.producer), `"${t.via}" has producer ${t.producer}`);
    }
  });

  test('a tool producer always names its tool', () => {
    for (const t of [...CHANNEL_TRANSITIONS, ...PHASE_TRANSITIONS]) {
      if (t.producer === 'tool') assert.ok(t.tool, `"${t.via}" is tool-produced but names no tool`);
    }
  });

  test('CLOSING -> DONE is produced by reply.done, never by a tool (ADR-015)', () => {
    const toDone = PHASE_TRANSITIONS.filter((t) => t.from === 'CLOSING' && t.to === 'DONE');
    assert.equal(toDone.length, 1);
    assert.equal(toDone[0]!.producer, 'session');
    assert.equal(
      PHASE_TRANSITIONS.some((t) => t.tool === 'record_outcome'),
      false,
      'record_outcome must not move the phase — the agent would be past the closing before speaking it',
    );
  });
});

describe('tools — TOOL_EFFECT and TOOL_ALLOWLIST agree', () => {
  const allTools = Object.keys(TOOL_EFFECT) as ToolName[];

  test('every tool in any allowlist has a declared effect (§17.3 check #9)', () => {
    for (const [id, tools] of Object.entries(TOOL_ALLOWLIST)) {
      for (const tool of tools!) assert.ok(tool in TOOL_EFFECT, `${id} permits ${tool}, which declares no effect`);
    }
  });

  test('INV-17 — every tool that moves channel or phase has a transition that does it', () => {
    for (const tool of allTools) {
      const effect = TOOL_EFFECT[tool];
      if (effect.none) continue;
      const producing = [...CHANNEL_TRANSITIONS, ...PHASE_TRANSITIONS].filter((t) => t.tool === tool);
      assert.ok(producing.length > 0, `${tool} declares an effect but no transition is produced by it (K-3)`);
      if (effect.channel) assert.ok(producing.some((t) => t.to === effect.channel), `${tool} never reaches ${effect.channel}`);
      if (effect.phase && effect.phase !== 'BY_ARGUMENT') {
        assert.ok(producing.some((t) => t.to === effect.phase), `${tool} never reaches ${effect.phase}`);
      }
    }
  });

  test('a tool that moves state is permitted somewhere it can fire', () => {
    for (const tool of allTools) {
      if (TOOL_EFFECT[tool].none) continue;
      const permittedAt = Object.entries(TOOL_ALLOWLIST).filter(([, ts]) => ts!.includes(tool)).map(([id]) => id);
      assert.ok(permittedAt.length > 0, `${tool} moves state but is permitted nowhere`);
    }
  });

  test('the allowlist is derived from POSITION_POLICY, not declared beside it (§8.7)', () => {
    for (const [id, policy] of Object.entries(POSITION_POLICY)) {
      assert.deepEqual(TOOL_ALLOWLIST[id as never], policy!.tools);
    }
  });

  test('no tool is permitted where no human can hear the agent act on it', () => {
    // HOLD and TRANSFER carry no tools (§5.6), because "the gate blocks audio, not
    // cognition" (§8.7) — the model still receives transcripts during hold.
    for (const phase of PHASES) {
      assert.deepEqual(POSITION_POLICY[positionId('HOLD', phase)]?.tools ?? [], []);
      assert.deepEqual(POSITION_POLICY[positionId('TRANSFER', phase)]?.tools ?? [], []);
    }
  });

  test('DONE positions do nothing — above all, no silence recovery', () => {
    for (const channel of ['HUMAN', 'HOLD', 'IVR', 'TRANSFER'] as const) {
      const p = POSITION_POLICY[positionId(channel, 'DONE')];
      assert.ok(p, `${channel}/DONE needs a policy`);
      assert.deepEqual(p!.tools, []);
      assert.equal(p!.silenceTimeoutMs, undefined, `${channel}/DONE must not start a new turn on a closed call`);
    }
  });
});

describe('§5.6 values', () => {
  test('interrupt_response is true exactly where a human is present and work remains', () => {
    for (const phase of ['EXCHANGE', 'READBACK', 'CLOSING'] as const) {
      assert.equal(POSITION_POLICY[positionId('HUMAN', phase)]!.interruptResponse, true, phase);
    }
  });

  test('interruption_delay is set only in EXCHANGE (700) and READBACK (800) — ADR-011', () => {
    for (const [id, p] of Object.entries(POSITION_POLICY)) {
      const expected = id === 'HUMAN/EXCHANGE' ? 700 : id === 'HUMAN/READBACK' ? 800 : undefined;
      assert.equal(p!.interruptionDelayMs, expected, id);
    }
  });

  test('max_accuracy exactly where numbers are exchanged — ADR-010', () => {
    for (const [id, p] of Object.entries(POSITION_POLICY)) {
      const expected = id === 'HUMAN/EXCHANGE' || id === 'HUMAN/READBACK';
      assert.equal(p!.transcriptionMode === 'max_accuracy', expected, id);
    }
  });

  test('no policy sets min_silence or max_silence — ADR-009', () => {
    for (const [id, p] of Object.entries(POSITION_POLICY)) {
      assert.equal('minSilence' in p!, false, id);
      assert.equal('maxSilence' in p!, false, id);
    }
  });
});

describe('the compiler rejects an unhandled Channel or Phase', () => {
  // These functions exist to be TYPE-CHECKED, not run. Each omits one member of
  // its union and marks the resulting error with @ts-expect-error. The file
  // compiles only while the compiler keeps rejecting the incomplete switch: if it
  // ever stopped, the directive would be unused and `pnpm typecheck` would fail.

  function incompleteChannel(c: Channel): string {
    switch (c) {
      case 'DIALING':
      case 'IVR':
      case 'HOLD':
      case 'TRANSFER':
      case 'HUMAN':
        return c;
      default:
        // @ts-expect-error — 'CLOSED' is unhandled, so `c` is not `never` here.
        return assertNever(c, 'channel');
    }
  }

  function incompletePhase(p: Phase): string {
    switch (p) {
      case 'NOT_STARTED':
      case 'EXCHANGE':
      case 'READBACK':
      case 'CLOSING':
        return p;
      default:
        // @ts-expect-error — 'DONE' is unhandled, so `p` is not `never` here.
        return assertNever(p, 'phase');
    }
  }

  test('the omitted member reaches the runtime guard', () => {
    assert.equal(incompleteChannel('HUMAN'), 'HUMAN');
    assert.throws(() => incompleteChannel('CLOSED'), /Unhandled channel/);
    assert.throws(() => incompletePhase('DONE'), /Unhandled phase/);
  });
});
