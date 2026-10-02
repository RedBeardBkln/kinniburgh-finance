import { describe, it, expect } from "vitest";
import {
  REVIEW_TOKEN_TTL_DAYS,
  REVIEW_TOKEN_TTL_MS,
  evaluateReviewToken,
  generateReviewToken,
  hashReviewToken,
  isPlausibleReviewToken,
  reviewTokenExpiry,
} from "@/lib/review-token";

describe("generateReviewToken", () => {
  it("returns a 43-char base64url token and its SHA-256 hex hash", () => {
    const { token, tokenHash } = generateReviewToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(token);
    expect(token).not.toContain(tokenHash);
  });

  it("produces distinct tokens and hashes", () => {
    const tokens = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const { token, tokenHash } = generateReviewToken();
      tokens.add(token);
      hashes.add(tokenHash);
    }
    expect(tokens.size).toBe(500);
    expect(hashes.size).toBe(500);
  });

  it("the stored hash is exactly hashReviewToken(token)", () => {
    const { token, tokenHash } = generateReviewToken();
    expect(hashReviewToken(token)).toBe(tokenHash);
  });
});

describe("hashReviewToken", () => {
  it("is deterministic and matches a known SHA-256 vector", () => {
    expect(hashReviewToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(hashReviewToken("abc")).toBe(hashReviewToken("abc"));
    expect(hashReviewToken("abc")).not.toBe(hashReviewToken("abd"));
  });
});

describe("isPlausibleReviewToken", () => {
  it("accepts only the exact generated shape", () => {
    expect(isPlausibleReviewToken(generateReviewToken().token)).toBe(true);
    expect(isPlausibleReviewToken("a".repeat(43))).toBe(true);
    expect(isPlausibleReviewToken("a".repeat(42))).toBe(false);
    expect(isPlausibleReviewToken("a".repeat(44))).toBe(false);
    expect(isPlausibleReviewToken("a".repeat(42) + "+")).toBe(false);
    expect(isPlausibleReviewToken("a".repeat(42) + "=")).toBe(false);
    expect(isPlausibleReviewToken("")).toBe(false);
    expect(isPlausibleReviewToken(undefined)).toBe(false);
    expect(isPlausibleReviewToken(null)).toBe(false);
    expect(isPlausibleReviewToken(123)).toBe(false);
  });
});

describe("reviewTokenExpiry", () => {
  it("is 7 days after now", () => {
    expect(REVIEW_TOKEN_TTL_DAYS).toBe(7);
    const now = new Date("2026-10-01T12:00:00Z");
    expect(reviewTokenExpiry(now).toISOString()).toBe("2026-10-08T12:00:00.000Z");
    expect(reviewTokenExpiry(now).getTime() - now.getTime()).toBe(REVIEW_TOKEN_TTL_MS);
  });
});

describe("evaluateReviewToken", () => {
  const now = new Date("2026-10-03T12:00:00.000Z");
  const future = new Date(now.getTime() + 60_000);
  const openBatch = { status: "submitted", expiresAt: future };
  const goodRow = { expiresAt: future, revokedAt: null };

  it("accepts a live token on a submitted batch", () => {
    expect(evaluateReviewToken({ tokenRow: goodRow, batch: openBatch, now })).toEqual({ valid: true });
  });

  it("an unknown token (no row / no batch) is not_found", () => {
    expect(evaluateReviewToken({ tokenRow: null, batch: null, now })).toEqual({
      valid: false,
      reason: "not_found",
    });
    expect(evaluateReviewToken({ tokenRow: goodRow, batch: null, now })).toEqual({
      valid: false,
      reason: "not_found",
    });
  });

  it("a revoked token is invalid even when its dates are fine", () => {
    expect(
      evaluateReviewToken({
        tokenRow: { expiresAt: future, revokedAt: new Date(now.getTime() - 1) },
        batch: openBatch,
        now,
      })
    ).toEqual({ valid: false, reason: "revoked" });
  });

  it("revoked wins over expired and over a closed batch", () => {
    const past = new Date(now.getTime() - 1000);
    expect(
      evaluateReviewToken({
        tokenRow: { expiresAt: past, revokedAt: past },
        batch: { status: "completed", expiresAt: past },
        now,
      })
    ).toEqual({ valid: false, reason: "revoked" });
  });

  it.each(["draft", "completed", "cancelled"])("batch status %s is batch_closed", (status) => {
    expect(
      evaluateReviewToken({ tokenRow: goodRow, batch: { status, expiresAt: future }, now })
    ).toEqual({ valid: false, reason: "batch_closed" });
  });

  it("batch_closed is reported before expired", () => {
    const past = new Date(now.getTime() - 1000);
    expect(
      evaluateReviewToken({
        tokenRow: { expiresAt: past, revokedAt: null },
        batch: { status: "completed", expiresAt: past },
        now,
      })
    ).toEqual({ valid: false, reason: "batch_closed" });
  });

  it("token expiry boundary: expiresAt - 1ms valid, == expiresAt expired, + 1ms expired", () => {
    const exp = new Date("2026-10-08T12:00:00.000Z");
    const batch = { status: "submitted", expiresAt: null };
    const row = { expiresAt: exp, revokedAt: null };
    expect(
      evaluateReviewToken({ tokenRow: row, batch, now: new Date(exp.getTime() - 1) })
    ).toEqual({ valid: true });
    expect(evaluateReviewToken({ tokenRow: row, batch, now: exp })).toEqual({
      valid: false,
      reason: "expired",
    });
    expect(
      evaluateReviewToken({ tokenRow: row, batch, now: new Date(exp.getTime() + 1) })
    ).toEqual({ valid: false, reason: "expired" });
  });

  it("the batch's own expiry also applies (exclusive), even if the token row is still live", () => {
    const batchExp = new Date("2026-10-05T00:00:00.000Z");
    const row = { expiresAt: new Date("2026-10-30T00:00:00.000Z"), revokedAt: null };
    const batch = { status: "submitted", expiresAt: batchExp };
    expect(evaluateReviewToken({ tokenRow: row, batch, now: new Date(batchExp.getTime() - 1) })).toEqual({
      valid: true,
    });
    expect(evaluateReviewToken({ tokenRow: row, batch, now: batchExp })).toEqual({
      valid: false,
      reason: "expired",
    });
  });
});
