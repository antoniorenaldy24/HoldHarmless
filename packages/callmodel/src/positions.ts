/**
 * The two call dimensions as closed sets, and the position identifier that keys
 * every per-position table (§5.1, §5.6).
 */

import type { Channel, Phase } from '@holdharmless/events';

export const CHANNELS = ['DIALING', 'IVR', 'HOLD', 'TRANSFER', 'HUMAN', 'CLOSED'] as const satisfies readonly Channel[];
export const PHASES = ['NOT_STARTED', 'EXCHANGE', 'READBACK', 'CLOSING', 'DONE'] as const satisfies readonly Phase[];

/**
 * Compile-time proof that the arrays above are complete. If a Channel or Phase is
 * added to the union in packages/events without being added here, these lines
 * stop compiling — which is the "compiler rejects an unhandled Channel or Phase"
 * half of acceptance 1.4, applied to the enumerations every table is built from.
 */
type Missing<All, Listed> = Exclude<All, Listed>;
const _channelsComplete: Missing<Channel, (typeof CHANNELS)[number]> extends never ? true : never = true;
const _phasesComplete: Missing<Phase, (typeof PHASES)[number]> extends never ? true : never = true;
void _channelsComplete;
void _phasesComplete;

export type PositionId = `${Channel}/${Phase}`;

export function positionId(channel: Channel, phase: Phase): PositionId {
  return `${channel}/${phase}`;
}

export function parsePositionId(id: PositionId): { channel: Channel; phase: Phase } {
  const [channel, phase] = id.split('/') as [Channel, Phase];
  return { channel, phase };
}

/** Every (channel, phase) pair — the cartesian product INV-11 is evaluated over. */
export function allPositions(): PositionId[] {
  return CHANNELS.flatMap((c) => PHASES.map((p) => positionId(c, p)));
}

/** Throws at runtime for a value the type system should have ruled out. */
export function assertNever(value: never, what: string): never {
  throw new Error(`Unhandled ${what}: ${JSON.stringify(value)}`);
}
