import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReviewSmsBody, SMS_BODY_MAX } from "@/lib/sms-sender";
import {
  formatTwilioBody,
  isGsm7Basic,
  SINGLE_SEGMENT_MAX,
  SMS_BRAND_PREFIX,
  STOP_FOOTER,
} from "@/lib/twilio-sms";

describe("Twilio body carries the Banana Stand brand prefix", () => {
  it("every body starts with the prefix", () => {
    expect(SMS_BRAND_PREFIX).toBe("Banana Stand: ");
    expect(formatTwilioBody("x").startsWith("Banana Stand: ")).toBe(true);
  });

  it("prefix + the longest allowed body stays one GSM-7 segment", () => {
    const body = "a".repeat(SMS_BODY_MAX);
    const out = formatTwilioBody(body);
    expect(out).toBe(SMS_BRAND_PREFIX + body);
    expect(out.length).toBeLessThanOrEqual(SINGLE_SEGMENT_MAX);
    expect(isGsm7Basic(out)).toBe(true);
  });

  it("adds the STOP footer only when prefix + body + footer fits 160", () => {
    const short = buildReviewSmsBody({ kind: "initial", url: "https://example.test/queue/abc", count: 2, senderName: "Eric" });
    expect(formatTwilioBody(short)).toBe(SMS_BRAND_PREFIX + short + STOP_FOOTER);
    const room = SINGLE_SEGMENT_MAX - SMS_BRAND_PREFIX.length - STOP_FOOTER.length;
    expect(formatTwilioBody("a".repeat(room))).toBe(SMS_BRAND_PREFIX + "a".repeat(room) + STOP_FOOTER);
    expect(formatTwilioBody("a".repeat(room + 1))).toBe(SMS_BRAND_PREFIX + "a".repeat(room + 1));
  });
});

describe("privacy page retention matches the kept consent log", () => {
  const src = readFileSync(join(process.cwd(), "app/privacy/page.tsx"), "utf8").replace(/\s+/g, " ");
  it("Data Retention names the consent-record exception", () => {
    expect(src).toContain("except for records of text-message consent and opt-outs");
    expect(src).toContain("use for no other purpose");
  });
  it("effective date is the revision date", () => {
    expect(src).toContain("Effective date: November 16, 2026");
  });
});
