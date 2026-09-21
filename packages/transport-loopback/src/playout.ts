/**
 * The far end's playout queue — ADR-008, §10.3, interface in §12.10.
 *
 * Without a queue that genuinely holds audio, `clear` would be a message with
 * nothing to clear, INV-3 would be vacuous, A-3 would measure nothing, and the
 * second of ADR-007's three enforcement layers would exist only on paper.
 *
 * It lives beside the loopback wire protocol rather than inside apps/ivr-harness
 * because `clear` and `mark` are protocol semantics: the harness imports it, and
 * the two can never disagree about what a mark means.
 *
 * DEPTH ASSUMES A PACED SENDER. 200 ms is a playout buffer, not a reservoir.
 * AssemblyAI emits reply.audio faster than real time, so an unpaced sender would
 * overflow this within a fraction of a second and the far end would hear the
 * tail of every reply and nothing else. Pacing is the Audio Bridge's job (§3.2),
 * and that is where the "seconds of speech" ADR-007 worries about actually sit —
 * which means a clear must flush the bridge's pacing buffer as well as this one.
 */

import { FRAME_MS } from '@holdharmless/audio';

type Entry = { kind: 'audio'; frame: Uint8Array } | { kind: 'mark'; name: string };

export interface PlayoutQueue {
  push(frame: Uint8Array): void;
  /** Drains one frame per tick; returns null when empty. Marks reached are reported. */
  tick(): Uint8Array | null;
  /** Discards unplayed chunks; returns a mark name for each (ADR-008). */
  clear(): string[];
  mark(name: string): void;
  depthMs(): number;
  overflowCount(): number;
}

export type PlayoutQueueOptions = {
  /** PLAYOUT_DEPTH_MS, default 200 (§13). */
  depthMs?: number;
  /** Called when playback reaches a mark. */
  onMarkPlayed?: (name: string) => void;
};

export function createPlayoutQueue(options: PlayoutQueueOptions = {}): PlayoutQueue {
  const maxFrames = Math.max(1, Math.round((options.depthMs ?? 200) / FRAME_MS));
  const onMarkPlayed = options.onMarkPlayed ?? (() => {});

  let entries: Entry[] = [];
  let audioCount = 0;
  let overflow = 0;

  return {
    push(frame: Uint8Array): void {
      if (audioCount >= maxFrames) {
        // Drop the oldest AUDIO frame. Marks are zero-duration and stay, so a
        // mark whose audio was dropped is still reported when reached — the far
        // end got less of that chunk, but it did reach the chunk's end.
        const idx = entries.findIndex((e) => e.kind === 'audio');
        if (idx >= 0) {
          entries.splice(idx, 1);
          audioCount--;
          overflow++;
        }
      }
      entries.push({ kind: 'audio', frame });
      audioCount++;
    },

    tick(): Uint8Array | null {
      while (entries.length > 0) {
        const head = entries.shift()!;
        if (head.kind === 'mark') {
          onMarkPlayed(head.name);
          continue;
        }
        audioCount--;
        return head.frame;
      }
      return null;
    },

    clear(): string[] {
      const discarded = entries.filter((e) => e.kind === 'mark').map((e) => (e as { name: string }).name);
      entries = [];
      audioCount = 0;
      return discarded;
    },

    mark(name: string): void {
      entries.push({ kind: 'mark', name });
    },

    depthMs(): number {
      return audioCount * FRAME_MS;
    },

    overflowCount(): number {
      return overflow;
    },
  };
}
