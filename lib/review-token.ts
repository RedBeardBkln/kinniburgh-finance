// Pure token logic for the "Assign to Eva" magic link. No DB access.
//
// The raw token is a 256-bit random value (base64url, 43 chars) that appears
// only in the URL path. Only its SHA-256 hash is ever stored (ReviewLinkToken.
// tokenHash). A fresh random 256-bit token needs no slow hash and no attempt
// counter; lookup is by hash equality. NEVER log a raw token, a token URL, or a
// hash derived from one.

import { createHash, randomBytes } from "node:crypto";

export const REVIEW_TOKEN_TTL_DAYS = 7;
export const REVIEW_TOKEN_TTL_MS = REVIEW_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

/** randomBytes(32) -> base64url is always 43 chars of [A-Za-z0-9_-]. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function isPlausibleReviewToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_SHAPE.test(token);
}

export function hashReviewToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateReviewToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashReviewToken(token) };
}

export function reviewTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + REVIEW_TOKEN_TTL_MS);
}

export type ReviewTokenInvalidReason = "not_found" | "revoked" | "batch_closed" | "expired";

export type ReviewTokenEvaluation =
  | { valid: true }
  | { valid: false; reason: ReviewTokenInvalidReason };

export interface ReviewTokenRowState {
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface ReviewBatchTokenState {
  status: string;
  expiresAt: Date | null;
}

/**
 * Decides whether a looked-up token row grants access. Precedence: unknown ->
 * revoked -> batch not open (anything but "submitted") -> expired. Expiry is
 * exclusive: at exactly `expiresAt` the token is already expired. Both the
 * token's own expiry and the batch's expiry (when set) must still be in the
 * future.
 */
export function evaluateReviewToken(args: {
  tokenRow: ReviewTokenRowState | null;
  batch: ReviewBatchTokenState | null;
  now: Date;
}): ReviewTokenEvaluation {
  const { tokenRow, batch, now } = args;
  if (!tokenRow || !batch) return { valid: false, reason: "not_found" };
  if (tokenRow.revokedAt !== null) return { valid: false, reason: "revoked" };
  if (batch.status !== "submitted") return { valid: false, reason: "batch_closed" };
  if (tokenRow.expiresAt.getTime() <= now.getTime()) return { valid: false, reason: "expired" };
  if (batch.expiresAt !== null && batch.expiresAt.getTime() <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true };
}
