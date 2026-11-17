import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SmsConsentCard, type SmsConsentCardProps } from "@/components/settings/sms-consent-card";
import { SMS_CONSENT_TEXT, SMS_NOT_SET_UP_TEXT, SMS_OPTIONAL_TEXT, SMS_READ_FAILED_TEXT } from "@/lib/sms-consent-text";

// For the page test at the bottom: every server boundary of /settings/notifications is mocked.
const pageMocks = vi.hoisted(() => ({ loadSmsConsentState: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "u-1", name: "Eva" } })) }));
vi.mock("@/actions/notifications", () => ({ getNotifPrefs: vi.fn(async () => ({})), hasPushSubscription: vi.fn(async () => false) }));
vi.mock("@/actions/sms-consent", () => ({ saveSmsConsent: vi.fn(), withdrawSmsConsent: vi.fn() }));
vi.mock("@/lib/sms-consent-store", () => ({ loadSmsConsentState: pageMocks.loadSmsConsentState }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/notifications/push-subscribe-button", () => ({ PushSubscribeButton: () => <span>push-button</span> }));
vi.mock("@/components/notifications/notif-prefs-form", () => ({ NotifPrefsForm: () => <span>prefs-form</span> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import NotificationSettingsPage from "@/app/settings/notifications/page";

(globalThis as unknown as { React: typeof React }).React = React;

// The actions arrive as props, so no server module is imported here; static markup never calls them.
function render(over: Partial<SmsConsentCardProps> = {}): string {
  const props: SmsConsentCardProps = {
    load: "ok",
    status: "off",
    masked: null,
    sinceLabel: null,
    save: vi.fn(),
    withdraw: vi.fn(),
    ...over,
  };
  return renderToStaticMarkup(<SmsConsentCard {...props} />);
}

/** The same escaping React applies to text nodes. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const ON = { status: "on" as const, masked: "ending 0123", sinceLabel: "Nov 16, 2026" };

describe("SmsConsentCard", () => {
  it("table missing: only the not-set-up sentence, no form", () => {
    const html = render({ load: "table_missing" });
    expect(html).toBe(`<p class="text-sm text-muted-foreground">${esc(SMS_NOT_SET_UP_TEXT)}</p>`);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("checkbox");
  });

  it("read error: a short notice, no form", () => {
    const html = render({ load: "error" });
    expect(html).toContain(esc(SMS_READ_FAILED_TEXT));
    expect(html).not.toContain("<form");
  });

  it.each([
    ["off", {}],
    ["on", ON],
  ])("%s: the checkbox is never pre-ticked and its label is exactly the consent wording", (_name, over) => {
    const html = render(over);
    const box = html.match(/<input[^>]*type="checkbox"[^>]*>/);
    expect(box).not.toBeNull();
    expect(box![0]).not.toMatch(/\bchecked\b/);
    const id = box![0].match(/id="([^"]+)"/)![1]!;
    const label = html.match(new RegExp(`<label for="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([^<]*)</label>`));
    expect(label).not.toBeNull();
    expect(label![1]).toBe(esc(SMS_CONSENT_TEXT));
    expect(html).toMatch(/href="\/privacy#text-messages"/);
    expect(html).toContain(esc(SMS_OPTIONAL_TEXT));
    expect(html).toContain('type="tel"');
    expect(html).toContain('placeholder="(202) 555-0123"');
  });

  it("off: Turn on texts, no Stop texts", () => {
    const html = render();
    expect(html).toContain("Texts are off.");
    expect(html).toContain("Turn on texts");
    expect(html).not.toContain("Stop texts");
    // Disabled until a number is typed and the box is ticked.
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("on: masked number, Stop texts, and never the full number", () => {
    const html = render(ON);
    expect(html).toContain("Texts are on for your number ending 0123 (since Nov 16, 2026).");
    expect(html).toContain("Stop texts");
    expect(html).toContain("Save new number");
    expect(html).toContain("reply STOP");
    expect(html).not.toContain("2025550123");
    expect(html).not.toContain("+1202");
  });

  it("has a polite live region and no fixed widths over 22rem", () => {
    const html = render(ON);
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toMatch(/(?<![a-z]:)\b(w|min-w)-\[/);
  });
});

describe("/settings/notifications page", () => {
  it("still renders every card when the consent table is missing", async () => {
    pageMocks.loadSmsConsentState.mockResolvedValue({ state: "table_missing" });
    const html = renderToStaticMarkup(await NotificationSettingsPage());
    for (const t of ["Push notifications", "Text messages", "Alert types", "Run checks now", "push-button", "prefs-form"]) {
      expect(html).toContain(t);
    }
    expect(html).toContain(esc(SMS_NOT_SET_UP_TEXT));
    expect(html.indexOf("Text messages")).toBeLessThan(html.indexOf("Alert types"));
  });

  it("shows the masked number and the New York date when consent is on", async () => {
    pageMocks.loadSmsConsentState.mockResolvedValue({
      state: "ok",
      consent: {
        status: "on",
        phoneE164: "+12025550123",
        since: new Date("2026-11-17T03:00:00Z"), // still Nov 16 in New York
        wordingVersion: "2026-11-v1",
        wordingSha256: "x",
      },
    });
    const html = renderToStaticMarkup(await NotificationSettingsPage());
    expect(html).toContain("Texts are on for your number ending 0123 (since Nov 16, 2026).");
    expect(html).not.toContain("2025550123");
  });
});
