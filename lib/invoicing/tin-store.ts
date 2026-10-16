// The ONLY file that reads an encrypted invoicing column (client EIN, business EIN, remit-to bank text) or turns plaintext into
// ciphertext for one (plan section 12 items 1 and 3; a guard test pins it). Server only. No auth here: callers (actions and the
// PDF route) have already authenticated and applied the owner rule.
//
// Plaintext leaves this file only in three ways, each deliberate: (1) the owner's explicit "Reveal" of an EIN, (2) the owner's
// own settings form for the bank text, (3) the PDF renderer for a document that ticks "include bank details" (and the business
// EIN only when the document's showEin is on). It never reaches a log, an AuditLog / BillingEvent row, the advisor or a CSV.

import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/encrypt";
import { formatEin } from "@/lib/invoicing/tin";

/** Encrypts nine EIN digits for storage. */
export function encryptEinDigits(digits: string): string {
  if (!/^\d{9}$/.test(digits)) throw new Error("not an EIN");
  return encrypt(digits);
}

/** Encrypts the owner-typed bank / remit-to instruction text for storage. */
export function encryptRemitText(text: string): string {
  return encrypt(text);
}

/** The owner's explicit reveal of a client's EIN, formatted XX-XXXXXXX; null when none is stored. */
export async function revealClientEin(entityId: string, clientId: string): Promise<string | null> {
  const row = await db.client.findFirst({ where: { id: clientId, entityId }, select: { einEncrypted: true } });
  if (!row?.einEncrypted) return null;
  return formatEin(decrypt(row.einEncrypted));
}

/** The business EIN formatted XX-XXXXXXX (owner reveal, or the PDF when the document shows it); null when none is stored. */
export async function readBusinessEin(entityId: string): Promise<string | null> {
  const row = await db.invoicingProfile.findUnique({ where: { entityId }, select: { einEncrypted: true } });
  if (!row?.einEncrypted) return null;
  return formatEin(decrypt(row.einEncrypted));
}

/** The decrypted bank / remit-to text (settings form for the owner, PDF for a document that includes it); null when none is stored. */
export async function readRemitText(entityId: string): Promise<string | null> {
  const row = await db.invoicingProfile.findUnique({ where: { entityId }, select: { remitToEncrypted: true } });
  if (!row?.remitToEncrypted) return null;
  return decrypt(row.remitToEncrypted);
}
