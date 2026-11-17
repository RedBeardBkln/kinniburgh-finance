import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TermsPage from "@/app/terms/page";
import {
  PRIVACY_SMS_FREQUENCY,
  PRIVACY_SMS_NO_SHARING,
  PRIVACY_SMS_OPTIONAL,
  PRIVACY_SMS_RATES,
  SMS_CONSENT_TEXT,
} from "@/lib/sms-consent-text";

(globalThis as unknown as { React: typeof React }).React = React;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("/terms SMS program terms (Twilio toll-free verification)", () => {
  const html = renderToStaticMarkup(<TermsPage />);
  const section = html.match(/<section id="sms"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
  const plain = text(section);

  it("has the SMS section", () => {
    expect(section).not.toBe("");
  });

  it("carries the shared statements verbatim", () => {
    for (const s of [PRIVACY_SMS_OPTIONAL, PRIVACY_SMS_FREQUENCY, PRIVACY_SMS_RATES, PRIVACY_SMS_NO_SHARING]) {
      expect(section).toContain(esc(s));
    }
  });

  it("quotes the exact consent checkbox wording", () => {
    expect(plain).toContain(SMS_CONSENT_TEXT);
  });

  it("names the program, STOP, HELP, a support contact, carrier liability and the privacy link", () => {
    expect(plain).toContain("Program name: Banana Stand review notifications.");
    expect(plain).toMatch(/reply STOP to any message/);
    expect(plain).toMatch(/reply HELP to any message/);
    expect(section).toContain("mailto:");
    expect(plain).toContain("Carriers are not liable for delayed or undelivered messages.");
    expect(section).toContain('href="/privacy#text-messages"');
  });

  it("shows an effective date", () => {
    expect(text(html)).toContain("Effective date: November 16, 2026");
  });
});

describe("/terms is public", () => {
  it("is in middleware PUBLIC_PATHS", () => {
    const mw = readFileSync(path.join(process.cwd(), "middleware.ts"), "utf8");
    const list = /const PUBLIC_PATHS = \[([^\]]*)\]/.exec(mw)?.[1] ?? "";
    expect(list).toContain('"/terms"');
  });
});
