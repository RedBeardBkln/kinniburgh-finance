// Tax-ID handling for clients and the business (plan section 12 item 1). PURE: nothing here encrypts or decrypts, and nothing returns a
// full number except `normalizeEin` (which returns the digits of what the caller just typed). Storage is AES-256-GCM through
// lib/encrypt.ts, called ONLY from lib/invoicing/tin-store.ts; only the last four digits are ever shown.
//
// Phase 1 stores EINs only (client EIN, business EIN). A value typed in Social Security Number format (XXX-XX-XXXX) is refused:
// an individual's SSN is never stored here. (Phase 4 adds contractor TINs with its own, separately approved handling.)

export type EinCheck = { ok: true; digits: string; last4: string } | { ok: false; error: string };

/** Validates a typed EIN ("12-3456789" or "123456789") and returns its nine digits and last four. */
export function normalizeEin(raw: string, label = "EIN"): EinCheck {
  const text = raw.trim();
  if (text === "") return { ok: false, error: `${label} is required.` };
  if (/^\d{3}[- ]\d{2}[- ]\d{4}$/.test(text)) {
    return { ok: false, error: `${label} looks like a Social Security Number. Only an employer identification number (XX-XXXXXXX) can be stored here.` };
  }
  if (!/^(?:\d{2}-?\d{7})$/.test(text)) return { ok: false, error: `${label} must be 9 digits, like 12-3456789.` };
  const digits = text.replace(/-/g, "");
  if (/^0{9}$/.test(digits)) return { ok: false, error: `${label} is not valid.` };
  return { ok: true, digits, last4: digits.slice(-4) };
}

/** "12-3456789" from nine digits (used only on the owner's explicit reveal and on a printed invoice when the owner turned it on). */
export function formatEin(digits: string): string {
  return /^\d{9}$/.test(digits) ? `${digits.slice(0, 2)}-${digits.slice(2)}` : "";
}

/** The masked display of a stored EIN: "XX-XXX1234". */
export function maskedEin(last4: string | null | undefined): string {
  return last4 && /^\d{4}$/.test(last4) ? `XX-XXX${last4}` : "Not set";
}
