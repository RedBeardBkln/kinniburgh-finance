// Client view-link tokens (plan P1). Token logic only: node:crypto, no DB, no next/*, no clock (callers pass `now`).
//
// The raw token is a 256-bit random value (base64url, 43 characters of [A-Za-z0-9_-]) that appears only in the link /i/<token>. Only its
// SHA-256 hash is ever stored (BillingAccessToken.tokenHash). A fresh 256-bit token needs no slow hash and no attempt counter; lookup is
// by hash equality after a shape check (an implausible token never reaches the database). NEVER log a raw token, a token URL or a hash.
//
// Mint-time screening: a base64url string can by chance contain an SSN-shaped run (nine digits, or ddd-dd-dddd). The link is printed on
// the PDF through `safeText`, which would replace it, so such a candidate is discarded and a new one drawn (bounded; then it throws).

import { createHash, randomBytes } from "node:crypto";
import { containsSsnLikeText } from "@/lib/tax-extraction-schema";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
export const MINT_MAX_TRIES = 10;

export function isPlausibleInvoiceToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_SHAPE.test(token);
}

export function hashInvoiceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** True when the token (or the link path that carries it) could be mistaken for an SSN by the PDF text guard. */
export function tokenLooksSsnLike(token: string): boolean {
  return containsSsnLikeText(token) || containsSsnLikeText(`/i/${token}`);
}

export type RandomSource = () => Buffer;

/** Draws a new token (re-drawing an SSN-looking one) and returns it with its hash. */
export function mintInvoiceToken(random: RandomSource = () => randomBytes(32)): { token: string; tokenHash: string } {
  for (let i = 0; i < MINT_MAX_TRIES; i += 1) {
    const token = random().toString("base64url");
    if (!isPlausibleInvoiceToken(token)) continue;
    if (tokenLooksSsnLike(token)) continue;
    return { token, tokenHash: hashInvoiceToken(token) };
  }
  throw new Error("could not mint a link token");
}

export function tokenExpiry(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * 86_400_000);
}

/** The client link for a token (`baseUrl` from payEnvironment: INVOICE_PUBLIC_BASE_URL or NEXTAUTH_URL, no trailing slash). */
export function invoiceLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/i/${token}`;
}

export type InvoiceTokenInvalidReason = "not_found" | "revoked" | "expired";

/**
 * Whether a looked-up token row grants access. Precedence: unknown -> revoked -> expired. Expiry is exclusive: at exactly `expiresAt`
 * the token is already expired. The reason is for tests and internal logic only: every invalid case shows the SAME neutral page.
 */
export function evaluateInvoiceToken(row: { expiresAt: Date; revokedAt: Date | null } | null, now: Date): { valid: true } | { valid: false; reason: InvoiceTokenInvalidReason } {
  if (!row) return { valid: false, reason: "not_found" };
  if (row.revokedAt !== null) return { valid: false, reason: "revoked" };
  if (row.expiresAt.getTime() <= now.getTime()) return { valid: false, reason: "expired" };
  return { valid: true };
}

/** A token row is "live" (counts toward the per-invoice cap) when it is not revoked and not yet expired. */
export function isLiveToken(row: { expiresAt: Date; revokedAt: Date | null }, now: Date): boolean {
  return evaluateInvoiceToken(row, now).valid;
}
