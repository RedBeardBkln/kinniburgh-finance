import { type AccountType } from "@/lib/account-types";

// ── Plaid subtype/type → our AccountType inference ─────────────────────────
// Pure function — unit tested in lib/__tests__/plaid-account-type.test.ts.
// This only DEFAULTS the account-type field on the "create new account"
// forms (manual-entry new-institution path doesn't call this at all; the
// Plaid-mapping "create new account" path uses it as a `defaultValue` that
// stays fully editable before submit) — never silently forces a value.

/**
 * Infers a reasonable AccountType default from Plaid's `type`/`subtype`
 * account fields. Case-insensitive on both inputs. Falls back to "checking"
 * for anything unrecognized (a safe default since the UI always lets the
 * owner override it before submit).
 */
export function inferAccountTypeFromPlaid(
  type: string | null | undefined,
  subtype: string | null | undefined
): AccountType {
  const t = (type ?? "").trim().toLowerCase();
  const s = (subtype ?? "").trim().toLowerCase();

  if (s === "mortgage") return "mortgage";

  if (t === "loan" || s.includes("loan") || s.includes("student") || s.includes("line of credit")) {
    return "loan";
  }

  if (t === "credit" || s === "credit card") return "credit_card";

  if (s === "savings" || s === "cd" || s === "money market") return "savings";

  if (t === "investment" || t === "brokerage") return "investment";

  // "depository" (checking/hsa/cash management/etc.) and anything else
  // unrecognized default to checking — always editable before submit.
  return "checking";
}
