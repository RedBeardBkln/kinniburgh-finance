import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Tester-authored adversarial checks for Phase 3 of assign-to-eva-review-queue.
// Everything is pure or mocked at the db / runner boundary: no DB read/write, no
// real email or SMS, no Resend call.

const runner = vi.hoisted(() => ({ runReviewReminders: vi.fn() }));
vi.mock("@/lib/review-reminder-runner", () => runner);

import { GET } from "@/app/api/cron/review-reminders/route";
import { isReminderDue, isWithinSendWindow, REMINDER_DELAY_MS } from "@/lib/review-reminder";
import { rulePatternMatchesPayee, isUsableRulePattern, visibleChipKind } from "@/lib/review-queue";
import { suggestPayeePattern, normalizePayee } from "@/lib/tags";
import { isReviewQueuePath } from "@/lib/pwa-install";
import {
  buildReviewSmsBody,
  sanitizeSmsError,
  sendReviewSms,
  SMS_BODY_MAX,
  getAssigneeSmsAddress,
} from "@/lib/sms-sender";
import { scrubQueueTokensFromEvent } from "@/lib/sentry-scrub";

const HOUR = 3600_000;

// ── cron route auth ──────────────────────────────────────────────────────────
describe("GET /api/cron/review-reminders auth", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CRON_SECRET", "s3cret-value");
    runner.runReviewReminders.mockResolvedValue({
      outsideWindow: false,
      considered: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  function req(headers: Record<string, string> = {}) {
    return new NextRequest("http://localhost/api/cron/review-reminders", { headers });
  }

  it("rejects a missing Authorization header with 401 and never runs the runner", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(runner.runReviewReminders).not.toHaveBeenCalled();
  });

  it("rejects a wrong token, a bare secret (no Bearer), wrong case scheme, and a double-space variant", async () => {
    for (const h of [
      "Bearer wrong",
      "s3cret-value",
      "bearer s3cret-value",
      // (a trailing-space variant is not testable: the Headers API trims it)
      "Bearer  s3cret-value",
      "Bearer ",
    ]) {
      const res = await GET(req({ authorization: h }));
      expect(res.status, h).toBe(401);
    }
    expect(runner.runReviewReminders).not.toHaveBeenCalled();
  });

  it("accepts the exact bearer token and returns the run summary", async () => {
    const res = await GET(req({ authorization: "Bearer s3cret-value" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outsideWindow: false,
      considered: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    });
    expect(runner.runReviewReminders).toHaveBeenCalledTimes(1);
  });

  it("a runner crash becomes a bodyless-detail 500 JSON, not an uncaught throw", async () => {
    runner.runReviewReminders.mockRejectedValue(new Error("db secret detail 5551234567@x.test"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(req({ authorization: "Bearer s3cret-value" }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("5551234567");
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("5551234567");
    }
    spy.mockRestore();
  });

  // Documents a PRE-EXISTING property shared by all four older cron routes (same
  // string compare): with CRON_SECRET unset, "Bearer undefined" authorizes.
  it("[pre-existing, shared with other crons] unset CRON_SECRET => 'Bearer undefined' passes", async () => {
    vi.unstubAllEnvs();
    delete process.env.CRON_SECRET;
    const res = await GET(req({ authorization: "Bearer undefined" }));
    expect(res.status).toBe(200);
  });
});

// ── DST edges, hour by hour, against independently derived offsets ───────────
describe("send window across both 2026 DST transitions (independent oracle)", () => {
  // US DST 2026: starts Sun 2026-03-08 at 07:00Z (02:00 EST -> 03:00 EDT);
  // ends Sun 2026-11-01 at 06:00Z (02:00 EDT -> 01:00 EST).
  const SPRING = Date.UTC(2026, 2, 8, 7, 0, 0);
  const FALL = Date.UTC(2026, 10, 1, 6, 0, 0);
  function oracleLocalHour(ms: number): number {
    const offset = ms >= SPRING && ms < FALL ? -4 : -5;
    return new Date(ms + offset * HOUR).getUTCHours();
  }

  for (const [label, dayStart] of [
    ["2026-03-07..09", Date.UTC(2026, 2, 7)],
    ["2026-10-31..2026-11-02", Date.UTC(2026, 9, 31)],
  ] as const) {
    it(`every 30 min across ${label} matches the oracle`, () => {
      for (let ms = dayStart; ms < dayStart + 72 * HOUR; ms += 30 * 60_000) {
        const h = oracleLocalHour(ms);
        const expected = h >= 9 && h < 20;
        expect(isWithinSendWindow(new Date(ms)), new Date(ms).toISOString()).toBe(expected);
      }
    });
  }

  it("24h is absolute: a text 24h before a 15:00Z run on the spring/fall day is due exactly at 24h", () => {
    for (const run of [Date.UTC(2026, 2, 8, 15, 0, 0), Date.UTC(2026, 10, 1, 15, 0, 0)]) {
      const base = {
        status: "submitted",
        firstOpenedAt: null,
        smsStatus: "sent",
        reminderStatus: null,
        expiresAt: new Date(run + 5 * 24 * HOUR),
      };
      expect(
        isReminderDue({ ...base, smsSentAt: new Date(run - REMINDER_DELAY_MS) }, new Date(run)).due
      ).toBe(true);
      expect(
        isReminderDue({ ...base, smsSentAt: new Date(run - REMINDER_DELAY_MS + 1) }, new Date(run))
      ).toEqual({ due: false, reason: "too_early" });
    }
  });
});

// ── queue-rule payee-containment guard ───────────────────────────────────────
describe("rulePatternMatchesPayee (tricky inputs)", () => {
  it("case and punctuation differences still match (alnum semantics)", () => {
    expect(rulePatternMatchesPayee("LOWE'S", ["Lowes #1234"])).toBe(true);
    expect(rulePatternMatchesPayee("stop & shop", [null, "STOP-AND SHOP 55"])).toBe(false); // "and" != "&"
    expect(rulePatternMatchesPayee("stop shop", ["Stop & Shop #55"])).toBe(true);
    expect(rulePatternMatchesPayee("AMZN Mktp US", ["AMZN MKTP US*2X4Y"])).toBe(true);
  });
  it("pattern longer than payee, or not contained, is refused", () => {
    expect(rulePatternMatchesPayee("starbucks coffee company", ["starbucks"])).toBe(false);
    expect(rulePatternMatchesPayee("netflix", ["spotify"])).toBe(false);
  });
  it("pattern that is empty after normalization is refused (never 'contained in everything')", () => {
    for (const p of ["", "   ", "!!!", "***", "---", "'"]) {
      expect(rulePatternMatchesPayee(p, ["anything at all"]), JSON.stringify(p)).toBe(false);
    }
  });
  it("non-latin-only pattern normalizes to empty -> refused", () => {
    expect(rulePatternMatchesPayee("日本語", ["日本語 store"])).toBe(false);
  });
  it("null / empty / undefined payees never match and never throw", () => {
    expect(rulePatternMatchesPayee("abc", [])).toBe(false);
    expect(rulePatternMatchesPayee("abc", [null, undefined, ""])).toBe(false);
  });
  it("matches against either raw or normalized payee", () => {
    expect(rulePatternMatchesPayee("amazon", ["AMAZON.COM*1A2B", "amazon com 1a2b"])).toBe(true);
    expect(rulePatternMatchesPayee("amazon", [null, "amazon com"])).toBe(true);
  });
  it("the pre-filled suggestion (suggestPayeePattern of the item's own payee) always passes its own guard", () => {
    const payees = [
      "XFINITY MOBILE - 888-936-4968 PA",
      "Interest Earned Credit - Interest period 2025-07-28 ~ 2025-08-27",
      "LOWE'S #1234 BROOKLYN NY",
      "AMZN Mktp US*2X4Y9Z",
      "TST* Joe's Pizza",
      "SQ *BLUE BOTTLE COFFEE",
      "7-ELEVEN 34567",
      "H&M 0123",
    ];
    for (const raw of payees) {
      const norm = normalizePayee(raw);
      const pattern = suggestPayeePattern(norm);
      if (isUsableRulePattern(pattern)) {
        expect(rulePatternMatchesPayee(pattern, [raw, norm]), raw).toBe(true);
      }
    }
  });
});

describe("visibleChipKind", () => {
  it("hides only 'with_assignee' when tagged; draft/returned and untagged are unchanged", () => {
    expect(visibleChipKind("with_assignee", 1)).toBeNull();
    expect(visibleChipKind("with_assignee", 0)).toBe("with_assignee");
    expect(visibleChipKind("draft", 3)).toBe("draft");
    expect(visibleChipKind("returned", 3)).toBe("returned");
    expect(visibleChipKind(null, 2)).toBeNull();
  });
});

// ── PWA banner path predicate ────────────────────────────────────────────────
describe("isReviewQueuePath", () => {
  it("hides on /queue and /queue/... only", () => {
    expect(isReviewQueuePath("/queue")).toBe(true);
    expect(isReviewQueuePath("/queue/")).toBe(true);
    expect(isReviewQueuePath("/queue/abc123")).toBe(true);
    expect(isReviewQueuePath("/queueing")).toBe(false);
    expect(isReviewQueuePath("/queues")).toBe(false);
    expect(isReviewQueuePath("/transactions")).toBe(false);
    expect(isReviewQueuePath("/")).toBe(false);
    expect(isReviewQueuePath("/api/queue")).toBe(false);
    expect(isReviewQueuePath(null)).toBe(false);
    expect(isReviewQueuePath(undefined)).toBe(false);
    expect(isReviewQueuePath("")).toBe(false);
  });
});

// ── SMS body budget + privacy ────────────────────────────────────────────────
describe("SMS body budget with realistic production links", () => {
  const TOKEN = "A".repeat(43);
  const hosts = [
    "https://kinniburgh-finance.vercel.app",
    "https://finance.ericandeva.com",
    "https://kinniburgh-finance-git-main-redbeardbkln.vercel.app",
  ];
  it("always includes the full link and fits one SMS (<=140 body, <160 with subject) for each kind and counts 1/9/99/1000", () => {
    for (const host of hosts) {
      for (const kind of ["initial", "resend", "reminder"] as const) {
        for (const count of [undefined, 1, 9, 99, 1000]) {
          const body = buildReviewSmsBody({ kind, url: `${host}/queue/${TOKEN}`, count });
          expect(body, `${host} ${kind} ${count}`).toContain(`${host}/queue/${TOKEN}`);
          expect(body.length).toBeLessThanOrEqual(SMS_BODY_MAX);
          expect(body.length + "Review".length + 3).toBeLessThan(160);
        }
      }
    }
  });
  it("count of 0 or negative does not produce '0 transactions'", () => {
    expect(buildReviewSmsBody({ kind: "initial", url: "https://x.test/queue/t", count: 0 })).not.toMatch(/\b0 /);
    expect(buildReviewSmsBody({ kind: "initial", url: "https://x.test/queue/t", count: -2 })).not.toMatch(/-2/);
  });
  it("sender name with injection-ish content is neutralized", () => {
    const b = buildReviewSmsBody({
      kind: "initial",
      url: "https://x.test/queue/t",
      senderName: "Eric\r\nBcc: evil@x.test <script>",
    });
    expect(b).not.toMatch(/[\r\n<>@]/);
  });
});

describe("sanitizeSmsError never leaks recipient or token", () => {
  const addr = "5551234567@vtext.example.test";
  const token = "tok".padEnd(43, "Q");
  const cases = [
    `Email failed: You can only send testing emails to your own email address (${addr}). To send to others, verify a domain`,
    `Email failed: Invalid \`to\` field: ${addr}.`,
    `Email failed: The to address "${addr}" is not valid`,
    `Email failed: to=<${addr}>; body https://app.example.test/queue/${token}`,
    `Email failed: 5551234567+x@vtext.example.test rejected`,
    `fetch failed for https://api.resend.com/emails with ${token}`,
  ];
  it("strips addresses, urls, and 24+ char token-like runs", () => {
    for (const c of cases) {
      const out = sanitizeSmsError(new Error(c));
      expect(out, c).not.toContain("5551234567");
      expect(out, c).not.toContain("@");
      expect(out, c).not.toContain(token);
      expect(out, c).not.toMatch(/https?:/);
    }
  });
  it("a bare phone-number-only string (no @) is not recognized but also isn't an address leak path", () => {
    // Documented limitation: a provider echoing digits alone is not stripped.
    expect(sanitizeSmsError(new Error("bad number 5551234567"))).toContain("5551234567");
  });
});

describe("sendReviewSms privacy / no-throw", () => {
  it("returns failure (no throw) when the sender throws synchronously with the address in the message", async () => {
    const res = await sendReviewSms({
      address: "5551234567@vtext.example.test",
      baseUrl: "https://app.example.test",
      token: "T".repeat(43),
      kind: "initial",
      count: 2,
      sender: {
        send: () => {
          throw new Error("boom 5551234567@vtext.example.test");
        },
      },
    });
    expect(res).toEqual({ ok: false, error: "The text could not be sent." });
  });
  it("localhost base in production is rejected upstream (null baseUrl => failure, no send)", async () => {
    const send = vi.fn();
    const res = await sendReviewSms({
      address: "5551234567@vtext.example.test",
      baseUrl: null,
      token: "T".repeat(43),
      kind: "initial",
      sender: { send },
    });
    expect(res.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it("gateway env: unset/blank/garbage -> null; comma-joined multi-recipient is rejected", () => {
    expect(getAssigneeSmsAddress({})).toBeNull();
    expect(getAssigneeSmsAddress({ EVA_SMS_GATEWAY_ADDRESS: "   " })).toBeNull();
    expect(getAssigneeSmsAddress({ EVA_SMS_GATEWAY_ADDRESS: "a@b.test, c@d.test" })).toBeNull();
    expect(getAssigneeSmsAddress({ EVA_SMS_GATEWAY_ADDRESS: "a@b.test;c@d.test" })).toBeNull();
    expect(getAssigneeSmsAddress({ EVA_SMS_GATEWAY_ADDRESS: "Eva <a@b.test>" })).toBeNull();
  });
});

// ── Sentry scrub robustness ──────────────────────────────────────────────────
describe("scrubQueueTokensFromEvent robustness", () => {
  const TOKEN = "Zk3_-Ab9".repeat(5) + "xyz";
  it("handles null / undefined / primitives / empty objects without throwing", () => {
    expect(scrubQueueTokensFromEvent(null)).toBeNull();
    expect(scrubQueueTokensFromEvent(undefined)).toBeUndefined();
    expect(scrubQueueTokensFromEvent("str")).toBe("str");
    expect(scrubQueueTokensFromEvent({})).toEqual({});
    expect(scrubQueueTokensFromEvent({ request: null, breadcrumbs: undefined, spans: [null, 1, "x"] })).toBeTruthy();
  });
  it("a frozen event does not throw (best effort)", () => {
    const frozen = Object.freeze({ request: Object.freeze({ url: `/queue/${TOKEN}` }) });
    expect(() => scrubQueueTokensFromEvent(frozen)).not.toThrow();
  });
  it("scrubs Next data-route style paths and token followed by a file extension / query", () => {
    const e = {
      transaction: `GET /_next/data/build/queue/${TOKEN}.json`,
      request: { url: `https://x.test/queue/${TOKEN}?a=1#h` },
      spans: [{ description: `GET https://x.test/queue/${TOKEN}`, data: { "url.full": `https://x.test/queue/${TOKEN}` } }],
      breadcrumbs: { values: [{ data: { to: `/queue/${TOKEN}`, from: `/queue/${TOKEN}` } }] },
    };
    scrubQueueTokensFromEvent(e);
    expect(JSON.stringify(e)).not.toContain(TOKEN);
    expect(JSON.stringify(e)).not.toContain(TOKEN.slice(0, 22));
  });
  it("does not mangle similarly-named non-token paths", () => {
    const e = { a: "/queueing/abcdefghijklmnopqrstuvwxyz", b: "/queue/short", c: "/queue" };
    scrubQueueTokensFromEvent(e);
    expect(e).toEqual({ a: "/queueing/abcdefghijklmnopqrstuvwxyz", b: "/queue/short", c: "/queue" });
  });
  it("[known gap] a percent-encoded path is not scrubbed", () => {
    const e = { u: `/login?callbackUrl=%2Fqueue%2F${TOKEN}` };
    scrubQueueTokensFromEvent(e);
    // Informational: documents that encoded form is out of scope (no code path
    // produces it today: /queue is public and never bounces to /login).
    expect(typeof e.u).toBe("string");
  });
});
