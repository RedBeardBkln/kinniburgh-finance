import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evaluateInvoiceToken,
  hashInvoiceToken,
  invoiceLinkUrl,
  isLiveToken,
  isPlausibleInvoiceToken,
  MINT_MAX_TRIES,
  mintInvoiceToken,
  tokenExpiry,
  tokenLooksSsnLike,
} from "@/lib/invoicing/access-token";
import { containsSsnLikeText } from "@/lib/tax-extraction-schema";

// Client view-link tokens (plan P1, S3).

/** 32 bytes whose base64url text starts with the given 24 base64 characters (4 chars = 3 bytes). */
const bytesStartingWith = (b64: string) => Buffer.concat([Buffer.from(b64, "base64url"), randomBytes(32 - (b64.length / 4) * 3)]);

describe("token shape and hash", () => {
  it("mints 43 base64url characters and stores only the sha256 hex of the UTF-8 token", () => {
    for (let i = 0; i < 50; i += 1) {
      const { token, tokenHash } = mintInvoiceToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(tokenHash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
      expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(hashInvoiceToken(token)).toBe(tokenHash);
      expect(tokenHash).not.toContain(token);
    }
  });
  it("the shape check rejects 42 / 44 characters and the standard base64 characters + / =", () => {
    const ok = "A".repeat(43);
    expect(isPlausibleInvoiceToken(ok)).toBe(true);
    expect(isPlausibleInvoiceToken("A".repeat(42))).toBe(false);
    expect(isPlausibleInvoiceToken("A".repeat(44))).toBe(false);
    for (const ch of ["+", "/", "=", " ", "."]) expect(isPlausibleInvoiceToken(`${"A".repeat(42)}${ch}`), ch).toBe(false);
    for (const v of [null, undefined, 43, {}, ["A".repeat(43)]]) expect(isPlausibleInvoiceToken(v)).toBe(false);
  });
  it("builds the link from the origin, without a double slash", () => {
    expect(invoiceLinkUrl("https://app.example.test", "T".repeat(43))).toBe(`https://app.example.test/i/${"T".repeat(43)}`);
    expect(invoiceLinkUrl("https://app.example.test/", "T".repeat(43))).toBe(`https://app.example.test/i/${"T".repeat(43)}`);
  });
});

describe("mint-time screening of SSN-looking tokens", () => {
  it("re-draws a candidate that contains an SSN-shaped run and returns the next clean one", () => {
    const bad = bytesStartingWith("123456789-AA");
    const badToken = bad.toString("base64url");
    expect(containsSsnLikeText(badToken) || containsSsnLikeText(`/i/${badToken}`)).toBe(true);
    expect(tokenLooksSsnLike(badToken)).toBe(true);
    const good = Buffer.alloc(32, 0xab);
    let calls = 0;
    const r = mintInvoiceToken(() => {
      calls += 1;
      return calls === 1 ? bad : good;
    });
    expect(calls).toBe(2);
    expect(r.token).toBe(good.toString("base64url"));
    expect(tokenLooksSsnLike(r.token)).toBe(false);
  });
  it("gives up after the bound instead of looping forever", () => {
    const bad = bytesStartingWith("123456789-AA");
    let calls = 0;
    expect(() =>
      mintInvoiceToken(() => {
        calls += 1;
        return bad;
      })
    ).toThrow();
    expect(calls).toBe(MINT_MAX_TRIES);
  });
  it("a random source of the wrong length is never accepted as a token", () => {
    expect(() => mintInvoiceToken(() => Buffer.alloc(16, 1))).toThrow();
  });
});

describe("validity", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  it("precedence: unknown -> revoked -> expired; expiry is exclusive", () => {
    expect(evaluateInvoiceToken(null, now)).toEqual({ valid: false, reason: "not_found" });
    expect(evaluateInvoiceToken({ expiresAt: new Date(now.getTime() - 1), revokedAt: now }, now)).toEqual({ valid: false, reason: "revoked" });
    expect(evaluateInvoiceToken({ expiresAt: now, revokedAt: null }, now)).toEqual({ valid: false, reason: "expired" });
    expect(evaluateInvoiceToken({ expiresAt: new Date(now.getTime() + 1), revokedAt: null }, now)).toEqual({ valid: true });
    expect(isLiveToken({ expiresAt: new Date(now.getTime() + 1), revokedAt: null }, now)).toBe(true);
    expect(isLiveToken({ expiresAt: now, revokedAt: null }, now)).toBe(false);
  });
  it("expiry is now + the lifetime in days", () => {
    expect(tokenExpiry(now, 90).toISOString()).toBe("2027-01-21T12:00:00.000Z");
  });
});
