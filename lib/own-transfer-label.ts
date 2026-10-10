// The bank's own-account transfer wording ("Online Xfer Transfer to CK x1234"), read tolerantly. Pure and client-safe.
//
// Historical rows use a double space ("Online  Xfer Transfer to CK x1234"; 224 rows May 2025 to Apr 2026), so runs of
// whitespace are collapsed BEFORE the strict anchored parse. Everything else stays exact: case-sensitive, nothing before or
// after the label, a two-letter code and exactly four digits. The TD matcher (lib/transfer-match.ts) keeps its own strict
// parse unchanged: this file is only for classifying and displaying the label.
import { parseTransferLeg, type TransferLegParseResult } from "@/lib/transfer-match";

export function normalizeTransferLabel(payee: string): string {
  return payee.replace(/\s+/g, " ").trim();
}

export function parseOwnTransferLabel(payee: string): TransferLegParseResult | null {
  return parseTransferLeg(normalizeTransferLabel(payee));
}

/**
 * Hide a statement mask ("x1234" -> "x****") in any transfer-like text, whatever its exact shape (extra spaces, other
 * case, trailing words). Text that does not mention a transfer is returned unchanged.
 */
export function hideTransferMask(payee: string): string {
  if (!/\bxfer\b|\btransfer\b/i.test(payee)) return payee;
  return payee.replace(/\bx\d{4}\b/gi, "x****");
}
