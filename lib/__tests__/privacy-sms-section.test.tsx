import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage from "@/app/privacy/page";
import {
  PRIVACY_SMS_FREQUENCY,
  PRIVACY_SMS_NO_SHARING,
  PRIVACY_SMS_OPTIONAL,
  PRIVACY_SMS_PROVIDER,
  PRIVACY_SMS_RATES,
  PRIVACY_SMS_STATEMENTS,
  PRIVACY_SMS_STOP_HELP,
  PRIVACY_SMS_WHAT,
} from "@/lib/sms-consent-text";

(globalThis as unknown as { React: typeof React }).React = React;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ROOT = process.cwd();

describe("/privacy Text Messages (SMS) section", () => {
  const html = renderToStaticMarkup(<PrivacyPage />);
  const section = html.match(/<section id="text-messages"[^>]*>([\s\S]*?)<\/section>/);

  it("exists with the text-messages id", () => {
    expect(section).not.toBeNull();
    expect(section![1]).toContain("Text Messages (SMS)");
  });

  it("renders every required statement inside the section", () => {
    for (const s of PRIVACY_SMS_STATEMENTS) expect(section![1]).toContain(esc(s));
  });

  it("the statements say what Twilio toll-free verification needs", () => {
    expect(PRIVACY_SMS_NO_SHARING).toBe(
      "Mobile numbers and SMS opt-in consent are never shared with or sold to third parties or affiliates for marketing purposes."
    );
    expect(PRIVACY_SMS_WHAT).toMatch(/transactions assigned to you for review/);
    expect(PRIVACY_SMS_WHAT).toMatch(/reminder/);
    expect(PRIVACY_SMS_FREQUENCY).toMatch(/Message frequency varies/);
    expect(PRIVACY_SMS_RATES).toBe("Message and data rates may apply.");
    expect(PRIVACY_SMS_STOP_HELP).toMatch(/Reply STOP/);
    expect(PRIVACY_SMS_STOP_HELP).toMatch(/Reply HELP/);
    expect(PRIVACY_SMS_OPTIONAL).toMatch(/optional and is not a condition/);
    expect(PRIVACY_SMS_PROVIDER).toMatch(/Twilio/);
  });

  it("the page uses the exported constants (not a copy of the text)", () => {
    const src = readFileSync(path.join(ROOT, "app/privacy/page.tsx"), "utf8");
    expect(src).toMatch(/from "@\/lib\/sms-consent-text"/);
    expect(src).not.toContain("never shared with or sold");
    expect(src).toContain("{PRIVACY_SMS_NO_SHARING}");
  });

  it("lists the optional mobile number under Information We Collect", () => {
    expect(html).toContain("Mobile phone number (optional):");
  });

  it("/privacy is still a public path", () => {
    const mw = readFileSync(path.join(ROOT, "middleware.ts"), "utf8");
    expect(mw).toMatch(/PUBLIC_PATHS[\s\S]*"\/privacy"/);
  });
});
