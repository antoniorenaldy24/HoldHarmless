/**
 * A mechanical definition of "synthetic" — the thing INV-12 requires and §1.6
 * forbids violating, but which the SSOT never defined.
 *
 * Without a definition INV-12 is a claim with no reachable mechanism (K-4): it
 * says no AuthRequest contains real data, and nothing can check that. Each rule
 * below is chosen so that a value passing it CANNOT be a real identifier, rather
 * than merely looking unusual.
 *
 *   providerNpi       10 digits that FAIL the NPI check digit. Every NPI CMS
 *                     issues passes Luhn over the prefix 80840, so a number that
 *                     fails it is not an issued NPI — by arithmetic, not by list.
 *   clinicCallbackPhone  in 555-0100..0199, the range the North American
 *                     Numbering Plan reserves for fiction.
 *   payerEndpoint     a loopback URL. A phone number here would mean a carrier
 *                     build pointed at a real payer (§1.6: never).
 *   patientRef, memberId  carry the SYN prefix. Member IDs have no public
 *                     checksum, so a marker is the strongest available signal.
 *
 * The same function is meant for record creation in the Work Queue, so a real
 * value is refused on the way in, not only detected afterwards.
 */

import type { AuthRequest } from '@holdharmless/events';

/** The NPI check digit: Luhn over "80840" followed by the first nine digits. */
export function npiCheckDigit(firstNine: string): number {
  const payload = `80840${firstNine}`;
  let sum = 0;
  // The check digit is appended on the right, so doubling starts at the
  // rightmost payload digit.
  for (let i = 0; i < payload.length; i++) {
    let d = Number(payload[payload.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidIssuedNpiFormat(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  return npiCheckDigit(npi.slice(0, 9)) === Number(npi[9]);
}

/** A synthetic NPI: ten digits, deliberately failing the check digit. */
export function isSyntheticNpi(npi: string): boolean {
  return /^\d{10}$/.test(npi) && !isValidIssuedNpiFormat(npi);
}

/** 555-0100 through 555-0199, in any common formatting. */
export function isFictionalPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  const local = digits.slice(-7);
  if (!local.startsWith('555')) return false;
  const line = Number(local.slice(3));
  return line >= 100 && line <= 199;
}

export function isLoopbackEndpoint(url: string): boolean {
  return /^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(url);
}

export type SyntheticViolation = { field: keyof AuthRequest; value: string; rule: string };

export function syntheticViolations(r: AuthRequest): SyntheticViolation[] {
  const out: SyntheticViolation[] = [];
  if (!r.patientRef.startsWith('SYN-')) {
    out.push({ field: 'patientRef', value: r.patientRef, rule: "must start with 'SYN-'" });
  }
  if (!r.memberId.startsWith('SYN')) {
    out.push({ field: 'memberId', value: r.memberId, rule: "must start with 'SYN'" });
  }
  if (!isSyntheticNpi(r.providerNpi)) {
    out.push({
      field: 'providerNpi',
      value: r.providerNpi,
      rule: isValidIssuedNpiFormat(r.providerNpi)
        ? 'passes the NPI check digit, so it could be a real issued NPI'
        : 'must be ten digits',
    });
  }
  if (!isFictionalPhone(r.clinicCallbackPhone)) {
    out.push({ field: 'clinicCallbackPhone', value: r.clinicCallbackPhone, rule: 'must be in 555-0100..0199' });
  }
  if (!isLoopbackEndpoint(r.payerEndpoint)) {
    out.push({ field: 'payerEndpoint', value: r.payerEndpoint, rule: 'must be a loopback WebSocket URL' });
  }
  return out;
}
