import { describe, expect, it } from "vitest";
import {
  checkIssueDate,
  cleanEmail,
  cleanText,
  dueDateFor,
  parseCalendarDate,
  parseNetDays,
  validateDraft,
  validatePayment,
  type DraftInput,
  type PaymentInput,
} from "@/lib/invoicing/validate";
import { formatEin, maskedEin, normalizeEin } from "@/lib/invoicing/tin";
import { billedPriceCents, marginPerUnitCents, validateItem } from "@/lib/invoicing/items";
import { readGlMap, suggestGlMap, validateGlMap, type GlCodeLite } from "@/lib/invoicing/gl-map";
import { depositCapacityOk, nameTokens, scoreDeposits } from "@/lib/invoicing/deposit-match";
import { isInvoicingSlug, INVOICING_SLUGS } from "@/lib/invoicing/entity-gate";
import { INVOICING_OWNER_UNKNOWN_MESSAGE, NOT_INVOICING_OWNER_MESSAGE, resolveInvoicingOwner } from "@/lib/invoicing/owner";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_GL = "33333333-3333-4333-8333-333333333333";

describe("free text", () => {
  it("refuses SSN-like text in every free field (also nine contiguous digits)", () => {
    for (const bad of ["123-45-6789", "123 45 6789", "my ssn 123456789 ok"]) {
      expect(cleanText(bad, { label: "Notes", max: 100 }).ok).toBe(false);
    }
  });
  it("refuses account-number-like text only when asked", () => {
    expect(cleanText("acct 12345678", { label: "Notes", max: 100, noAccountNumbers: true }).ok).toBe(false);
    expect(cleanText("PO 4500012", { label: "PO", max: 100 }).ok).toBe(true);
  });
  it("normalises whitespace, strips control characters, enforces length and required", () => {
    expect(cleanText("  a\tb \n c ", { label: "x", max: 20 })).toEqual({ ok: true, value: "a b c" });
    expect(cleanText("a\u0000b", { label: "x", max: 20 })).toEqual({ ok: true, value: "a b" });
    expect(cleanText("abcdef", { label: "x", max: 3 }).ok).toBe(false);
    expect(cleanText("", { label: "x", max: 3, required: true }).ok).toBe(false);
    expect(cleanText("", { label: "x", max: 3 })).toEqual({ ok: true, value: null });
    expect(cleanText("line1\r\nline2", { label: "x", max: 50, multiline: true })).toEqual({ ok: true, value: "line1\nline2" });
  });
});

describe("e-mail", () => {
  it("accepts one clean address (edges trimmed) and refuses CR/LF inside (header injection)", () => {
    expect(cleanEmail("a@b.co")).toEqual({ ok: true, value: "a@b.co" });
    expect(cleanEmail("a@b.co\r\nBcc: x@y.z")).toEqual({ ok: false, error: "E-mail does not look like an e-mail address." });
    expect(cleanEmail(" a@b.co \n")).toEqual({ ok: true, value: "a@b.co" });
  });
  it("rejects lists and malformed addresses", () => {
    for (const bad of ["a@b.co,c@d.co", "a@b", "@b.co", "a b@c.co", "a@b.co;c@d.co", ""]) expect(cleanEmail(bad).ok).toBe(false);
  });
});

describe("dates", () => {
  it("parses real calendar days only", () => {
    expect(parseCalendarDate("2026-10-01")?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    for (const bad of ["2026-02-30", "2026-13-01", "10/01/2026", "2026-1-1", "", "1999-01-01"]) expect(parseCalendarDate(bad)).toBeNull();
  });
  it("issue date: not in the future, not before go-live (backdating to go-live is allowed)", () => {
    const goLive = d("2026-10-01");
    const today = d("2026-10-15");
    expect(checkIssueDate(d("2026-10-01"), goLive, today).ok).toBe(true);
    expect(checkIssueDate(d("2026-10-15"), goLive, today).ok).toBe(true);
    expect(checkIssueDate(d("2026-10-16"), goLive, today).ok).toBe(false);
    expect(checkIssueDate(d("2026-09-30"), goLive, today).ok).toBe(false);
  });
  it("due date = issue date + terms; due upon receipt is 0 days", () => {
    expect(dueDateFor(d("2026-10-05"), 0).toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(dueDateFor(d("2026-10-05"), 30).toISOString().slice(0, 10)).toBe("2026-11-04");
    expect(parseNetDays(0)).toEqual({ ok: true, value: 0 });
    expect(parseNetDays("")).toEqual({ ok: true, value: null });
    expect(parseNetDays(400).ok).toBe(false);
    expect(parseNetDays(-1).ok).toBe(false);
  });
});

describe("draft validation", () => {
  const ctx = { today: d("2026-10-15"), goLiveOn: d("2026-10-01"), forIssue: false };
  const draft = (over: Partial<DraftInput> = {}): DraftInput => ({
    clientId: UUID_A,
    billingModel: "hourly",
    lines: [{ description: "Consulting", quantity: "7.25", unitPrice: "175.00", glCodeId: UUID_GL }],
    ...over,
  });
  it("computes totals with the shared money module", () => {
    const r = validateDraft(draft(), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.totals.totalCents).toBe(126875);
      expect(r.value.lines[0]!.lineTotalCents).toBe(126875);
      expect(r.value.lines[0]!.quantityMilli).toBe(7250);
    }
  });
  it("applies a percent line discount and a fixed invoice discount", () => {
    const r = validateDraft(
      draft({ lines: [{ description: "Work", quantity: "2", unitPrice: "100", discountKind: "percent", discountValue: "10", glCodeId: UUID_GL }], discountKind: "fixed", discountValue: "5" }),
      ctx
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.totals.subtotalCents).toBe(18000);
      expect(r.value.totals.totalCents).toBe(17500);
    }
  });
  it("a draft may be incomplete; issuing may not (no GL, no lines, zero total)", () => {
    expect(validateDraft(draft({ lines: [{ description: "x", quantity: "1", unitPrice: "10" }] }), ctx).ok).toBe(true);
    const issue = { ...ctx, forIssue: true };
    expect(validateDraft(draft({ lines: [{ description: "x", quantity: "1", unitPrice: "10" }] }), issue).ok).toBe(false);
    expect(validateDraft(draft({ lines: [] }), issue).ok).toBe(false);
    expect(validateDraft(draft({ lines: [{ description: "x", quantity: "1", unitPrice: "0", glCodeId: UUID_GL }] }), issue).ok).toBe(false);
    const ok = validateDraft(draft(), issue);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.issueDate?.toISOString().slice(0, 10)).toBe("2026-10-15"); // defaults to today at issue
  });
  it("rejects negative or zero quantities, bad prices, SSN-like text and an over-large discount", () => {
    expect(validateDraft(draft({ lines: [{ description: "x", quantity: "0", unitPrice: "1" }] }), ctx).ok).toBe(false);
    expect(validateDraft(draft({ lines: [{ description: "x", quantity: "-1", unitPrice: "1" }] }), ctx).ok).toBe(false);
    expect(validateDraft(draft({ lines: [{ description: "x", quantity: "1", unitPrice: "-5" }] }), ctx).ok).toBe(false);
    expect(validateDraft(draft({ lines: [{ description: "x", quantity: "1", unitPrice: "1.234" }] }), ctx).ok).toBe(false);
    expect(validateDraft(draft({ lines: [{ description: "SSN 123-45-6789", quantity: "1", unitPrice: "1" }] }), ctx).ok).toBe(false);
    expect(validateDraft(draft({ notes: "ssn 123456789" }), ctx).ok).toBe(false);
    expect(validateDraft(draft({ discountKind: "fixed", discountValue: "999999" }), ctx).ok).toBe(false);
    expect(validateDraft(draft({ clientId: "nope" }), ctx).ok).toBe(false);
    expect(validateDraft(draft({ issueDate: "2026-10-16" }), ctx).ok).toBe(false);
    expect(validateDraft(draft({ issueDate: "2026-09-30" }), ctx).ok).toBe(false);
  });
});

describe("payment validation", () => {
  const ctx = { today: d("2026-12-15"), goLiveOn: d("2026-10-01") };
  const p = (over: Partial<PaymentInput> = {}): PaymentInput => ({
    clientId: UUID_A,
    method: "check",
    receivedOn: "2026-12-01",
    amount: "1000.00",
    requestKey: UUID_B,
    allocations: [{ invoiceId: UUID_GL, amount: "1000.00" }],
    ...over,
  });
  it("accepts a normal payment", () => {
    const r = validatePayment(p(), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.allocations).toEqual([{ invoiceId: UUID_GL, amountCents: 100000 }]);
  });
  it("overpayment is allowed (the remainder stays unallocated); applying more than the payment is not", () => {
    expect(validatePayment(p({ amount: "1200.00" }), ctx).ok).toBe(true);
    expect(validatePayment(p({ amount: "500.00" }), ctx).ok).toBe(false);
  });
  it("fee must be below the amount; future and pre-go-live dates are refused; the same invoice cannot be listed twice", () => {
    expect(validatePayment(p({ fee: "1000.00" }), ctx).ok).toBe(false);
    expect(validatePayment(p({ fee: "29.30" }), ctx).ok).toBe(true);
    expect(validatePayment(p({ receivedOn: "2026-12-16" }), ctx).ok).toBe(false);
    expect(validatePayment(p({ receivedOn: "2026-09-30" }), ctx).ok).toBe(false);
    expect(validatePayment(p({ allocations: [{ invoiceId: UUID_GL, amount: "1" }, { invoiceId: UUID_GL, amount: "2" }] }), ctx).ok).toBe(false);
  });
  it("needs a request key (double-click idempotency) and refuses account-number-like references", () => {
    expect(validatePayment(p({ requestKey: "x" }), ctx).ok).toBe(false);
    expect(validatePayment(p({ reference: "ACH 123456789012" }), ctx).ok).toBe(false);
    expect(validatePayment(p({ reference: "Check 1042" }), ctx).ok).toBe(true);
  });
});

describe("EIN handling", () => {
  it("normalises hyphens and returns last four", () => {
    expect(normalizeEin("12-3456789")).toEqual({ ok: true, digits: "123456789", last4: "6789" });
    expect(normalizeEin("123456789")).toEqual({ ok: true, digits: "123456789", last4: "6789" });
    expect(formatEin("123456789")).toBe("12-3456789");
    expect(maskedEin("6789")).toBe("XX-XXX6789");
    expect(maskedEin(null)).toBe("Not set");
  });
  it("refuses an SSN-format value, wrong lengths and junk", () => {
    expect(normalizeEin("123-45-6789").ok).toBe(false);
    expect(normalizeEin("123 45 6789").ok).toBe(false);
    for (const bad of ["12345678", "1234567890", "ab-3456789", "", "000000000"]) expect(normalizeEin(bad).ok).toBe(false);
  });
  it("the SSN-format refusal never echoes the value", () => {
    const r = normalizeEin("123-45-6789");
    expect(JSON.stringify(r)).not.toContain("6789");
  });
});

describe("reimbursable items (gross default, catalog only)", () => {
  const base = { name: "Prints", unit: "ea", unitCost: "200.00", pricingMode: "markup", markupPercent: "10", glCodeId: UUID_GL };
  it("markup mode derives the billed price with the pure function", () => {
    const r = validateItem(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.markupBps).toBe(1000);
      expect(billedPriceCents(r.value)).toBe(22000);
      expect(marginPerUnitCents(r.value)).toBe(2000);
    }
  });
  it("a blank or zero markup is a pass-through at cost", () => {
    const r = validateItem({ ...base, markupPercent: "" });
    expect(r.ok && billedPriceCents(r.value)).toBe(20000);
  });
  it("fixed-price mode bills the fixed price", () => {
    const r = validateItem({ ...base, pricingMode: "fixed_price", billedUnitPrice: "250" });
    expect(r.ok && billedPriceCents(r.value)).toBe(25000);
    expect(validateItem({ ...base, pricingMode: "fixed_price" }).ok).toBe(false);
  });
  it("the taxable flag is stored and nothing is calculated; there is no quantity field", () => {
    const r = validateItem({ ...base, taxable: true });
    expect(r.ok && r.value.taxable).toBe(true);
    if (r.ok) expect(Object.keys(r.value).some((k) => /stock|onhand|quantity/i.test(k))).toBe(false);
  });
  it("rejects bad input", () => {
    expect(validateItem({ ...base, name: "" }).ok).toBe(false);
    expect(validateItem({ ...base, unitCost: "-1" }).ok).toBe(false);
    expect(validateItem({ ...base, markupPercent: "150" }).ok).toBe(false);
    expect(validateItem({ ...base, pricingMode: "weird" }).ok).toBe(false);
    expect(validateItem({ ...base, glCodeId: "x" }).ok).toBe(false);
  });
});

describe("GL map", () => {
  const E = "ent-1";
  const code = (id: string, name: string, type: string, extra: Partial<GlCodeLite> = {}): GlCodeLite => ({ id, entityId: E, code: id, name, type, archivedAt: null, ...extra });
  const chart = [
    code("ar", "Accounts Receivable (A/R)", "asset"),
    code("def", "Deferred Revenue", "liability"),
    code("ref", "Refunds to customers", "revenue"),
    code("bil", "Billable Expense Income", "revenue"),
    code("mer", "Office expenses:Merchant account fees", "expense"),
    code("svc", "Services", "revenue"),
  ];
  it("preselects every role by NAME (never by number) from the live chart", () => {
    expect(suggestGlMap(chart)).toEqual({ ar: "ar", unearned: "def", discounts: "ref", billableIncome: "bil", processingFees: "mer" });
  });
  it("ignores archived accounts and wrong types", () => {
    const s = suggestGlMap([...chart.filter((c) => c.id !== "ar"), code("ar2", "Accounts Receivable (A/R)", "liability"), code("ar3", "Accounts Receivable", "asset", { archivedAt: d("2026-01-01") })]);
    expect(s.ar).toBeUndefined();
  });
  it("validation: entity, archive and type are enforced", () => {
    const good = { ar: "ar", unearned: "def", discounts: "ref", billableIncome: "bil", processingFees: "mer" };
    expect(validateGlMap(good, E, chart).ok).toBe(true);
    expect(validateGlMap({ ...good, ar: "def" }, E, chart).ok).toBe(false); // wrong type
    expect(validateGlMap(good, "other-entity", chart).ok).toBe(false); // wrong entity
    expect(validateGlMap({ ...good, ar: "" }, E, chart).ok).toBe(false);
    expect(validateGlMap(good, E, chart.map((c) => (c.id === "bil" ? { ...c, archivedAt: d("2026-01-01") } : c))).ok).toBe(false);
  });
  it("readGlMap returns null for an incomplete stored value", () => {
    expect(readGlMap(null)).toBeNull();
    expect(readGlMap({ ar: "x" })).toBeNull();
    expect(readGlMap({ ar: "a", unearned: "b", discounts: "c", billableIncome: "d", processingFees: "e" })).toEqual({ ar: "a", unearned: "b", discounts: "c", billableIncome: "d", processingFees: "e" });
  });
});

describe("deposit matching", () => {
  const pay = { amountCents: 100000, feeCents: 0, receivedOn: d("2026-12-02"), clientName: "Acme Robotics, LLC" };
  const dep = (over: Partial<Parameters<typeof scoreDeposits>[1][number]> = {}) => ({ transactionId: "T", postedAt: d("2026-12-02"), amountCents: 100000, text: "ACH CREDIT ACME ROBOTICS", alreadyLinkedNetCents: 0, ...over });
  it("name tokens drop legal words", () => {
    expect(nameTokens("Acme Robotics, LLC")).toEqual(["acme", "robotics"]);
  });
  it("same amount, same day and name hit rank first", () => {
    const r = scoreDeposits(pay, [dep({ transactionId: "far", postedAt: d("2026-12-10"), text: "x" }), dep({ transactionId: "best" })]);
    expect(r[0]!.transactionId).toBe("best");
    expect(r[0]!.reasons).toContain("same amount");
  });
  it("a Stripe-style payout (net of fee) matches by the amount after the fee", () => {
    const r = scoreDeposits({ ...pay, amountCents: 100000, feeCents: 3200 }, [dep({ amountCents: 96800, text: "STRIPE PAYOUT" })]);
    expect(r[0]!.reasons).toContain("same as the amount after the fee");
  });
  it("outside the date window or too small -> not offered", () => {
    expect(scoreDeposits(pay, [dep({ postedAt: d("2027-02-01") })])).toHaveLength(0);
    expect(scoreDeposits(pay, [dep({ amountCents: 50000 })])).toHaveLength(0);
  });
  it("shared-deposit sum rule", () => {
    expect(depositCapacityOk(100000, 60000, 40000)).toBe(true);
    expect(depositCapacityOk(100000, 60000, 40001)).toBe(false);
    expect(scoreDeposits(pay, [dep({ alreadyLinkedNetCents: 60000 })])).toHaveLength(0);
    const fill = scoreDeposits({ ...pay, amountCents: 40000 }, [dep({ alreadyLinkedNetCents: 60000 })]);
    expect(fill[0]!.reasons).toContain("fills the rest of a shared deposit");
  });
});

describe("entity gate and owner rule", () => {
  it("only the EK Consulting slug is allowed", () => {
    expect(INVOICING_SLUGS).toEqual(["ek-consulting"]);
    expect(isInvoicingSlug("ek-consulting")).toBe(true);
    for (const s of ["sudden-valley", "personal", "mezzo", "", null, undefined, "ek-consulting2"]) expect(isInvoicingSlug(s as string | null | undefined)).toBe(false);
  });
  const users = [{ id: "u-eric", name: "Eric Kinniburgh" }, { id: "u-eva", name: "Eva-Laura Ramirez-Wisiackas" }];
  it("the owner is the user named in the entity name; Eva is refused", () => {
    expect(resolveInvoicingOwner(users, "Eric Kinniburgh Consulting, LLC", "u-eric").allowed).toBe(true);
    const eva = resolveInvoicingOwner(users, "Eric Kinniburgh Consulting, LLC", "u-eva");
    expect(eva.allowed).toBe(false);
    expect(eva.reason).toBe(NOT_INVOICING_OWNER_MESSAGE);
  });
  it("fails closed when nobody (or two people) can be identified", () => {
    const none = resolveInvoicingOwner(users, "Acme Widgets", "u-eric");
    expect(none.allowed).toBe(false);
    expect(none.reason).toBe(INVOICING_OWNER_UNKNOWN_MESSAGE);
    expect(resolveInvoicingOwner(users, null, "u-eric").allowed).toBe(false);
    expect(resolveInvoicingOwner([{ id: "a", name: "Eric Kinniburgh" }, { id: "b", name: "Eric Kinniburgh" }], "Eric Kinniburgh Consulting, LLC", "a").allowed).toBe(false);
  });
});
