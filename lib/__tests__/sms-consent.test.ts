import { describe, expect, it } from "vitest";
import {
  CONSENT_ALREADY_OFF_MESSAGE,
  CONSENT_ALREADY_ON_MESSAGE,
  CONSENT_NOT_AGREED_ERROR,
  CONSENT_STALE_PAGE_ERROR,
  CONSENT_UNKNOWN_STATE_ERROR,
  PHONE_SSN_ERROR,
  PHONE_US_ONLY_ERROR,
  SMS_CONSENT_METHOD,
  SMS_CONSENT_SHA256,
  consentAuditPayload,
  foldConsentState,
  maskPhone,
  normalizeUsMobile,
  planConsentEvent,
  sha256Hex,
  type ConsentEventRow,
} from "@/lib/sms-consent";
import { SMS_CONSENT_TEXT, SMS_CONSENT_VERSION } from "@/lib/sms-consent-text";

// Fictional numbers only (555-01xx).
const E164 = "+12025550123";

describe("SMS consent wording", () => {
  it("is exactly the requested wording, with a pinned version and sha256", () => {
    expect(SMS_CONSENT_TEXT).toBe(
      "Send me text messages about transactions assigned to me for review. Message frequency varies (usually under 10/month). Msg & data rates may apply. Reply STOP to opt out, HELP for help."
    );
    expect(SMS_CONSENT_VERSION).toBe("2026-11-v1");
    // Any wording change fails here until the version is bumped and this hash is updated deliberately.
    expect(SMS_CONSENT_SHA256).toBe("3e31d8527facff326023983671f17ce891c1e9dc957beb70e86dc4b200abbe69");
    expect(sha256Hex(SMS_CONSENT_TEXT)).toBe(SMS_CONSENT_SHA256);
  });
});

describe("normalizeUsMobile", () => {
  it.each([
    "(202) 555-0123",
    "202-555-0123",
    "202.555.0123",
    "2025550123",
    "12025550123",
    "+1 202 555 0123",
    "+12025550123",
    "  202 555 0123  ",
    "1 (202) 555-0123",
  ])("accepts %s", (raw) => {
    expect(normalizeUsMobile(raw)).toEqual({ ok: true, e164: E164 });
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["202-555-01ab", "letters"],
    ["call 2025550123", "words"],
    ["202_555_0123", "underscore"],
    ["202/555/0123", "slash"],
    ["202 555 0123 ext 5", "extension"],
    ["555-0123", "7 digits"],
    ["202555012345", "12 digits"],
    ["22025550123", "11 digits not starting 1"],
    ["(102) 555-0123", "area code starting 1"],
    ["(002) 555-0123", "area code starting 0"],
    ["(202) 155-0123", "exchange starting 1"],
    ["(202) 055-0123", "exchange starting 0"],
    ["+1 202 555 01234", "+1 with 11 digits after"],
    ["202+5550123", "plus in the middle"],
    ["++12025550123", "two plus signs"],
    ["2".repeat(33), "over 32 characters"],
  ])("refuses %s (%s)", (raw) => {
    const r = normalizeUsMobile(raw);
    expect(r.ok).toBe(false);
  });

  it("refuses SSN shapes with the SSN message", () => {
    for (const raw of ["123-45-6789", "123456789", "123 45 6789", "(123) 456-789"]) {
      expect(normalizeUsMobile(raw)).toEqual({ ok: false, error: PHONE_SSN_ERROR });
    }
  });

  it("refuses non-US numbers", () => {
    expect(normalizeUsMobile("+44 20 7946 0123")).toEqual({ ok: false, error: PHONE_US_ONLY_ERROR });
    expect(normalizeUsMobile("+33 1 23 45 67 89")).toEqual({ ok: false, error: PHONE_US_ONLY_ERROR });
  });

  it("never echoes the input in an error", () => {
    const inputs = [
      "123-45-6789",
      "+44 20 7946 0123",
      "(102) 555-0123",
      "555-0199",
      "202555019912",
      "202-555-01ab",
      "9".repeat(40),
    ];
    for (const raw of inputs) {
      const r = normalizeUsMobile(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const digits = raw.replace(/\D/g, "");
        expect(r.error).not.toContain(raw.trim());
        if (digits.length >= 4) expect(r.error).not.toContain(digits.slice(-4));
        expect(r.error).not.toMatch(/\d{3,}/);
      }
    }
  });
});

describe("maskPhone", () => {
  it("shows the last four digits only", () => {
    expect(maskPhone(E164)).toBe("ending 0123");
    expect(maskPhone(E164)).not.toContain("202");
  });
});

function row(over: Partial<ConsentEventRow> & { seq: number }): ConsentEventRow {
  return {
    kind: "consented",
    phoneE164: E164,
    wordingVersion: SMS_CONSENT_VERSION,
    wordingSha256: SMS_CONSENT_SHA256,
    createdAt: new Date(`2026-11-${String(over.seq).padStart(2, "0")}T12:00:00Z`),
    ...over,
  };
}

describe("foldConsentState", () => {
  it("no rows = off", () => {
    expect(foldConsentState([])).toEqual({ status: "off", lastWithdrawnAt: null });
  });

  it("uses the highest seq regardless of input order", () => {
    const rows = [row({ seq: 3, kind: "withdrawn" }), row({ seq: 1 }), row({ seq: 2, phoneE164: "+12025550188" })];
    expect(foldConsentState(rows)).toEqual({ status: "off", lastWithdrawnAt: rows[0]!.createdAt });
    const on = foldConsentState([row({ seq: 2, phoneE164: "+12025550188" }), row({ seq: 1, kind: "withdrawn" })]);
    expect(on.status).toBe("on");
    if (on.status === "on") expect(on.phoneE164).toBe("+12025550188");
  });

  it("an unknown kind on the latest row is unknown (not sendable)", () => {
    expect(foldConsentState([row({ seq: 1 }), row({ seq: 2, kind: "paused" })])).toEqual({ status: "unknown" });
  });
});

describe("planConsentEvent", () => {
  const off = foldConsentState([]);
  const on = foldConsentState([row({ seq: 1 })]);

  it("consent needs agreed === true exactly", () => {
    for (const agreed of [false, "true", 1, null, undefined, "yes"]) {
      expect(planConsentEvent(off, { action: "consent", phoneE164: E164, agreed, wordingVersion: SMS_CONSENT_VERSION })).toEqual({
        kind: "refused",
        error: CONSENT_NOT_AGREED_ERROR,
      });
    }
  });

  it("refuses a stale wording version", () => {
    expect(planConsentEvent(off, { action: "consent", phoneE164: E164, agreed: true, wordingVersion: "2026-10-v0" })).toEqual({
      kind: "refused",
      error: CONSENT_STALE_PAGE_ERROR,
    });
  });

  it("refuses a number that is not normalized", () => {
    expect(planConsentEvent(off, { action: "consent", phoneE164: "2025550123", agreed: true, wordingVersion: SMS_CONSENT_VERSION }).kind).toBe(
      "refused"
    );
  });

  it("consent while off writes a consented row with the current wording", () => {
    expect(planConsentEvent(off, { action: "consent", phoneE164: E164, agreed: true, wordingVersion: SMS_CONSENT_VERSION })).toEqual({
      kind: "row",
      row: {
        kind: "consented",
        phoneE164: E164,
        wordingVersion: SMS_CONSENT_VERSION,
        wordingSha256: SMS_CONSENT_SHA256,
        method: SMS_CONSENT_METHOD,
      },
    });
  });

  it("same number + version while on is a no-op; a new number is a new row", () => {
    expect(planConsentEvent(on, { action: "consent", phoneE164: E164, agreed: true, wordingVersion: SMS_CONSENT_VERSION })).toEqual({
      kind: "noop",
      message: CONSENT_ALREADY_ON_MESSAGE,
    });
    const change = planConsentEvent(on, { action: "consent", phoneE164: "+12025550188", agreed: true, wordingVersion: SMS_CONSENT_VERSION });
    expect(change.kind).toBe("row");
    if (change.kind === "row") expect(change.row.phoneE164).toBe("+12025550188");
  });

  it("consent replaces an older wording version", () => {
    const old = foldConsentState([row({ seq: 1, wordingVersion: "2026-01-v0", wordingSha256: "f".repeat(64) })]);
    expect(planConsentEvent(old, { action: "consent", phoneE164: E164, agreed: true, wordingVersion: SMS_CONSENT_VERSION }).kind).toBe("row");
  });

  it("withdraw while off is a no-op", () => {
    expect(planConsentEvent(off, { action: "withdraw" })).toEqual({ kind: "noop", message: CONSENT_ALREADY_OFF_MESSAGE });
  });

  it("withdraw while on carries the current number and that consent's wording version and hash", () => {
    const old = foldConsentState([row({ seq: 1, wordingVersion: "2026-01-v0", wordingSha256: "a".repeat(64) })]);
    expect(planConsentEvent(old, { action: "withdraw" })).toEqual({
      kind: "row",
      row: { kind: "withdrawn", phoneE164: E164, wordingVersion: "2026-01-v0", wordingSha256: "a".repeat(64), method: SMS_CONSENT_METHOD },
    });
  });

  it("withdraw on an unknown state is refused (nothing guessed)", () => {
    expect(planConsentEvent({ status: "unknown" }, { action: "withdraw" })).toEqual({ kind: "refused", error: CONSENT_UNKNOWN_STATE_ERROR });
  });
});

describe("consentAuditPayload", () => {
  it("holds ids, kind, seq and wording version only", () => {
    const p = consentAuditPayload({ id: "evt-1", kind: "consented", seq: 2, wordingVersion: SMS_CONSENT_VERSION });
    expect(p).toEqual({ eventId: "evt-1", kind: "consented", seq: 2, wordingVersion: SMS_CONSENT_VERSION });
    expect(Object.keys(p).sort()).toEqual(["eventId", "kind", "seq", "wordingVersion"]);
  });
});
