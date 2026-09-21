/**
 * The two text detectors of §7.6, with the interfaces of §12.7.
 *
 * "Both underpin invariants, so neither may be left to the implementer." The
 * disclosure detector feeds disclosedToCurrentParty and disclosuresDelivered
 * (INV-7); the closing tracker feeds turn.transcribed.isClosing (INV-20).
 */

export interface DisclosureDetector {
  test(agentTurn: string): boolean;
}

export const SELF_IDENTIFICATION_PHRASES = [
  'ai assistant',
  'automated assistant',
  'automated system',
  'virtual assistant',
  'a i assistant',
] as const;

export const BEHALF_PHRASES = ['on behalf of', 'calling for', 'calling from'] as const;

/**
 * Lower case, every run of non-alphanumerics to one space, padded with spaces.
 *
 * This is what lets "A.I. assistant" match `a i assistant` and "AI-assistant"
 * match `ai assistant`, which is how transcripts actually spell them. The
 * padding makes each phrase match on word boundaries only: "calling formally"
 * does not contain the phrase "calling for".
 */
export function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

const contains = (normalized: string, phrase: string) => normalized.includes(` ${phrase} `);

/**
 * A turn is a disclosure when it contains BOTH a self-identification phrase and
 * a behalf phrase (§7.6). The error direction matters: a matcher that is too
 * permissive makes INV-7 falsely green, so "assistant" alone never counts.
 *
 * Returns the matched pair as well, for disclosure.delivered's `quote`.
 */
export function matchDisclosure(agentTurn: string): { self: string; behalf: string } | null {
  const n = normalize(agentTurn);
  const self = SELF_IDENTIFICATION_PHRASES.find((p) => contains(n, p));
  const behalf = BEHALF_PHRASES.find((p) => contains(n, p));
  return self && behalf ? { self, behalf } : null;
}

export const disclosureDetector: DisclosureDetector = {
  test: (agentTurn) => matchDisclosure(agentTurn) !== null,
};

// ---------------------------------------------------------------------------

export interface ClosingTracker {
  noteMarkerReached(marker: string): void;
  isClosing(): boolean;
  reset(): void;
}

/**
 * §7.6: "A turn is marked closing when the reply that produced it was generated
 * under a prompt whose [[CLOSING]] marker had been reached." One definition,
 * shared with the static check #5, rather than a separate "sounds like a
 * goodbye" heuristic that could disagree with it.
 *
 * Built from the loaded bundle's markerOrder. A marker the prompt does not
 * contain is refused: noting one would mean the Agent Session believes it is
 * executing a prompt other than the one loaded. Markers must be reached in
 * the order the prompt gives them — reaching [[CLOSING]] before
 * [[RECORD_OUTCOME]] is the exact failure INV-20 exists for, and the tracker
 * reports it rather than recording it silently.
 */
export function createClosingTracker(markerOrder: readonly string[]): ClosingTracker {
  let reached = 0; // how many markers of markerOrder have been reached, in order

  return {
    noteMarkerReached(marker) {
      const at = markerOrder.indexOf(marker);
      if (at === -1) throw new Error(`marker [[${marker}]] is not in the loaded prompt (${markerOrder.join(', ') || 'no markers'})`);
      if (at < reached) return; // already past it: a repeat is harmless
      if (at > reached) {
        throw new Error(`marker [[${marker}]] reached before [[${markerOrder[reached]}]]`);
      }
      reached = at + 1;
    },
    isClosing() {
      const closingAt = markerOrder.indexOf('CLOSING');
      return closingAt !== -1 && reached > closingAt;
    },
    reset() {
      reached = 0;
    },
  };
}
