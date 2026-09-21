/**
 * The loopback wire protocol.
 *
 * One bidirectional WebSocket (ADR-001). Audio travels as BINARY frames of
 * exactly 160 bytes — the link is ours, so there is no reason to pay the base64
 * cost AssemblyAI's own protocol imposes (§7.1). Control travels as JSON text.
 *
 * Audio and marks share one delay line per direction, so a mark can never
 * overtake the audio it follows. That ordering is what makes a mark mean
 * "playback reached here".
 */

export type CoreToFar =
  | { type: 'mark'; name: string }
  | { type: 'clear'; id: number }
  | { type: 'hangup' };

export type FarToCore =
  | { type: 'mark'; name: string }
  | { type: 'cleared'; id: number; marks: string[] }
  | { type: 'hangup' };

export function parseControl<T>(text: string): T | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (value !== null && typeof value === 'object' && 'type' in value) return value as T;
  } catch {
    /* fall through */
  }
  return null;
}
