/**
 * Authorization number integrity — §8.2, ADR-020, INV-15, module 3.5.
 *
 * TWO CHECKS THAT MUST NEVER BE COMBINED, and the reason is the whole design.
 *
 *   The SANITY check asks: does the captured value appear in what the far end
 *   said? A "no" is most likely a RECOGNITION problem, so it is a review signal
 *   and never a rejection.
 *
 *   The INTEGRITY check asks: does record_outcome carry exactly the value we
 *   stored? A "no" is a MODEL-RELIABILITY problem — the model produced a value
 *   different from one it had just read from storage — so it is rejected, paired
 *   with a safety.violation, and never retried.
 *
 * Combining them would hide the one signal that distinguishes a bug from an
 * untrustworthy model, and would make a recognition failure non-retryable:
 * right for the second case and badly wrong for the first.
 *
 * THE SANITY CHECK CANNOT SEE A RECOGNITION ERROR, AND IS NOT CREDITED WITH IT.
 * "Far-end speech" here is the ASR transcript, which is where a recognition
 * error already lives. A-24 showed this directly: both of Day 0's failed numbers
 * appeared verbatim in the transcript the model read, so this check would have
 * said nothing. What catches those is READBACK.
 */

import type { CallEventBody } from '@holdharmless/events';

const DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

/**
 * Reduces far-end speech to the characters an authorization number is made of,
 * so "A as in alpha, four seven two, dash, nine one" becomes "A472-91".
 *
 * Deliberately generous: this feeds a REVIEW SIGNAL, and a false alarm here
 * costs someone a glance at a panel, while a missed one costs nothing at all
 * (the integrity check and READBACK are what protect the value).
 */
export function spokenToCharacters(text: string): string {
  // A hyphen becomes its own token: it is part of the value, and a transcript
  // that already writes "A472-91" must not lose the separator. A hyphen INSIDE
  // a word is not one: "x-ray" is the disambiguation for the letter X, and
  // splitting it would read the X twice and invent a separator.
  const words = text.toLowerCase().replace(/([a-z])-([a-z])/g, '$1$2').replace(/-/g, ' - ').replace(/[^a-z0-9 -]+/g, ' ').trim().split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === '') continue;
    // "A as in alpha" — take the letter and skip the disambiguation.
    if (w.length === 1 && /[a-z]/.test(w)) {
      out.push(w.toUpperCase());
      if (words[i + 1] === 'as' && words[i + 2] === 'in') i += 3;
      continue;
    }
    if (w === 'dash' || w === 'hyphen' || w === '-') { out.push('-'); continue; }
    if (/^\d+$/.test(w)) { out.push(w); continue; }
    // A token already shaped like part of a number — the recognizer often
    // writes "PA4921679" rather than spelling it back at us.
    if (/^[a-z]+\d[a-z0-9]*$|^\d[a-z0-9]*[a-z]$/.test(w)) { out.push(w.toUpperCase()); continue; }
    const digit = DIGIT_WORDS[w];
    if (digit) out.push(digit);
  }
  return out.join('');
}

/**
 * §8.2's far-end sanity check. Returns true when the captured value can be
 * found in what the far end said, allowing for spelled letters and spoken
 * digits. A false is `auth_number_capture_suspect`: review, not rejection.
 */
export function captureAppearsInSpeech(value: string, farEndText: string): boolean {
  const spoken = spokenToCharacters(farEndText);
  const wanted = value.toUpperCase();
  if (spoken.includes(wanted)) return true;
  // Separators are the least reliable part of a transcript; compare without them
  // before calling a capture suspect.
  const strip = (s: string) => s.replace(/[^A-Z0-9]/g, '');
  return strip(spoken).includes(strip(wanted));
}

/**
 * §8.2's comparison, and the only copy of it. Byte for byte, with no
 * normalization anywhere (ADR-020): both sides are copies of one stored value,
 * so any difference is the model's. `outcome-validation.ts` decides the §8.5
 * refusal and calls this rather than writing the comparison a second time — two
 * copies of a rule this small is how one of them quietly starts trimming.
 */
export function authNumberMatches(recorded: string, captured: string | undefined): boolean {
  return captured !== undefined && recorded === captured;
}

export type ReadbackDeps = {
  emit: (event: CallEventBody) => void;
};

export interface ReadbackIntegrity {
  /** After a capture: records the review signal when the value cannot be found. */
  checkCapture(value: string, farEndText: string): boolean;
  /**
   * §8.2's final comparison. On a mismatch it emits BOTH the rejection and the
   * violation for the same toolCallId — INV-15 pairs them, and a violation with
   * no rejection beside it would describe a value that was nonetheless accepted.
   */
  checkOutcome(toolCallId: string, recorded: string, captured: string | undefined): boolean;
  /**
   * The violation ALONE, for the tool handler — which emits its own
   * `tool.rejected` for every refusal and must not have this one arrive by a
   * different route. INV-15's pairing holds because the caller passes the same
   * `toolCallId` to both.
   */
  recordOutcomeMismatch(toolCallId: string, recorded: string, captured: string | undefined): void;
}

export function createReadbackIntegrity(deps: ReadbackDeps): ReadbackIntegrity {
  // A local function rather than `this.recordOutcomeMismatch`: the returned
  // object is meant to be destructured freely, and a `this` reference would
  // turn that into a crash at the one moment a violation is being recorded.
  const recordOutcomeMismatch = (toolCallId: string, recorded: string, captured: string | undefined): void => {
    deps.emit({
      t: 'safety.violation',
      kind: 'auth_number_mismatch',
      toolCallId,
      detail: `recorded "${recorded}" against captured "${captured ?? 'nothing'}" — not retried (§8.2)`,
    });
  };

  return {
    recordOutcomeMismatch,
    checkCapture(value: string, farEndText: string): boolean {
      const found = captureAppearsInSpeech(value, farEndText);
      if (!found) {
        // auth_number.suspect, NOT safety.violation. The two are different
        // events because they are different findings: a violation is a breach
        // to answer for, and this is a recognition signal to look at. Logging a
        // review signal as a violation would make the compliance panel red for
        // something the system handled correctly.
        deps.emit({
          t: 'auth_number.suspect',
          value,
          detail: 'the captured value does not appear in far-end speech; a review signal, not a rejection (§8.2)',
        });
      }
      return found;
    },

    checkOutcome(toolCallId: string, recorded: string, captured: string | undefined): boolean {
      if (authNumberMatches(recorded, captured)) return true;
      deps.emit({
        t: 'tool.rejected',
        toolCallId,
        name: 'record_outcome',
        reason: 'validation_failed',
        detail: captured === undefined
          ? 'no authorization number was captured on this call'
          : `record_outcome carried "${recorded}" while the call captured "${captured}"`,
      });
      recordOutcomeMismatch(toolCallId, recorded, captured);
      return false;
    },
  };
}
