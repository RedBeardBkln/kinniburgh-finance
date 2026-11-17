import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// Tester (twilio-sms-consent): adversarial probes on top of the Coder's tests. Mocked at the db / auth / fetch boundaries;
// nothing is ever sent and no database is touched. Only fictional 555-01xx numbers; every Twilio-shaped value is built at
// runtime (never a literal that looks like a real SID or secret).

const mockDb = vi.hoisted(() => ({
  reviewBatch: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  transactionAssignment: { count: vi.fn() },
  smsConsentEvent: { findMany: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const server = vi.hoisted(() => ({ loadQueueItems: vi.fn(), mintReminderToken: vi.fn() }));
vi.mock("@/lib/review-queue-server", () => server);

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  PHONE_SSN_ERROR,
  PHONE_US_ONLY_ERROR,
  SMS_CONSENT_SHA256,
  foldConsentState,
  normalizeUsMobile,
  type ConsentEventRow,
} from "@/lib/sms-consent";
import { SMS_CONSENT_VERSION } from "@/lib/sms-consent-text";
import {
  SMS_NO_CONSENT_ERROR,
  SMS_TABLE_MISSING_ERROR,
  appendConsentEvent,
} from "@/lib/sms-consent-store";
import {
  SMS_BRAND_PREFIX,
  STOP_FOOTER,
  TWILIO_ENV_VARS,
  TWILIO_OPTED_OUT_ERROR,
  createTwilioSmsSender,
  getTwilioConfig,
  isGsm7Basic,
  withStopFooter,
  type TwilioConfig,
} from "@/lib/twilio-sms";
import { buildReviewSmsBody, type SmsSender } from "@/lib/sms-sender";
import { sendBatchText } from "@/lib/review-sms-server";
import { runReviewReminders } from "@/lib/review-reminder-runner";
import { saveSmsConsent, withdrawSmsConsent } from "@/actions/sms-consent";

const E164 = "+12025550123";
const DIGITS = "2025550123";
const EMAIL = "eva@example.test";
const GATEWAY = "2025550199@txt.example-carrier.test";
const TOKEN = "T".repeat(43);
const HOUR = 3600_000;
const NOW = new Date("2026-07-15T15:00:00Z"); // 11:00 EDT, inside the reminder window

const hex = (c: string) => c.repeat(32);
const FAKE: TwilioConfig = {
  accountSid: "AC" + hex("a"),
  apiKeySid: "SK" + hex("b"),
  apiKeySecret: "s3cr3t".repeat(4),
  messagingServiceSid: "MG" + hex("c"),
};
const FAKE_ENV = {
  TWILIO_ACCOUNT_SID: FAKE.accountSid,
  TWILIO_API_KEY_SID: FAKE.apiKeySid,
  TWILIO_API_KEY_SECRET: FAKE.apiKeySecret,
  TWILIO_MESSAGING_SERVICE_SID: FAKE.messagingServiceSid,
};

const missingTable = () => new Prisma.PrismaClientKnownRequestError("table does not exist", { code: "P2021", clientVersion: "x" });

function row(seq: number, kind: string, phoneE164 = E164): ConsentEventRow {
  return { seq, kind, phoneE164, wordingVersion: SMS_CONSENT_VERSION, wordingSha256: SMS_CONSENT_SHA256, createdAt: new Date(NOW) };
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const consoleText = () => consoleSpies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" "))).join("\n");

// ---------------------------------------------------------------------------------------------------------------------------
const FIXED_PHONE_ERRORS = [
  "Enter your mobile number.",
  "That is too long for a phone number.",
  "Use digits only (spaces, dashes, dots, brackets and a leading +1 are fine).",
  PHONE_SSN_ERROR,
  PHONE_US_ONLY_ERROR,
  "Enter a 10-digit US mobile number.",
];
describe("phone validation edge cases", () => {
  const ACCEPT: [string, string][] = [
    ["2025550123", E164],
    ["12025550123", E164],
    ["+12025550123", E164],
    ["+1 (202) 555-0123", E164],
    ["1-202-555-0123", E164],
    ["  202 555 0123  ", E164],
    ["\t202-555-0123\n", E164], // trim removes surrounding whitespace only
    ["+1.202.555.0199", "+12025550199"],
  ];
  it.each(ACCEPT)("accepts %j", (raw, e164) => {
    expect(normalizeUsMobile(raw)).toEqual({ ok: true, e164 });
  });

  const SSN_LIKE = ["123-45-6789", "123 45 6789", "123456789", "900-12-3456", "202555012", "+123456789", "(202) 555-012"];
  it.each(SSN_LIKE)("refuses SSN-shaped / 9-digit %j with the SSN message", (raw) => {
    expect(normalizeUsMobile(raw)).toEqual({ ok: false, error: PHONE_SSN_ERROR });
  });

  const REFUSE = [
    "",
    "   ",
    "202555", // 6 digits
    "2025550", // 7 digits
    "20255501234", // 11 digits not starting 1
    "120255501234", // 12 digits
    "0012025550123", // 00 international prefix
    "+44 20 7946 0958", // UK
    "+52 55 5555 0123", // Mexico
    "+33 1 23 45 67 89",
    "+12 025550123", // +1 then 9... digits 11 starting 1 but where is it? digits=12025550123 -> accepted? see separate test
    "+1+2025550123",
    "2025550123+",
    "202-555-O123", // letter O
    "202555012a",
    "202-555-0123 x12", // extension
    "202-555-0123 ext 4",
    "tel:+12025550123",
    "２０２５５５０１２３", // full-width digits
    "٢٠٢٥٥٥٠١٢٣", // Arabic-Indic digits
    "202 555 0123", // interior NBSP
    "202​5550123", // zero-width space
    "202/555/0123",
    "202_555_0123",
    "0025550123", // area code 0
    "1025550123", // area code 1
    "2020550123", // exchange 0
    "2021550123", // exchange 1
    "1" + "0".repeat(10),
    "1".repeat(33),
    " ".repeat(10) + "2".repeat(23), // 23 digits, length after trim 23
    "(".repeat(30) + "2025550123",
    "=2025550123", // formula-injection prefix
  ];
  it.each(REFUSE.filter((r) => r !== "+12 025550123"))("refuses %j", (raw) => {
    const res = normalizeUsMobile(raw);
    expect(res.ok).toBe(false);
  });

  it("'+12 025550123' (+ then 1 then 10 digits, oddly grouped) is the same US number, by design", () => {
    // digits = 12025550123 behind a single leading '+': a US number. Documented, not a defect.
    expect(normalizeUsMobile("+12 025550123")).toEqual({ ok: true, e164: E164 });
  });

  it("every international + prefix is US-only (never a shape guess)", () => {
    for (const raw of ["+44 20 7946 0958", "+52 55 5555 0123", "+33 1 23 45 67 89", "+61 2 5550 0123"]) {
      expect(normalizeUsMobile(raw)).toEqual({ ok: false, error: PHONE_US_ONLY_ERROR });
    }
  });

  it("no error string ever echoes any digit run of the input (fuzz)", () => {
    let s = 7;
    const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const alphabet = "0123456789 +().-a# ";
    for (let i = 0; i < 5000; i++) {
      const len = 1 + Math.floor(r() * 40);
      let raw = "";
      for (let j = 0; j < len; j++) raw += alphabet[Math.floor(r() * alphabet.length)];
      const res = normalizeUsMobile(raw);
      if (res.ok) {
        expect(res.e164).toMatch(/^\+1[2-9]\d{2}[2-9]\d{6}$/);
        continue;
      }
      expect(FIXED_PHONE_ERRORS).toContain(res.error);
      const run = raw.replace(/\D/g, "");
      if (run.length >= 2) expect(res.error).not.toContain(run);
    }
  });

  it("never throws on non-string input (defensive; zod blocks it in the action)", () => {
    for (const v of [undefined, null, 2025550123, {}, []]) {
      expect(normalizeUsMobile(v as unknown as string).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("fold: highest seq wins regardless of order (fuzz)", () => {
  it("matches an oracle over random histories", () => {
    let s = 11;
    const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 2000; i++) {
      const n = Math.floor(r() * 6);
      const rows = Array.from({ length: n }, (_, k) => row(k + 1, ["consented", "withdrawn", "weird"][Math.floor(r() * 3)]!, `+1202555010${k}`));
      const shuffled = [...rows].sort(() => r() - 0.5);
      const got = foldConsentState(shuffled);
      const last = rows[rows.length - 1];
      if (!last) expect(got).toEqual({ status: "off", lastWithdrawnAt: null });
      else if (last.kind === "consented") expect(got).toMatchObject({ status: "on", phoneE164: last.phoneE164 });
      else if (last.kind === "withdrawn") expect(got.status).toBe("off");
      else expect(got).toEqual({ status: "unknown" });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("Twilio error bodies never leak", () => {
  const SECRETS = () => [DIGITS, "555-0123", "http", FAKE.accountSid, FAKE.apiKeySid, FAKE.apiKeySecret, FAKE.messagingServiceSid, TOKEN, "@", "queue/", "SM" + hex("d")];

  function jsonRes(status: number, body: unknown): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }
  const leakyMessage = `To ${E164} (${DIGITS}) at https://api.twilio.com/2010-04-01/Accounts/${FAKE.accountSid}/Messages.json key ${FAKE.apiKeySid}:${FAKE.apiKeySecret} body https://x.test/queue/${TOKEN} user ${EMAIL} sid SM${hex("d")}`;

  const CASES: [string, Response | (() => Promise<Response>)][] = [
    ["21610 with leaky message", jsonRes(400, { code: 21610, message: leakyMessage, more_info: "https://www.twilio.com/docs/errors/21610", status: 400 })],
    ["21211 leaky", jsonRes(400, { code: 21211, message: leakyMessage })],
    ["21614 leaky", jsonRes(400, { code: 21614, message: leakyMessage })],
    ["20003 leaky", jsonRes(401, { code: 20003, message: leakyMessage })],
    ["30007 unknown code", jsonRes(400, { code: 30007, message: leakyMessage })],
    ["code as string", jsonRes(400, { code: "21610", message: leakyMessage })],
    ["code as float", jsonRes(400, { code: 21610.5, message: leakyMessage })],
    ["code as phone-like huge number", jsonRes(400, { code: 12025550123, message: leakyMessage })],
    ["code negative", jsonRes(400, { code: -1, message: leakyMessage })],
    ["array body", jsonRes(400, [leakyMessage])],
    ["null body", jsonRes(500, "null")],
    ["plain text body", new Response(leakyMessage, { status: 500 })],
    ["html body", new Response(`<html>${leakyMessage}</html>`, { status: 502 })],
    ["empty body", new Response("", { status: 503 })],
    ["429", jsonRes(429, { code: 20429, message: leakyMessage })],
  ];

  it.each(CASES)("%s -> fixed text with nothing sensitive", async (_name, res) => {
    const fetchFn = vi.fn(async () => (typeof res === "function" ? res() : res));
    const out = await createTwilioSmsSender(FAKE, fetchFn).send(E164, `Eric has 3 transactions for you to tag: https://x.test/queue/${TOKEN}`);
    expect(out.ok).toBe(false);
    const err = out.ok ? "" : out.error;
    for (const bad of SECRETS()) expect(err.toLowerCase()).not.toContain(bad.toLowerCase());
    expect(consoleText()).toBe("");
  });

  it("21610 is exactly the opted-out sentence, and a string or float code is NOT treated as 21610", async () => {
    const send = (body: unknown) => createTwilioSmsSender(FAKE, async () => jsonRes(400, body)).send(E164, "x");
    expect(await send({ code: 21610 })).toEqual({ ok: false, error: TWILIO_OPTED_OUT_ERROR });
    expect(await send({ code: "21610" })).toEqual({ ok: false, error: "Twilio refused the message (status 400)." });
    expect(await send({ code: 21610.5 })).toEqual({ ok: false, error: "Twilio refused the message (status 400)." });
  });

  it("a fetch that rejects with a leaky Error (incl. the URL) or a non-Error, or hangs until abort -> fixed message", async () => {
    const throwers: (() => Promise<Response>)[] = [
      async () => { throw new Error(leakyMessage); },
      async () => { throw leakyMessage; },
      async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError", cause: leakyMessage }); },
      async () => { throw new DOMException("The operation was aborted.", "AbortError"); },
    ];
    for (const t of throwers) {
      const out = await createTwilioSmsSender(FAKE, t).send(E164, "x");
      expect(out).toEqual({ ok: false, error: "Twilio could not be reached, so no text was sent." });
    }
    expect(consoleText()).toBe("");
  });

  it("a res.json() that throws mid-body (stream error) still never throws out of send", async () => {
    const res = jsonRes(400, { code: 21610 });
    Object.defineProperty(res, "json", { value: async () => { throw new Error(leakyMessage); } });
    const out = await createTwilioSmsSender(FAKE, async () => res).send(E164, "x");
    expect(out).toEqual({ ok: false, error: "Twilio refused the message (status 400)." });
  });

  it("the recipient re-check refuses non-US / malformed numbers without fetch", async () => {
    const fetchFn = vi.fn();
    const sender = createTwilioSmsSender(FAKE, fetchFn);
    for (const to of ["", DIGITS, "12025550123", "+442079460958", "+1202555012", "+120255501234", "+11025550123", "+12020550123", " +12025550123", EMAIL]) {
      const out = await sender.send(to, "x");
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).not.toMatch(/\d{4}/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("end-to-end: a 21610 through sendBatchText (real env-built sender, stubbed global fetch) records exactly the opted-out sentence", async () => {
    vi.stubEnv("REVIEW_DELIVERY", "twilio");
    vi.stubEnv("NEXTAUTH_URL", "https://finance.example.test");
    vi.stubEnv("NODE_ENV", "production");
    for (const [k, v] of Object.entries(FAKE_ENV)) vi.stubEnv(k, v);
    const fetchSpy = vi.fn(async () => jsonRes(400, { code: 21610, message: leakyMessage }));
    vi.stubGlobal("fetch", fetchSpy);
    mockDb.reviewBatch.findUnique.mockResolvedValue({ createdBy: { name: "Eric" }, assignee: { id: "u-eva", email: EMAIL } });
    mockDb.transactionAssignment.count.mockResolvedValue(3);
    mockDb.smsConsentEvent.findMany.mockResolvedValue([row(1, "consented")]);
    mockDb.reviewBatch.update.mockResolvedValue({});
    const res = await sendBatchText("b1", TOKEN, "initial", { now: NOW });
    expect(res).toEqual({ ok: false, error: TWILIO_OPTED_OUT_ERROR });
    expect(mockDb.reviewBatch.update.mock.calls[0]![0].data).toEqual({ smsStatus: "failed", smsError: TWILIO_OPTED_OUT_ERROR });
    // The request really went out with the consented number and a footer inside one segment.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${FAKE.accountSid}/Messages.json`);
    const form = new URLSearchParams(String(init.body));
    expect([...form.keys()].sort()).toEqual(["Body", "MessagingServiceSid", "To"]);
    expect(form.get("To")).toBe(E164);
    expect(form.get("Body")!.endsWith(STOP_FOOTER)).toBe(true);
    expect(form.get("Body")!.length).toBeLessThanOrEqual(160);
    // Consent was read for the ASSIGNEE, never the creator.
    expect(mockDb.smsConsentEvent.findMany.mock.calls[0]![0].where).toEqual({ userId: "u-eva" });
    expect(consoleText()).not.toContain(DIGITS);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("no-consent / withdrawn refusal on both send paths, with every fallback available", () => {
  beforeEach(() => {
    vi.stubEnv("REVIEW_DELIVERY", "twilio");
    vi.stubEnv("EVA_SMS_GATEWAY_ADDRESS", GATEWAY); // present on purpose: must never be used
    vi.stubEnv("NEXTAUTH_URL", "https://finance.example.test");
    vi.stubEnv("NODE_ENV", "production");
    for (const [k, v] of Object.entries(FAKE_ENV)) vi.stubEnv(k, v);
    mockDb.reviewBatch.update.mockResolvedValue({});
    mockDb.reviewBatch.updateMany.mockResolvedValue({ count: 1 });
    mockDb.transactionAssignment.count.mockResolvedValue(2);
    server.loadQueueItems.mockResolvedValue([{ transactionId: "t1" }]);
    server.mintReminderToken.mockResolvedValue({ token: TOKEN });
  });

  const HISTORIES: [string, () => void, string][] = [
    ["no rows", () => mockDb.smsConsentEvent.findMany.mockResolvedValue([]), SMS_NO_CONSENT_ERROR],
    ["withdrawn", () => mockDb.smsConsentEvent.findMany.mockResolvedValue([row(1, "consented"), row(2, "withdrawn")]), SMS_NO_CONSENT_ERROR],
    ["withdrawn (rows out of order)", () => mockDb.smsConsentEvent.findMany.mockResolvedValue([row(2, "withdrawn"), row(1, "consented")]), SMS_NO_CONSENT_ERROR],
    ["unknown kind on latest", () => mockDb.smsConsentEvent.findMany.mockResolvedValue([row(1, "consented"), row(2, "paused")]), SMS_NO_CONSENT_ERROR],
    ["stored number not E.164", () => mockDb.smsConsentEvent.findMany.mockResolvedValue([row(1, "consented", DIGITS)]), SMS_NO_CONSENT_ERROR],
    ["stored number non-US", () => mockDb.smsConsentEvent.findMany.mockResolvedValue([row(1, "consented", "+442079460958")]), SMS_NO_CONSENT_ERROR],
    ["table missing", () => mockDb.smsConsentEvent.findMany.mockRejectedValue(missingTable()), SMS_TABLE_MISSING_ERROR],
  ];

  it.each(HISTORIES)("initial + resend: %s -> recorded failure, no fetch, no fallback", async (_n, setup, err) => {
    setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    mockDb.reviewBatch.findUnique.mockResolvedValue({ createdBy: { name: "Eric" }, assignee: { id: "u-eva", email: EMAIL } });
    for (const kind of ["initial", "resend"] as const) {
      mockDb.reviewBatch.update.mockClear();
      const res = await sendBatchText("b1", TOKEN, kind, { now: NOW }); // real env-built sender
      expect(res).toEqual({ ok: false, error: err });
      expect(mockDb.reviewBatch.update.mock.calls[0]![0].data).toEqual({ smsStatus: "failed", smsError: err });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(HISTORIES)("reminder cron (default sender): %s -> failed reminder, no fetch", async (_n, setup, err) => {
    setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    mockDb.reviewBatch.findMany.mockResolvedValue([
      {
        id: "b1",
        status: "submitted",
        firstOpenedAt: null,
        smsStatus: "sent",
        smsSentAt: new Date(NOW.getTime() - 30 * HOUR),
        reminderStatus: null,
        expiresAt: new Date(NOW.getTime() + 5 * 24 * HOUR),
        createdBy: { name: "Eric" },
        assignee: { id: "u-eva", email: EMAIL },
      },
    ]);
    const summary = await runReviewReminders(NOW);
    expect(summary).toMatchObject({ failed: 1, sent: 0 });
    expect(mockDb.reviewBatch.update.mock.calls[0]![0].data).toEqual({ reminderStatus: "failed", reminderError: err });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-consent with a NEW number after a withdrawal texts the new number only", async () => {
    mockDb.smsConsentEvent.findMany.mockResolvedValue([row(1, "consented"), row(2, "withdrawn"), row(3, "consented", "+12025550188")]);
    mockDb.reviewBatch.findUnique.mockResolvedValue({ createdBy: { name: "Eric" }, assignee: { id: "u-eva", email: EMAIL } });
    const send = vi.fn<SmsSender["send"]>().mockResolvedValue({ ok: true });
    await sendBatchText("b1", TOKEN, "initial", { sender: { send }, now: NOW });
    expect(send.mock.calls.map((c) => c[0])).toEqual(["+12025550188"]);
  });

  it("twilio selected but Twilio unconfigured, consent ON: each missing variable is named and recorded, no fetch", async () => {
    mockDb.smsConsentEvent.findMany.mockResolvedValue([row(1, "consented")]);
    mockDb.reviewBatch.findUnique.mockResolvedValue({ createdBy: { name: "Eric" }, assignee: { id: "u-eva", email: EMAIL } });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const name of TWILIO_ENV_VARS) {
      for (const [k, v] of Object.entries(FAKE_ENV)) vi.stubEnv(k, v);
      vi.stubEnv(name, "");
      mockDb.reviewBatch.update.mockClear();
      const res = await sendBatchText("b1", TOKEN, "initial", { now: NOW });
      expect(res.ok).toBe(false);
      const err = res.ok ? "" : res.error;
      expect(err).toContain(name);
      for (const other of TWILIO_ENV_VARS.filter((n) => n !== name)) expect(err).not.toContain(other);
      expect(mockDb.reviewBatch.update.mock.calls[0]![0].data).toEqual({ smsStatus: "failed", smsError: err });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("env pre-flight per variable", () => {
  const MALFORMED: Record<(typeof TWILIO_ENV_VARS)[number], string[]> = {
    TWILIO_ACCOUNT_SID: ["ac" + hex("a"), "AC" + "a".repeat(31), "AC" + "a".repeat(33), "AC" + "g".repeat(32), "MG" + hex("a"), "AC " + hex("a"), "   "],
    TWILIO_API_KEY_SID: ["sk" + hex("b"), "SK" + "b".repeat(31), "AC" + hex("b"), "SK" + "z".repeat(32), "   "],
    TWILIO_API_KEY_SECRET: ["short", "a".repeat(15), "a".repeat(129), "has space inside 123", "tab\tinside1234567", "é".repeat(20), "   "],
    TWILIO_MESSAGING_SERVICE_SID: ["mg" + hex("c"), "MG" + "c".repeat(31), "PN" + hex("c"), "   "],
  };
  for (const name of TWILIO_ENV_VARS) {
    it(`${name}: missing or malformed is refused, named, and its value never echoed`, () => {
      const rest = Object.fromEntries(Object.entries(FAKE_ENV).filter(([k]) => k !== name));
      const missing = getTwilioConfig(rest);
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.error).toContain(name);
        for (const v of Object.values(rest)) expect(missing.error).not.toContain(v);
      }
      for (const bad of MALFORMED[name]) {
        const r = getTwilioConfig({ ...FAKE_ENV, [name]: bad });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error).toContain(name);
          if (bad.trim().length > 0) expect(r.error).not.toContain(bad.trim());
          for (const v of Object.values(FAKE_ENV)) expect(r.error).not.toContain(v);
        }
      }
    });
  }
  it("all four missing names all four; surrounding whitespace on a good value is accepted", () => {
    const r = getTwilioConfig({});
    expect(r.ok).toBe(false);
    if (!r.ok) for (const n of TWILIO_ENV_VARS) expect(r.error).toContain(n);
    expect(getTwilioConfig(Object.fromEntries(Object.entries(FAKE_ENV).map(([k, v]) => [k, `  ${v}\n`]))).ok).toBe(true);
  });
  it("the Basic auth header carries the trimmed key SID:secret", async () => {
    const cfg = getTwilioConfig(Object.fromEntries(Object.entries(FAKE_ENV).map(([k, v]) => [k, ` ${v} `])));
    if (!cfg.ok) throw new Error("expected ok");
    const fetchFn = vi.fn(async () => new Response("{}", { status: 201 }));
    await createTwilioSmsSender(cfg.config, fetchFn).send(E164, "x");
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Basic " + Buffer.from(`${FAKE.apiKeySid}:${FAKE.apiKeySecret}`).toString("base64"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("STOP footer: one GSM-7 segment, never UCS-2", () => {
  const HOSTS = ["https://kinniburgh-finance.vercel.app", "https://ericandeva.com", "https://finance.example.test", "https://a-very-long-preview-host-name-for-testing-0123456789.vercel.app"];
  const NAMES = ["Eric", "José", "Zoë", "Łukasz", "Søren", "Ñandú", "François", "李", "O'Brien", "Eric😀", "Anne-Marie", "", "Ab".repeat(30)];

  it("property: every real body either gets the footer within 160 GSM-7 chars, or is sent unchanged", () => {
    for (const host of HOSTS)
      for (const name of NAMES)
        for (const kind of ["initial", "reminder", "resend"] as const)
          for (const count of [undefined, 0, 1, 9, 99, 1234]) {
            const body = buildReviewSmsBody({ kind, url: `${host}/queue/${TOKEN}`, count, senderName: name });
            const out = withStopFooter(body);
            if (out === body) {
              expect(isGsm7Basic(body + STOP_FOOTER) && (body + STOP_FOOTER).length <= 160).toBe(false);
            } else {
              expect(out).toBe(body + STOP_FOOTER);
              expect(out.length).toBeLessThanOrEqual(160);
              expect(isGsm7Basic(out)).toBe(true);
            }
          }
  });

  it("non-GSM letters in a sender name drop the footer (never turns the text into UCS-2); GSM-basic accents keep it", () => {
    const url = `https://ericandeva.com/queue/${TOKEN}`;
    const b = (n: string) => buildReviewSmsBody({ kind: "initial", url, count: 3, senderName: n });
    expect(withStopFooter(b("José")).endsWith(STOP_FOOTER)).toBe(true); // é is GSM basic
    expect(withStopFooter(b("Søren")).endsWith(STOP_FOOTER)).toBe(true); // ø is GSM basic
    for (const n of ["Zoë", "Łukasz", "François", "李"]) expect(withStopFooter(b(n))).toBe(b(n));
  });

  it("realistic worst case: the reminder on the 37-char vercel host gets the footer (158 chars)", () => {
    const body = buildReviewSmsBody({ kind: "reminder", url: `https://kinniburgh-finance.vercel.app/queue/${TOKEN}`, senderName: "Eric" });
    const out = withStopFooter(body);
    expect(out.endsWith(STOP_FOOTER)).toBe(true);
    expect(out.length).toBe(158);
  });

  it("boundary on a single char: GSM basic vs extension vs surrogate pair at exactly 160", () => {
    const base = "a".repeat(160 - STOP_FOOTER.length - 1);
    expect(withStopFooter(base + "b")).toBe(base + "b" + STOP_FOOTER);
    expect(withStopFooter(base + "bb")).toBe(base + "bb");
    for (const ext of ["[", "]", "{", "}", "\\", "^", "~", "|", "€", "\u001b"]) expect(withStopFooter(base + ext)).toBe(base + ext);
    expect(withStopFooter("a".repeat(130) + "😀")).toBe("a".repeat(130) + "😀");
    expect(withStopFooter("ç")).toBe("ç"); // lowercase c-cedilla is not in the basic table (conservative)
    expect(withStopFooter("")).toBe(STOP_FOOTER);
  });

  it("the body on the wire is never truncated or altered apart from the footer", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 201 }));
    const sender = createTwilioSmsSender(FAKE, fetchFn);
    // Room for the footer after the "Banana Stand: " prefix: 160 - 14 - 23 = 123.
    const bodies = ["x".repeat(123), "x".repeat(124), "x".repeat(400), "Zoë has 3", "a&b=c+d%20e\nline2"];
    for (const body of bodies) await sender.send(E164, body);
    const sent = fetchFn.mock.calls.map((c) => new URLSearchParams(String((c as unknown as [string, RequestInit])[1].body)).get("Body"));
    expect(sent).toEqual(bodies.map((b) => withStopFooter(SMS_BRAND_PREFIX + b)));
    expect(sent[0]).toBe(SMS_BRAND_PREFIX + "x".repeat(123) + STOP_FOOTER);
    expect(sent[1]).toBe(SMS_BRAND_PREFIX + "x".repeat(124));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("actions: userId never taken from client input", () => {
  function txMock() {
    const tx = {
      smsConsentEvent: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: "ev-1", seq: 1 }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    mockDb.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    return tx;
  }

  it("save ignores a smuggled userId / id / seq / kind and writes for the session user", async () => {
    authMock.mockResolvedValue({ user: { id: "u-session" } });
    const tx = txMock();
    const res = await saveSmsConsent({
      phone: "(202) 555-0123",
      agreed: true,
      wordingVersion: SMS_CONSENT_VERSION,
      userId: "u-victim",
      id: "u-victim",
      seq: 99,
      kind: "withdrawn",
    } as unknown as Parameters<typeof saveSmsConsent>[0]);
    expect(res).toMatchObject({ ok: true, status: "on", masked: "ending 0123" });
    expect(tx.smsConsentEvent.findMany.mock.calls[0]![0].where).toEqual({ userId: "u-session" });
    const data = tx.smsConsentEvent.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ userId: "u-session", seq: 1, kind: "consented", phoneE164: E164 });
    expect(JSON.stringify(mockDb.$transaction.mock.calls)).not.toContain("u-victim");
    expect(tx.auditLog.create.mock.calls[0]![0].data.changedBy).toBe("u-session");
  });

  it("withdraw ignores any arguments and writes for the session user only", async () => {
    authMock.mockResolvedValue({ user: { id: "u-session" } });
    const tx = txMock();
    tx.smsConsentEvent.findMany.mockResolvedValue([row(1, "consented")]);
    tx.smsConsentEvent.create.mockResolvedValue({ id: "ev-2", seq: 2 });
    const res = await (withdrawSmsConsent as unknown as (x: unknown) => Promise<unknown>)({ userId: "u-victim" });
    expect(res).toMatchObject({ ok: true, status: "off" });
    expect(tx.smsConsentEvent.create.mock.calls[0]![0].data).toMatchObject({ userId: "u-session", kind: "withdrawn", phoneE164: E164 });
  });

  it("no session (null, {}, user without id) -> throws before any DB call", async () => {
    for (const s of [null, {}, { user: {} }, { user: { id: "" } }]) {
      authMock.mockResolvedValue(s);
      await expect(saveSmsConsent({ phone: "2025550123", agreed: true, wordingVersion: SMS_CONSENT_VERSION })).rejects.toThrow();
      await expect(withdrawSmsConsent()).rejects.toThrow();
    }
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("agreed must be the boolean true: 'true', 1, 'on' are refused before any DB call", async () => {
    authMock.mockResolvedValue({ user: { id: "u-session" } });
    for (const agreed of ["true", 1, "on", null, undefined]) {
      const res = await saveSmsConsent({ phone: "2025550123", agreed, wordingVersion: SMS_CONSENT_VERSION } as unknown as Parameters<typeof saveSmsConsent>[0]);
      expect(res.ok).toBe(false);
    }
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    // agreed:false passes the zod shape and is refused by the plan INSIDE the transaction: nothing is created.
    const tx = txMock();
    const res = await saveSmsConsent({ phone: "2025550123", agreed: false, wordingVersion: SMS_CONSENT_VERSION });
    expect(res).toEqual({ ok: false, error: "Tick the box to agree to text messages." });
    expect(tx.smsConsentEvent.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("SSN-like input is refused before any DB call and the error never echoes it; nothing logged", async () => {
    authMock.mockResolvedValue({ user: { id: "u-session" } });
    for (const phone of ["123-45-6789", "123456789", "+44 20 7946 0958", "202-555-O123", "x".repeat(33)]) {
      const res = await saveSmsConsent({ phone, agreed: true, wordingVersion: SMS_CONSENT_VERSION });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).not.toMatch(/\d{3}/);
    }
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(consoleText()).toBe("");
  });

  it("an unexpected DB error is a fixed message and logs only the error name (no phone digits)", async () => {
    authMock.mockResolvedValue({ user: { id: "u-session" } });
    mockDb.$transaction.mockRejectedValue(new Error(`insert failed for ${E164} ${DIGITS}`));
    const res = await saveSmsConsent({ phone: "202-555-0123", agreed: true, wordingVersion: SMS_CONSENT_VERSION });
    expect(res).toEqual({ ok: false, error: "Your text-message setting could not be saved. Try again." });
    expect(consoleText()).not.toContain("555");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("AuditLog payloads carry no phone digits", () => {
  it("consent, change of number and withdrawal: the AuditLog row has ids/kind/seq/version only", async () => {
    const audits: unknown[] = [];
    const rows: ConsentEventRow[] = [];
    const tx = {
      smsConsentEvent: {
        findMany: vi.fn(async () => [...rows]),
        create: vi.fn(async (a: { data: ConsentEventRow & { userId: string } }) => {
          rows.push({ ...a.data, createdAt: new Date(NOW) });
          return { id: `ev-${a.data.seq}`, seq: a.data.seq };
        }),
      },
      auditLog: { create: vi.fn(async (a: unknown) => { audits.push(a); return {}; }) },
    };
    mockDb.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    expect(await appendConsentEvent("u1", { action: "consent", phoneE164: E164, agreed: true, wordingVersion: SMS_CONSENT_VERSION })).toMatchObject({ written: true, seq: 1 });
    expect(await appendConsentEvent("u1", { action: "consent", phoneE164: "+12025550177", agreed: true, wordingVersion: SMS_CONSENT_VERSION })).toMatchObject({ written: true, seq: 2 });
    expect(await appendConsentEvent("u1", { action: "consent", phoneE164: "+12025550177", agreed: true, wordingVersion: SMS_CONSENT_VERSION })).toMatchObject({ written: false });
    expect(await appendConsentEvent("u1", { action: "withdraw" })).toMatchObject({ written: true, seq: 3, kind: "withdrawn" });
    expect(await appendConsentEvent("u1", { action: "withdraw" })).toMatchObject({ written: false });
    expect(rows.map((r) => [r.seq, r.kind, r.phoneE164])).toEqual([
      [1, "consented", E164],
      [2, "consented", "+12025550177"],
      [3, "withdrawn", "+12025550177"],
    ]);
    expect(audits).toHaveLength(3);
    for (const a of audits) {
      const s = JSON.stringify(a);
      expect(s).not.toMatch(/555|0123|0177|\+1\d/);
      expect(s).not.toContain(SMS_CONSENT_SHA256);
      const after = (a as { data: { after: Record<string, unknown> } }).data.after;
      expect(Object.keys(after).sort()).toEqual(["eventId", "kind", "seq", "wordingVersion"]);
    }
    expect(consoleText()).toBe("");
  });

  it("all AuditLog writes across the repo that use an sms_consent change type come only from the store", () => {
    const hits = walk(ROOT).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__") && /sms_consent/.test(readFileSync(f, "utf8")));
    expect(hits.map(rel).sort()).toEqual(["lib/sms-consent-store.ts"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, "..", "..");
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if ([".git", "node_modules", ".next", ".claude", "coverage", ".vercel", "data"].includes(name)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe("append-only store (repo-wide, raw SQL included)", () => {
  const files = () => walk(ROOT).filter((f) => /\.(ts|tsx|js|mjs|cjs|sql)$/.test(f) && !f.includes(`${path.sep}__tests__${path.sep}`));

  it("no update/delete/upsert/raw write against the consent table anywhere (incl. scripts/ and prisma/)", () => {
    const offenders: string[] = [];
    for (const f of files()) {
      const src = readFileSync(f, "utf8");
      if (/smsConsentEvent\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/.test(src)) offenders.push(rel(f));
      if (/(UPDATE|DELETE\s+FROM|TRUNCATE)\s+"?SmsConsentEvent"?/i.test(src)) offenders.push(rel(f));
      if (/\$(executeRaw|queryRaw)(Unsafe)?[\s\S]{0,200}SmsConsentEvent/.test(src)) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });

  it("the store module has no write other than create, and no raw query at all", () => {
    const src = readFileSync(path.join(ROOT, "lib/sms-consent-store.ts"), "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/\.(update|updateMany|upsert|delete|deleteMany|createMany)\s*\(/);
    expect(src).not.toMatch(/\$(executeRaw|queryRaw)/);
    expect((src.match(/\.create\s*\(/g) ?? []).length).toBe(2); // the event + the AuditLog row
  });

  it("the migration has no UPDATE / DELETE / DROP / TRUNCATE and only touches the new table", () => {
    const sql = readFileSync(path.join(ROOT, "prisma/migrations/20261116000000_sms_consent_events/migration.sql"), "utf8").replace(/--.*$/gm, "");
    const stripped = sql.replace(/ON (DELETE|UPDATE) (RESTRICT|CASCADE)/g, "");
    expect(stripped).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE|ALTER\s+TABLE\s+"(?!SmsConsentEvent"))/i);
    const tables = [...sql.matchAll(/(?:CREATE TABLE|ALTER TABLE|ON)\s+"(\w+)"/g)].map((m) => m[1]);
    expect(new Set(tables)).toEqual(new Set(["SmsConsentEvent"]));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("no real phone numbers or Twilio-shaped literals in the change", () => {
  const CHANGED = [
    "lib/sms-consent.ts",
    "lib/sms-consent-text.ts",
    "lib/sms-consent-store.ts",
    "lib/twilio-sms.ts",
    "lib/review-recipient-server.ts",
    "lib/sms-sender.ts",
    "actions/sms-consent.ts",
    "components/settings/sms-consent-card.tsx",
    "app/privacy/page.tsx",
    "app/settings/notifications/page.tsx",
    ".env.example",
    "lib/__tests__/sms-consent.test.ts",
    "lib/__tests__/twilio-sms.test.ts",
    "lib/__tests__/review-recipient.test.ts",
    "lib/__tests__/sms-consent-guard.test.ts",
    "lib/__tests__/sms-consent-card-render.test.tsx",
    "lib/__tests__/privacy-sms-section.test.tsx",
  ];
  it("every 10-digit NANP-looking number uses the 555-01xx fictional range", () => {
    const bad: string[] = [];
    for (const f of CHANGED) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      for (const m of src.matchAll(/(?<![\dA-Za-z])(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})(?![\dA-Za-z])/g)) {
        const [, , exch, line] = m;
        if (!(exch === "555" && /^01\d\d$/.test(line!))) bad.push(`${f}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("no AC/SK/MG + 32 hex literal in any changed file", () => {
    for (const f of CHANGED) expect(readFileSync(path.join(ROOT, f), "utf8")).not.toMatch(/\b(AC|SK|MG)[0-9a-fA-F]{32}\b/);
  });
});
