import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BASE_URL_NOT_CONFIGURED_ERROR,
  GENERIC_SEND_ERROR,
  SMS_BODY_MAX,
  SMS_NOT_CONFIGURED_ERROR,
  SMS_SUBJECT,
  buildReviewSmsBody,
  createEmailGatewaySmsSender,
  getAssigneeSmsAddress,
  resolveAppBaseUrl,
  sanitizeSmsError,
  sendReviewSms,
  type SmsSender,
} from "@/lib/sms-sender";

// No real sends: every sender here is a fake, and the lazily imported Resend
// module (only used by the default sender) is never reached.

const TOKEN = "A".repeat(43);
const ADDRESS = "5551234567@txt.example-carrier.test";
const BASE = "https://finance.example.test";
const URL_ = `${BASE}/queue/${TOKEN}`;

afterEach(() => vi.restoreAllMocks());

describe("buildReviewSmsBody", () => {
  it("contains the link and stays under one SMS for every kind and a 99-count batch", () => {
    for (const kind of ["initial", "reminder", "resend"] as const) {
      for (const count of [undefined, 1, 5, 99]) {
        const body = buildReviewSmsBody({ kind, url: URL_, count, senderName: "Eric" });
        expect(body).toContain(URL_);
        expect(body.length).toBeLessThanOrEqual(SMS_BODY_MAX);
        expect(body.length + SMS_SUBJECT.length + 2).toBeLessThan(160);
      }
    }
  });

  it("is short and plain (no HTML), and matches the agreed wording", () => {
    expect(buildReviewSmsBody({ kind: "initial", url: URL_, senderName: "Eric" })).toBe(
      `Eric has transactions for you to tag: ${URL_}`
    );
    expect(buildReviewSmsBody({ kind: "initial", url: URL_, count: 1, senderName: "Eric" })).toContain(
      "1 transaction for"
    );
    expect(buildReviewSmsBody({ kind: "initial", url: URL_, count: 5, senderName: "Eric" })).toContain(
      "5 transactions for"
    );
    expect(buildReviewSmsBody({ kind: "reminder", url: URL_, senderName: "Eric" })).toMatch(/^Reminder: /);
    expect(buildReviewSmsBody({ kind: "initial", url: URL_ })).not.toMatch(/[<>]/);
  });

  it("falls back to minimal wording rather than exceed the budget, still with the full link", () => {
    const longUrl = `https://a-very-long-hostname-for-the-app.example-domain.test/queue/${TOKEN}`;
    const body = buildReviewSmsBody({
      kind: "reminder",
      url: longUrl,
      senderName: "Maximiliano-Bartholomew",
    });
    expect(body).toContain(longUrl);
    expect(body.length).toBeLessThanOrEqual(SMS_BODY_MAX);
  });

  it("sanitizes the sender name (letters only, capped, defaults to Eric)", () => {
    expect(buildReviewSmsBody({ kind: "initial", url: URL_, senderName: "<b>Eve</b>" })).toMatch(/^bEve/);
    expect(buildReviewSmsBody({ kind: "initial", url: URL_, senderName: "   " })).toMatch(/^Eric has/);
    expect(buildReviewSmsBody({ kind: "initial", url: URL_, senderName: "Eric Kinniburgh" })).toMatch(
      /^Eric has/
    );
  });
});

describe("getAssigneeSmsAddress", () => {
  it("returns null when unset, blank, or not email-shaped (never throws)", () => {
    expect(getAssigneeSmsAddress({})).toBeNull();
    expect(getAssigneeSmsAddress({ EVA_SMS_GATEWAY_ADDRESS: "   " })).toBeNull();
    expect(getAssigneeSmsAddress({ EVA_SMS_GATEWAY_ADDRESS: "5551234567" })).toBeNull();
    expect(getAssigneeSmsAddress({ EVA_SMS_GATEWAY_ADDRESS: "a@b" })).toBeNull();
    expect(getAssigneeSmsAddress({ EVA_SMS_GATEWAY_ADDRESS: "a@b.com, c@d.com" })).toBeNull();
  });
  it("returns the trimmed address when valid", () => {
    expect(getAssigneeSmsAddress({ EVA_SMS_GATEWAY_ADDRESS: `  ${ADDRESS} ` })).toBe(ADDRESS);
  });
});

describe("resolveAppBaseUrl", () => {
  it("uses NEXTAUTH_URL's origin (trailing slash and path dropped)", () => {
    expect(resolveAppBaseUrl({ NEXTAUTH_URL: "https://app.example.test/" })).toBe("https://app.example.test");
    expect(resolveAppBaseUrl({ NEXTAUTH_URL: "https://app.example.test/some/path" })).toBe(
      "https://app.example.test"
    );
  });
  it("does NOT fall back to VERCEL_URL (per-deployment hostname)", () => {
    expect(resolveAppBaseUrl({ VERCEL_URL: "x-abc123.vercel.app" })).toBeNull();
  });
  it("null when unset/garbage; localhost is fine in dev but rejected in production", () => {
    expect(resolveAppBaseUrl({})).toBeNull();
    expect(resolveAppBaseUrl({ NEXTAUTH_URL: "not a url" })).toBeNull();
    expect(resolveAppBaseUrl({ NEXTAUTH_URL: "javascript:alert(1)" })).toBeNull();
    expect(resolveAppBaseUrl({ NEXTAUTH_URL: "http://localhost:3000", NODE_ENV: "development" })).toBe(
      "http://localhost:3000"
    );
    expect(resolveAppBaseUrl({ NEXTAUTH_URL: "http://localhost:3000", NODE_ENV: "production" })).toBeNull();
    expect(resolveAppBaseUrl({ NEXTAUTH_URL: "http://localhost:3000", VERCEL_ENV: "production" })).toBeNull();
  });
});

describe("sanitizeSmsError", () => {
  it("strips addresses, links and token-like strings but keeps the useful part", () => {
    const msg = sanitizeSmsError(
      new Error(`Email failed: You can only send testing emails to your own email address (owner@example.test). See https://resend.com/docs/x?t=${TOKEN}`)
    );
    expect(msg).not.toContain("owner@example.test");
    expect(msg).not.toContain("https://");
    expect(msg).not.toContain(TOKEN);
    expect(msg).toContain("testing emails");
  });
  it("never echoes the recipient address or a token even if the provider does", () => {
    const msg = sanitizeSmsError(new Error(`rejected ${ADDRESS} for ${URL_}`));
    expect(msg).not.toContain(ADDRESS);
    expect(msg).not.toContain("5551234567");
    expect(msg).not.toContain(TOKEN);
  });
  it("is bounded and falls back to a generic message for non-errors/empty", () => {
    expect(sanitizeSmsError(new Error("x ".repeat(500))).length).toBeLessThanOrEqual(160);
    expect(sanitizeSmsError(undefined)).toBe(GENERIC_SEND_ERROR);
    expect(sanitizeSmsError(new Error("   "))).toBe(GENERIC_SEND_ERROR);
  });
});

describe("createEmailGatewaySmsSender", () => {
  it("sends plain text with the tiny subject through the injected email function", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const res = await createEmailGatewaySmsSender(send).send(ADDRESS, "hello");
    expect(res).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith({ to: ADDRESS, subject: SMS_SUBJECT, text: "hello" });
  });
  it("maps a provider throw to {ok:false} with a sanitized error and never rethrows", async () => {
    const send = vi.fn().mockRejectedValue(new Error(`Email failed: bad recipient ${ADDRESS}`));
    const res = await createEmailGatewaySmsSender(send).send(ADDRESS, `see ${URL_}`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toContain(ADDRESS);
    expect(res.error).not.toContain(TOKEN);
  });
  it("logs nothing (no address, body or link goes to the console)", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    await createEmailGatewaySmsSender(vi.fn().mockRejectedValue(new Error("boom"))).send(ADDRESS, URL_);
    await createEmailGatewaySmsSender(vi.fn().mockResolvedValue(undefined)).send(ADDRESS, URL_);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("sendReviewSms", () => {
  function fakeSender(result: Awaited<ReturnType<SmsSender["send"]>> = { ok: true }) {
    const send = vi.fn<SmsSender["send"]>().mockResolvedValue(result);
    return { sender: { send } as SmsSender, send };
  }

  it("unset gateway address -> {ok:false} with the 'not configured' reason, no send, no throw", async () => {
    const { sender, send } = fakeSender();
    const res = await sendReviewSms({ address: null, baseUrl: BASE, token: TOKEN, kind: "initial", sender });
    expect(res).toEqual({ ok: false, error: SMS_NOT_CONFIGURED_ERROR });
    expect(send).not.toHaveBeenCalled();
  });

  it("no usable base URL -> {ok:false}, no send", async () => {
    const { sender, send } = fakeSender();
    const res = await sendReviewSms({ address: ADDRESS, baseUrl: null, token: TOKEN, kind: "initial", sender });
    expect(res).toEqual({ ok: false, error: BASE_URL_NOT_CONFIGURED_ERROR });
    expect(send).not.toHaveBeenCalled();
  });

  it("builds <base>/queue/<token> into the body and sends to the address", async () => {
    const { sender, send } = fakeSender();
    const res = await sendReviewSms({
      address: ADDRESS,
      baseUrl: BASE,
      token: TOKEN,
      kind: "initial",
      count: 3,
      senderName: "Eric",
      sender,
    });
    expect(res).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    const [to, body] = send.mock.calls[0]!;
    expect(to).toBe(ADDRESS);
    expect(body).toContain(URL_);
    expect(body.length).toBeLessThanOrEqual(SMS_BODY_MAX);
  });

  it("passes through a sender failure and converts an unexpected throw to a generic failure", async () => {
    const failing = fakeSender({ ok: false, error: "gateway said no" });
    expect(
      await sendReviewSms({ address: ADDRESS, baseUrl: BASE, token: TOKEN, kind: "resend", sender: failing.sender })
    ).toEqual({ ok: false, error: "gateway said no" });

    const throwing: SmsSender = { send: vi.fn().mockRejectedValue(new Error(`leak ${ADDRESS} ${TOKEN}`)) };
    const res = await sendReviewSms({ address: ADDRESS, baseUrl: BASE, token: TOKEN, kind: "resend", sender: throwing });
    expect(res).toEqual({ ok: false, error: GENERIC_SEND_ERROR });
  });
});

describe("buildReviewSmsBody with a realistic production host", () => {
  it("keeps the real wording (no fallback) for a ~40-char host, all kinds", () => {
    const url = `https://kinniburgh-finance.vercel.app/queue/${TOKEN}`;
    for (const kind of ["initial", "reminder", "resend"] as const) {
      const body = buildReviewSmsBody({ kind, url, count: 99, senderName: "Eric" });
      expect(body).toContain("Eric has");
      expect(body.length).toBeLessThanOrEqual(SMS_BODY_MAX);
    }
    expect(buildReviewSmsBody({ kind: "reminder", url, senderName: "Eric" })).toMatch(/^Reminder: Eric has/);
  });
});
