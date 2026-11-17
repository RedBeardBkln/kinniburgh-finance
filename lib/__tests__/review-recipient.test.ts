import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// The review-text recipient resolver, the sendReviewSms addressError passthrough, and both send paths (initial / resend and the
// reminder cron) on the twilio channel. Mocked at the db / server-helper / sender boundaries; nothing is ever sent.

const mockDb = vi.hoisted(() => ({
  reviewBatch: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  transactionAssignment: { count: vi.fn() },
  smsConsentEvent: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const server = vi.hoisted(() => ({ loadQueueItems: vi.fn(), mintReminderToken: vi.fn() }));
vi.mock("@/lib/review-queue-server", () => server);

import { resolveReviewRecipient } from "@/lib/review-recipient-server";
import {
  SMS_CONSENT_READ_ERROR,
  SMS_NO_CONSENT_ERROR,
  SMS_TABLE_MISSING_ERROR,
  readSendableNumber,
  type SendableNumber,
} from "@/lib/sms-consent-store";
import { SMS_NOT_CONFIGURED_ERROR, resolveDeliveryAddress, sendReviewSms, type SmsSender } from "@/lib/sms-sender";
import { sendBatchText } from "@/lib/review-sms-server";
import { runReviewReminders } from "@/lib/review-reminder-runner";
import { SMS_CONSENT_SHA256 } from "@/lib/sms-consent";
import { SMS_CONSENT_VERSION } from "@/lib/sms-consent-text";

const E164 = "+12025550123";
const EMAIL = "eva@example.test";
const GATEWAY = "5550100@txt.example-carrier.test";
const TWILIO = { REVIEW_DELIVERY: "twilio" };
const TOKEN = "T".repeat(43);
const HOUR = 3600_000;
const NOW = new Date("2026-07-15T15:00:00Z"); // 11:00 EDT, inside the reminder window

const missingTable = () => new Prisma.PrismaClientKnownRequestError("table does not exist", { code: "P2021", clientVersion: "x" });

function consentRow(seq: number, kind: string, phoneE164 = E164) {
  return { seq, kind, phoneE164, wordingVersion: SMS_CONSENT_VERSION, wordingSha256: SMS_CONSENT_SHA256, createdAt: new Date(NOW) };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveReviewRecipient", () => {
  const ok = (): Promise<SendableNumber> => Promise.resolve({ ok: true, phoneE164: E164 });

  it("twilio + current consent -> the stored E.164 number", async () => {
    const reader = vi.fn(ok);
    expect(await resolveReviewRecipient({ id: "u-eva", email: EMAIL }, TWILIO, { readSendableNumber: reader })).toEqual({ address: E164 });
    expect(reader).toHaveBeenCalledWith("u-eva");
  });

  it.each([SMS_NO_CONSENT_ERROR, SMS_TABLE_MISSING_ERROR, SMS_CONSENT_READ_ERROR])(
    "twilio + %s -> no address, that reason, and no email / gateway fallback",
    async (error) => {
      const env = { ...TWILIO, EVA_SMS_GATEWAY_ADDRESS: GATEWAY };
      const r = await resolveReviewRecipient({ id: "u-eva", email: EMAIL }, env, {
        readSendableNumber: async () => ({ ok: false, error }),
      });
      expect(r).toEqual({ address: null, addressError: error });
    }
  );

  it("never throws: a throwing reader is the read error", async () => {
    const r = await resolveReviewRecipient({ id: "u-eva", email: EMAIL }, TWILIO, {
      readSendableNumber: async () => {
        throw new Error(`boom ${E164}`);
      },
    });
    expect(r).toEqual({ address: null, addressError: SMS_CONSENT_READ_ERROR });
  });

  it("twilio with no assignee id refuses without reading", async () => {
    const reader = vi.fn(ok);
    expect(await resolveReviewRecipient({ id: undefined, email: EMAIL }, TWILIO, { readSendableNumber: reader })).toEqual({
      address: null,
      addressError: SMS_CONSENT_READ_ERROR,
    });
    expect(reader).not.toHaveBeenCalled();
  });

  it("email and sms channels return exactly what resolveDeliveryAddress returns and never read consent", async () => {
    const reader = vi.fn(ok);
    const envs = [{}, { REVIEW_DELIVERY: "email" }, { REVIEW_DELIVERY: "sms", EVA_SMS_GATEWAY_ADDRESS: GATEWAY }, { REVIEW_DELIVERY: "sms" }];
    for (const env of envs) {
      for (const email of [EMAIL, null, "not-an-email"]) {
        expect(await resolveReviewRecipient({ id: "u-eva", email }, env, { readSendableNumber: reader })).toEqual({
          address: resolveDeliveryAddress(email, env),
        });
      }
    }
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("readSendableNumber (fail closed)", () => {
  it("consent on -> the number", async () => {
    mockDb.smsConsentEvent.findMany.mockResolvedValue([consentRow(1, "consented")]);
    expect(await readSendableNumber("u-eva")).toEqual({ ok: true, phoneE164: E164 });
    expect(mockDb.smsConsentEvent.findMany.mock.calls[0]![0].where).toEqual({ userId: "u-eva" });
  });

  it("no rows / withdrawn / unknown kind / bad stored number -> no consent", async () => {
    for (const rows of [
      [],
      [consentRow(1, "consented"), consentRow(2, "withdrawn")],
      [consentRow(1, "paused")],
      [consentRow(1, "consented", "+10005550123")],
      [consentRow(1, "consented", "2025550123")],
    ]) {
      mockDb.smsConsentEvent.findMany.mockResolvedValueOnce(rows);
      expect(await readSendableNumber("u-eva")).toEqual({ ok: false, error: SMS_NO_CONSENT_ERROR });
    }
  });

  it("missing table -> not set up; any other error -> read error; the error text is never logged", async () => {
    mockDb.smsConsentEvent.findMany.mockRejectedValueOnce(missingTable());
    expect(await readSendableNumber("u-eva")).toEqual({ ok: false, error: SMS_TABLE_MISSING_ERROR });
    mockDb.smsConsentEvent.findMany.mockRejectedValueOnce(new Error(`connection lost ${E164}`));
    expect(await readSendableNumber("u-eva")).toEqual({ ok: false, error: SMS_CONSENT_READ_ERROR });
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(logged).not.toContain("2025550123");
  });
});

describe("sendReviewSms addressError", () => {
  it("returns the given reason without calling the sender", async () => {
    const send = vi.fn<SmsSender["send"]>();
    const res = await sendReviewSms({
      address: null,
      addressError: SMS_NO_CONSENT_ERROR,
      baseUrl: "https://finance.example.test",
      token: TOKEN,
      kind: "initial",
      sender: { send },
    });
    expect(res).toEqual({ ok: false, error: SMS_NO_CONSENT_ERROR });
    expect(send).not.toHaveBeenCalled();
  });

  it("without addressError it is still the old not-configured message", async () => {
    const send = vi.fn<SmsSender["send"]>();
    const res = await sendReviewSms({ address: null, baseUrl: "https://x.test", token: TOKEN, kind: "initial", sender: { send } });
    expect(res).toEqual({ ok: false, error: SMS_NOT_CONFIGURED_ERROR });
  });
});

describe("both send paths on the twilio channel", () => {
  beforeEach(() => {
    vi.stubEnv("REVIEW_DELIVERY", "twilio");
    vi.stubEnv("NEXTAUTH_URL", "https://finance.example.test");
    vi.stubEnv("NODE_ENV", "production");
    mockDb.reviewBatch.update.mockResolvedValue({});
    mockDb.reviewBatch.updateMany.mockResolvedValue({ count: 1 });
    mockDb.transactionAssignment.count.mockResolvedValue(3);
    server.loadQueueItems.mockResolvedValue([{ transactionId: "t1" }]);
    server.mintReminderToken.mockResolvedValue({ token: TOKEN });
  });

  function batchForSend() {
    return { createdBy: { name: "Eric" }, assignee: { id: "u-eva", email: EMAIL } };
  }

  it("initial text goes to the consented number", async () => {
    mockDb.reviewBatch.findUnique.mockResolvedValue(batchForSend());
    mockDb.smsConsentEvent.findMany.mockResolvedValue([consentRow(1, "consented")]);
    const send = vi.fn<SmsSender["send"]>().mockResolvedValue({ ok: true });
    const res = await sendBatchText("b1", TOKEN, "initial", { sender: { send }, now: NOW });
    expect(res).toEqual({ ok: true });
    expect(send.mock.calls[0]![0]).toBe(E164);
    expect(mockDb.reviewBatch.findUnique.mock.calls[0]![0].select.assignee).toEqual({ select: { id: true, email: true } });
  });

  it("initial text without consent is a recorded, visible failure and nothing is sent", async () => {
    mockDb.reviewBatch.findUnique.mockResolvedValue(batchForSend());
    mockDb.smsConsentEvent.findMany.mockResolvedValue([]);
    const send = vi.fn<SmsSender["send"]>();
    const res = await sendBatchText("b1", TOKEN, "initial", { sender: { send }, now: NOW });
    expect(res).toEqual({ ok: false, error: SMS_NO_CONSENT_ERROR });
    expect(send).not.toHaveBeenCalled();
    expect(mockDb.reviewBatch.update.mock.calls[0]![0].data).toEqual({ smsStatus: "failed", smsError: SMS_NO_CONSENT_ERROR });
  });

  it("the reminder cron uses the same path: withdrawn consent records a failed reminder", async () => {
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
    mockDb.smsConsentEvent.findMany.mockResolvedValue([consentRow(1, "consented"), consentRow(2, "withdrawn")]);
    const send = vi.fn<SmsSender["send"]>();
    const summary = await runReviewReminders(NOW, { send });
    expect(summary.failed).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(mockDb.reviewBatch.update.mock.calls[0]![0].data).toEqual({ reminderStatus: "failed", reminderError: SMS_NO_CONSENT_ERROR });
    expect(mockDb.reviewBatch.findMany.mock.calls[0]![0].select.assignee).toEqual({ select: { id: true, email: true } });
  });

  it("the reminder with consent goes to the number", async () => {
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
    mockDb.smsConsentEvent.findMany.mockResolvedValue([consentRow(1, "consented")]);
    const send = vi.fn<SmsSender["send"]>().mockResolvedValue({ ok: true });
    const summary = await runReviewReminders(NOW, { send });
    expect(summary.sent).toBe(1);
    expect(send.mock.calls[0]![0]).toBe(E164);
  });
});

describe("source pins", () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

  it.each(["lib/review-sms-server.ts", "lib/review-reminder-runner.ts"])(
    "%s obtains the address through resolveReviewRecipient, never resolveDeliveryAddress directly",
    (rel) => {
      const src = read(rel);
      expect(src).toMatch(/from "@\/lib\/review-recipient-server"/);
      expect(src).toMatch(/resolveReviewRecipient\(/);
      expect(src).not.toMatch(/resolveDeliveryAddress/);
    }
  );

  it("the Twilio sender file has no console call and no database import", () => {
    const src = read("lib/twilio-sms.ts");
    expect(src).not.toMatch(/console\./);
    expect(src).not.toMatch(/@\/lib\/db/);
  });
});
