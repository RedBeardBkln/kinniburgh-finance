import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// Guards for the SMS consent log (twilio-sms-consent): only the store touches the table, the store is insert-only, every action
// starts with requireAuth() and takes no user id, the AuditLog payload carries no phone number, and the client-side files stay
// free of server code. Plus the store and the actions run against a mocked db / session (no database).

const tx = vi.hoisted(() => ({
  smsConsentEvent: { findMany: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
}));
const mockDb = vi.hoisted(() => ({
  smsConsentEvent: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/auth", () => authMock);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { appendConsentEvent, loadSmsConsentState, SMS_CONSENT_CONFLICT_ERROR, SMS_TABLE_MISSING_ERROR } from "@/lib/sms-consent-store";
import { saveSmsConsent, withdrawSmsConsent } from "@/actions/sms-consent";
import { SMS_CONSENT_SHA256 } from "@/lib/sms-consent";
import { SMS_CONSENT_VERSION, SMS_NOT_SET_UP_TEXT } from "@/lib/sms-consent-text";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const E164 = "+12025550123";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "__tests__") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const SOURCE_FILES = ["app", "lib", "actions", "components"].flatMap((d) => walk(path.join(ROOT, d)));
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

describe("source guards", () => {
  it("only lib/sms-consent-store.ts touches the smsConsentEvent model", () => {
    const touching = SOURCE_FILES.filter((f) => /smsConsentEvent/.test(readFileSync(f, "utf8"))).map(rel);
    expect(touching).toEqual(["lib/sms-consent-store.ts"]);
  });

  it("the store is insert-only", () => {
    const src = read("lib/sms-consent-store.ts");
    expect(src).not.toMatch(/\.(update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(src).not.toMatch(/\$executeRaw|\$queryRaw|\$executeRawUnsafe/);
    expect(src).toMatch(/smsConsentEvent\.create\(/);
  });

  it("no file anywhere updates or deletes a consent row", () => {
    const all = [...SOURCE_FILES, ...walk(path.join(ROOT, "scripts")), ...walk(path.join(ROOT, "prisma"))];
    for (const f of all) {
      expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/smsConsentEvent\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/);
    }
  });

  it("every action export starts with requireAuth(), requireAuth is not exported, and no export takes a user id", () => {
    const src = read("actions/sms-consent.ts");
    expect(src.startsWith('"use server";')).toBe(true);
    const exportedFns = [...src.matchAll(/export async function (\w+)\(([^)]*)\)[^{]*\{\s*([^\n]*)/g)];
    expect(exportedFns.map((m) => m[1]).sort()).toEqual(["saveSmsConsent", "withdrawSmsConsent"]);
    for (const m of exportedFns) {
      expect(m[3]!.trim(), m[1]).toMatch(/^(const user = )?await requireAuth\(\);$/);
      expect(m[2], m[1]).not.toMatch(/userId/i);
    }
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+requireAuth/);
    expect(src).not.toMatch(/export\s+(const|let|var)\s/);
    expect(src).not.toMatch(/console\.log/);
    // console.error only with a static tag and the error's name.
    for (const m of src.matchAll(/console\.\w+\(([^\n]*)\)/g)) expect(m[1]).toMatch(/^"[^"]*", e instanceof Error \? e\.name : "unknown error"$/);
  });

  it("the client-safe wording file imports nothing", () => {
    expect(read("lib/sms-consent-text.ts")).not.toMatch(/^\s*import\s/m);
  });

  it("the card is a client component that imports no server code", () => {
    const src = read("components/settings/sms-consent-card.tsx");
    expect(src.startsWith('"use client";')).toBe(true);
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const i of imports) {
      expect(i).not.toMatch(/^@\/actions\//);
      expect(i).not.toBe("@/lib/sms-consent-store");
      expect(i).not.toBe("@/lib/sms-consent");
      expect(i).not.toBe("@/lib/db");
      expect(i).not.toMatch(/^node:/);
    }
  });

  it("the migration only creates the new table, its indexes and its FK", () => {
    const sql = read("prisma/migrations/20261116000000_sms_consent_events/migration.sql")
      .split("\n")
      .filter((l) => !l.startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\bDROP\b/i);
    const alters = [...sql.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(alters).toEqual(["SmsConsentEvent"]);
    expect([...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])).toEqual(["SmsConsentEvent"]);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "SmsConsentEvent_userId_seq_key"/);
    expect(sql).toMatch(/CREATE INDEX "SmsConsentEvent_userId_createdAt_idx"/);
    expect(sql).toMatch(/ON DELETE RESTRICT/);
  });
});

function storedRow(seq: number, kind: string) {
  return { seq, kind, phoneE164: E164, wordingVersion: SMS_CONSENT_VERSION, wordingSha256: SMS_CONSENT_SHA256, createdAt: new Date() };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockDb.$transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));
  tx.smsConsentEvent.create.mockResolvedValue({ id: "evt-9", seq: 1 });
  tx.auditLog.create.mockResolvedValue({});
});

describe("store", () => {
  it("consent writes one event (seq max+1) and one AuditLog row with ids, kind, seq and version only", async () => {
    tx.smsConsentEvent.findMany.mockResolvedValue([storedRow(1, "consented"), storedRow(2, "withdrawn")]);
    tx.smsConsentEvent.create.mockResolvedValue({ id: "evt-3", seq: 3 });
    const res = await appendConsentEvent("u-1", { action: "consent", phoneE164: E164, agreed: true, wordingVersion: SMS_CONSENT_VERSION });
    expect(res).toEqual({ ok: true, written: true, kind: "consented", seq: 3 });
    expect(tx.smsConsentEvent.create.mock.calls[0]![0].data).toEqual({
      userId: "u-1",
      seq: 3,
      kind: "consented",
      phoneE164: E164,
      wordingVersion: SMS_CONSENT_VERSION,
      wordingSha256: SMS_CONSENT_SHA256,
      method: "settings_web_form",
    });
    const audit = tx.auditLog.create.mock.calls[0]![0].data;
    expect(audit.changedBy).toBe("u-1");
    expect(audit.changeType).toBe("sms_consent");
    expect(audit.after).toEqual({ eventId: "evt-3", kind: "consented", seq: 3, wordingVersion: SMS_CONSENT_VERSION });
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain("2025550123");
  });

  it("withdraw audits as sms_consent_withdrawn without the number", async () => {
    tx.smsConsentEvent.findMany.mockResolvedValue([storedRow(1, "consented")]);
    tx.smsConsentEvent.create.mockResolvedValue({ id: "evt-2", seq: 2 });
    const res = await appendConsentEvent("u-1", { action: "withdraw" });
    expect(res).toEqual({ ok: true, written: true, kind: "withdrawn", seq: 2 });
    expect(tx.auditLog.create.mock.calls[0]![0].data.changeType).toBe("sms_consent_withdrawn");
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain("2025550123");
  });

  it("a no-op writes nothing", async () => {
    tx.smsConsentEvent.findMany.mockResolvedValue([]);
    const res = await appendConsentEvent("u-1", { action: "withdraw" });
    expect(res.ok && !res.written).toBe(true);
    expect(tx.smsConsentEvent.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("a racing tab (P2002) is a conflict; a missing table is table_missing", async () => {
    mockDb.$transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    expect(await appendConsentEvent("u-1", { action: "withdraw" })).toEqual({ ok: false, code: "conflict", error: SMS_CONSENT_CONFLICT_ERROR });
    mockDb.$transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("missing", { code: "P2021", clientVersion: "x" }));
    expect(await appendConsentEvent("u-1", { action: "withdraw" })).toEqual({ ok: false, code: "table_missing", error: SMS_TABLE_MISSING_ERROR });
  });

  it("loadSmsConsentState is fail-soft", async () => {
    mockDb.smsConsentEvent.findMany.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("missing", { code: "P2021", clientVersion: "x" }));
    expect(await loadSmsConsentState("u-1")).toEqual({ state: "table_missing" });
    mockDb.smsConsentEvent.findMany.mockRejectedValueOnce(new Error("down"));
    expect(await loadSmsConsentState("u-1")).toEqual({ state: "error" });
    mockDb.smsConsentEvent.findMany.mockResolvedValueOnce([storedRow(1, "consented")]);
    const ok = await loadSmsConsentState("u-1");
    expect(ok.state === "ok" && ok.consent.status).toBe("on");
  });
});

describe("actions", () => {
  it("refuse without a session before touching the database", async () => {
    authMock.auth.mockResolvedValue(null);
    await expect(saveSmsConsent({ phone: "202-555-0123", agreed: true, wordingVersion: SMS_CONSENT_VERSION })).rejects.toThrow("Unauthorized");
    await expect(withdrawSmsConsent()).rejects.toThrow("Unauthorized");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("write for the session's user only, and return a masked number", async () => {
    authMock.auth.mockResolvedValue({ user: { id: "u-session" } });
    tx.smsConsentEvent.findMany.mockResolvedValue([]);
    const res = await saveSmsConsent({ phone: "(202) 555-0123", agreed: true, wordingVersion: SMS_CONSENT_VERSION });
    expect(res).toEqual({ ok: true, status: "on", masked: "ending 0123", message: "Texts are on." });
    expect(tx.smsConsentEvent.findMany.mock.calls[0]![0].where).toEqual({ userId: "u-session" });
    expect(tx.smsConsentEvent.create.mock.calls[0]![0].data.userId).toBe("u-session");
  });

  it("refuse SSN-like and non-phone input before any database call", async () => {
    authMock.auth.mockResolvedValue({ user: { id: "u-session" } });
    for (const phone of ["123-45-6789", "hello", "+44 20 7946 0123", "x".repeat(40)]) {
      const res = await saveSmsConsent({ phone, agreed: true, wordingVersion: SMS_CONSENT_VERSION });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).not.toContain(phone);
    }
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("an unticked box is refused and nothing is written", async () => {
    authMock.auth.mockResolvedValue({ user: { id: "u-session" } });
    tx.smsConsentEvent.findMany.mockResolvedValue([]);
    const res = await saveSmsConsent({ phone: "202-555-0123", agreed: false, wordingVersion: SMS_CONSENT_VERSION });
    expect(res.ok).toBe(false);
    expect(tx.smsConsentEvent.create).not.toHaveBeenCalled();
  });

  it("a missing table answers 'not set up yet'", async () => {
    authMock.auth.mockResolvedValue({ user: { id: "u-session" } });
    mockDb.$transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("missing", { code: "P2021", clientVersion: "x" }));
    expect(await withdrawSmsConsent()).toEqual({ ok: false, error: SMS_NOT_SET_UP_TEXT });
  });
});
