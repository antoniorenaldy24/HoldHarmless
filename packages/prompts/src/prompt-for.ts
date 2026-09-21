/**
 * Prompt assembly — §7.3, with the interface of §12.7.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthRequest, Call, Channel, ClosingKind, NavMode, Phase } from '@holdharmless/events';
import { render } from './render.js';

export const PROMPT_FILES = [
  'CONTEXT_CORRECTION.txt',
  'PARTY_HEDGE.txt',
  'DISCLOSURE.txt',
  'IVR_DTMF.txt',
  'IVR_SPEECH.txt',
  'HOLD.txt',
  'TRANSFER.txt',
  'EXCHANGE.txt',
  'READBACK.txt',
  'CLOSING_WRAPUP.txt',
  'CLOSING_ESCALATION.txt',
] as const;
export type PromptFile = (typeof PROMPT_FILES)[number];

export type PositionalPrompt = Extract<
  PromptFile,
  'IVR_DTMF.txt' | 'IVR_SPEECH.txt' | 'HOLD.txt' | 'TRANSFER.txt' | 'EXCHANGE.txt' | 'READBACK.txt' | 'CLOSING_WRAPUP.txt' | 'CLOSING_ESCALATION.txt'
>;

export const PROMPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../files');

/** Read once, at load. A missing file fails the process at start, not mid-call. */
const TEXTS: ReadonlyMap<PromptFile, string> = new Map(
  PROMPT_FILES.map((f) => [f, fs.readFileSync(path.join(PROMPT_DIR, f), 'utf8').replaceAll('\r', '')]),
);

export function promptText(file: PromptFile): string {
  return TEXTS.get(file)!;
}

export interface PromptContext {
  channel: Channel;
  phase: Phase;
  closingKind?: ClosingKind;
  navMode: NavMode;
  /** The transition being processed — never stored on the call (§7.3). */
  channelCameFrom?: Channel;
  partyContinuityAssured: boolean;
  disclosedToCurrentParty: boolean;
  pendingContextCorrection: boolean;
  discardedToolResults: string[];
  request: Readonly<AuthRequest>;
  call: Readonly<Call>;
}

export interface PromptBundle {
  files: string[];
  text: string;
  hedged: boolean;
  disclosureIncluded: boolean;
  substitutions: string[];
  markerOrder: string[];
}

function unhandled(x: never): never {
  throw new Error(`unhandled value ${String(x)}`);
}

/**
 * Total over (channel, phase, navMode, closingKind). Every Channel and every
 * Phase is a switch case ending in `unhandled(x: never)`, so adding a value to
 * either union is a compile error here until it is given a prompt.
 *
 * `null` means no positional prompt applies: nobody is being spoken to (DIALING,
 * CLOSED), or the work is finished and the call is only waiting for its hangup
 * (any channel with phase DONE — see awaitingClosePolicy in callmodel).
 *
 * Throws on two combinations the call model makes impossible, rather than
 * inventing a prompt for them:
 *   - HUMAN/NOT_STARTED: settle() moves NOT_STARTED to EXCHANGE atomically on
 *     entering HUMAN, so it is never observed.
 *   - HUMAN/CLOSING without a closingKind: every producer of CLOSING sets one.
 */
export function positionalPromptName(
  ctx: Pick<PromptContext, 'channel' | 'phase' | 'navMode' | 'closingKind'>,
): PositionalPrompt | null {
  const { channel, phase } = ctx;
  if (phase === 'DONE') return null;

  switch (channel) {
    case 'DIALING':
    case 'CLOSED':
      return null;
    // IVR, HOLD and TRANSFER preserve whatever phase was current; their prompt
    // is channel-driven (§18, and the IVR correction in callmodel/policy.ts).
    case 'IVR':
      switch (ctx.navMode) {
        case 'dtmf': return 'IVR_DTMF.txt';
        case 'speech': return 'IVR_SPEECH.txt';
        default: return unhandled(ctx.navMode);
      }
    case 'HOLD':
      return 'HOLD.txt';
    case 'TRANSFER':
      return 'TRANSFER.txt';
    case 'HUMAN':
      switch (phase) {
        case 'NOT_STARTED':
          throw new Error('HUMAN/NOT_STARTED is never observed: settle() moves the phase to EXCHANGE on entering HUMAN');
        case 'EXCHANGE': return 'EXCHANGE.txt';
        case 'READBACK': return 'READBACK.txt';
        case 'CLOSING':
          switch (ctx.closingKind) {
            case 'wrapup': return 'CLOSING_WRAPUP.txt';
            case 'escalation': return 'CLOSING_ESCALATION.txt';
            case undefined: throw new Error('HUMAN/CLOSING without a closingKind: every producer of CLOSING sets one');
            default: return unhandled(ctx.closingKind);
          }
        default: return unhandled(phase);
      }
    default:
      return unhandled(channel);
  }
}

/**
 * §7.3. Returns `null` where positionalPromptName does — a departure from the
 * §12.7 signature, which returns a bundle unconditionally. The alternative was
 * an empty bundle, and an empty bundle can still carry DISCLOSURE.txt on its
 * own (HUMAN/DONE, undisclosed): an instruction to introduce yourself on a call
 * whose work is over. Returning null makes "no prompt here" a single case.
 */
export function promptFor(ctx: PromptContext): PromptBundle | null {
  const positional = positionalPromptName(ctx);
  if (positional === null) return null;

  const files: PromptFile[] = [];

  // 1. Context correction, when a reply was discarded by the gate (ADR-007).
  if (ctx.pendingContextCorrection) files.push('CONTEXT_CORRECTION.txt');

  // 2. Party hedge, on every return to a human without assured continuity.
  const hedged =
    ctx.channel === 'HUMAN' &&
    (ctx.channelCameFrom === 'HOLD' || ctx.channelCameFrom === 'TRANSFER') &&
    !ctx.partyContinuityAssured;
  if (hedged) files.push('PARTY_HEDGE.txt');

  // 3. The positional prompt.
  files.push(positional);

  // 4. Disclosure, when this party has not been told. Never alongside the
  //    hedge, which already carries it — INV-6 checks both directions.
  const disclosureIncluded = ctx.channel === 'HUMAN' && !ctx.disclosedToCurrentParty && !hedged;
  if (disclosureIncluded) files.push('DISCLOSURE.txt');

  const src = { request: ctx.request, call: ctx.call };
  const parts = files.map((f) => render(promptText(f), src));

  return {
    files,
    text: parts.map((p) => p.text).join('\n\n'),
    hedged,
    disclosureIncluded,
    substitutions: [...new Set(parts.flatMap((p) => p.substitutions))],
    markerOrder: parts.flatMap((p) => p.markerOrder),
  };
}
