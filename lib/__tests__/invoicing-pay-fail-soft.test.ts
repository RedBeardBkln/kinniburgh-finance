// Phase-2 fail-soft (plan P10): before migration 20261023000000_invoicing_stripe is applied, the Phase-2 loaders answer "not set up"
// (never throw), Phase-1 loaders select no Phase-2 column, Phase-1 updates narrow RETURNING with a `select`, and first setup
// (`createProfile`, whose INSERT always names the defaulted Phase-2 columns) answers a clear "not set up yet" refusal.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});

import { db } from "@/lib/db";
import { InvoicingRefusal, isMissingInvoicingTable, isMissingPayFeature, userMessageFor } from "@/lib/invoicing/errors";
import { PAY_FEATURE_NOT_SET_UP, INVOICING_NOT_SET_UP, INVOICING_SETUP_NEEDS_PAY_UPDATE } from "@/lib/invoicing/constants";
import { createProfile } from "@/lib/invoicing/store";
import type { GlMap } from "@/lib/invoicing/gl-map";
import { loadInvoiceLinks, loadInvoiceStripeFlags, loadOnlinePaymentsOverview, loadPaySettings, resolvePublicAccess } from "@/lib/invoicing/pay-build";

const fake = db as unknown as FakeDb;
const prismaError = (code: string, message: string, meta?: Record<string, unknown>) => Object.assign(new Error(message), { code, meta });
const missingColumn = () => prismaError("P2022", "The column `InvoicingProfile.stripePayEnabled` does not exist in the current database.", { column: "InvoicingProfile.stripePayEnabled" });
const missingTable = () => prismaError("P2021", "The table `public.BillingAccessToken` does not exist in the current database.", { table: "public.BillingAccessToken" });

beforeEach(() => vi.restoreAllMocks());

describe("isMissingPayFeature", () => {
  it("knows P2021 / P2022 and the raw 42P01 / 42703 codes, and the new table and column names", () => {
    expect(isMissingPayFeature(missingColumn())).toBe(true);
    expect(isMissingPayFeature(missingTable())).toBe(true);
    expect(isMissingPayFeature({ meta: { code: "42703" } })).toBe(true);
    expect(isMissingPayFeature({ meta: { code: "42P01" } })).toBe(true);
    expect(isMissingPayFeature(new Error('relation "StripeEvent" does not exist'))).toBe(true);
    expect(isMissingPayFeature(new Error('column "stripeFeeStatus" does not exist'))).toBe(true);
    expect(isMissingPayFeature(new Error("timeout"))).toBe(false);
    expect(isMissingPayFeature(prismaError("P2002", "Unique constraint failed"))).toBe(false);
    expect(isMissingPayFeature(null)).toBe(false);
  });
  it("Phase-1 semantics are unchanged (isMissingInvoicingTable is not widened to P2022)", () => {
    expect(isMissingInvoicingTable(prismaError("P2022", "column missing"))).toBe(false);
    expect(isMissingInvoicingTable(prismaError("P2021", "x"))).toBe(true);
  });
  it("an action that hits a missing Phase-2 table or column says so; a missing Phase-1 table keeps its own sentence", () => {
    expect(userMessageFor(missingColumn())).toBe(PAY_FEATURE_NOT_SET_UP);
    expect(userMessageFor(missingTable())).toBe(PAY_FEATURE_NOT_SET_UP);
    expect(userMessageFor(prismaError("P2021", "The table `public.BillingDocument` does not exist", { table: "public.BillingDocument" }))).toBe(INVOICING_NOT_SET_UP);
  });
});

describe("the Phase-2 loaders fail soft", () => {
  it("settings, links, flags, overview and the public token check answer 'not set up' / 'invalid' on a missing column or table", async () => {
    vi.spyOn(fake.invoicingProfile, "findUnique").mockRejectedValue(missingColumn());
    expect(await loadPaySettings("e1")).toEqual({ status: "not_set_up" });
    vi.spyOn(fake.billingAccessToken, "findMany").mockRejectedValue(missingTable());
    expect(await loadInvoiceLinks("e1", "d1", new Date())).toEqual({ status: "not_set_up" });
    vi.spyOn(fake.billingAccessToken, "findUnique").mockRejectedValue(missingTable());
    expect(await resolvePublicAccess("A".repeat(43), new Date())).toEqual({ ok: false });
    vi.spyOn(fake.billingPayment, "findMany").mockRejectedValue(missingColumn());
    expect(await loadOnlinePaymentsOverview("e1")).toEqual({ status: "not_set_up" });
    vi.spyOn(fake.billingEvent, "findMany").mockRejectedValue(missingColumn());
    expect(await loadInvoiceStripeFlags("e1", "d1")).toEqual([]);
  });
  it("other errors are not swallowed", async () => {
    vi.spyOn(fake.invoicingProfile, "findUnique").mockRejectedValue(new Error("connection reset"));
    await expect(loadPaySettings("e1")).rejects.toThrow("connection reset");
  });
});

describe("Phase-1 code never reads or returns a Phase-2 column", () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  const PHASE2 = /stripePayEnabled|publicTokenTtlDays|stripePaymentIntentId|stripeChargeId|stripeCheckoutSessionId|stripeFeeStatus|billingAccessToken|stripeEvent/;
  it("the Phase-1 loaders (profile, payments, documents, clients, catalog, PDF) select none of them", () => {
    for (const f of ["lib/invoicing/gate-build.ts", "lib/invoicing/payments-build.ts", "lib/invoicing/documents-build.ts", "lib/invoicing/clients-build.ts", "lib/invoicing/catalog-build.ts", "lib/invoicing/pdf-build.ts"]) {
      expect(read(f), f).not.toMatch(PHASE2);
    }
  });
  // This pins only the RETURNING clause (a `select`), which is what keeps Phase-1 UPDATES on both tables and the BillingPayment create
  // working before the migration. It does NOT prove an INSERT works: Prisma writes every static @default column into an INSERT, so
  // `invoicingProfile.create` still names the defaulted Phase-2 columns and fails with P2022 on an unmigrated database (verified by the
  // Tester against real Postgres). That case is covered by the createProfile mapping test below, not by this one.
  it("every Phase-1 store write on InvoicingProfile / BillingPayment carries a `select` (narrows RETURNING only, not an INSERT's columns)", () => {
    const src = read("lib/invoicing/store.ts");
    expect([...src.matchAll(/(?:db|tx)\.(invoicingProfile|billingPayment)\.(create|update)\(\{/g)].length).toBeGreaterThanOrEqual(8);
    for (const m of src.matchAll(/(?:db|tx)\.(invoicingProfile|billingPayment)\.(create|update)\(\{[\s\S]*?\n?\s*\}\);/g)) {
      expect(m[0], m[0].slice(0, 80)).toMatch(/select: \{ id: true \}/);
    }
  });
});

describe("createProfile on a database without the online-payments migration", () => {
  const setup = {
    goLiveOn: new Date("2026-10-01T00:00:00Z"),
    invoicePrefix: "",
    nextInvoiceNumber: 3100,
    quotePrefix: "Q-",
    nextQuoteNumber: 2001,
    numberPad: 0,
    defaultNetDays: 0,
    termsLabel: "Due upon receipt",
    glMap: {} as unknown as GlMap,
    businessAddress: null,
    replyToEmail: null,
    fromName: null,
    footerText: null,
    termsText: null,
    remitToMailingAddress: null,
    checkPayableTo: null,
  };
  it("a missing Phase-2 column on the INSERT (P2022) is a clear 'not set up yet' refusal, not a generic failure", async () => {
    vi.spyOn(fake.invoicingProfile, "create").mockRejectedValue(missingColumn());
    const err = await createProfile("e1", setup).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoicingRefusal);
    expect((err as Error).message).toBe(INVOICING_SETUP_NEEDS_PAY_UPDATE);
    expect(userMessageFor(err)).toBe(INVOICING_SETUP_NEEDS_PAY_UPDATE);
  });
  it("a missing InvoicingProfile table (P2021) keeps the Phase-1 'not set up' sentence", async () => {
    vi.spyOn(fake.invoicingProfile, "create").mockRejectedValue(prismaError("P2021", "The table `public.InvoicingProfile` does not exist", { table: "public.InvoicingProfile" }));
    const err = await createProfile("e1", setup).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoicingRefusal);
    expect((err as Error).message).toBe(INVOICING_NOT_SET_UP);
  });
  it("a duplicate is still 'already set up' and any other error is rethrown unchanged", async () => {
    vi.spyOn(fake.invoicingProfile, "create").mockRejectedValue(prismaError("P2002", "Unique constraint failed"));
    await expect(createProfile("e1", setup)).rejects.toThrow("Invoicing is already set up for this business.");
    const other = new Error("connection reset");
    vi.spyOn(fake.invoicingProfile, "create").mockRejectedValue(other);
    await expect(createProfile("e1", setup)).rejects.toBe(other);
  });
});
