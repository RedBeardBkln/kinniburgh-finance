// Input validation for the invoicing actions (plan sections 6, 8.1, 12). PURE: no DB, no clock (callers pass `today`), safe in a
// client component. Every free-text field refuses SSN-like text (containsSsnLikeText, which also refuses nine contiguous digits);
// the free fields that never legitimately hold a long number (notes, references) also refuse account-number-like text. Line
// descriptions, titles and PO numbers skip the account-number check on purpose (a PO number can have six or more digits).

import { containsAccountNumberLikeText, containsSsnLikeText } from "@/lib/tax-extraction-schema";
import { parseDollarsToCents } from "@/lib/money-input";
import {
  BILLING_MODELS,
  DISCOUNT_KINDS,
  MAX_ADDRESS,
  MAX_ALLOCATIONS_PER_PAYMENT,
  MAX_LINES_PER_DOCUMENT,
  MAX_LINE_DESCRIPTION,
  MAX_NAME,
  MAX_NET_DAYS,
  MAX_NOTES,
  MAX_SHORT,
  PAYMENT_METHODS,
  type BillingModel,
  type DiscountKind,
  type PaymentMethod,
} from "@/lib/invoicing/constants";
import { computeDocumentTotals, parsePercentToBps, parseQuantityMilli, type DiscountInput, type DocumentTotals } from "@/lib/invoicing/money";

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

export interface TextOptions {
  label: string;
  max: number;
  /** Keep line breaks (addresses, notes). Otherwise every line break becomes a space. */
  multiline?: boolean;
  required?: boolean;
  /** Also refuse account-number-like text (6+ digits in a row, or grouped digits). */
  noAccountNumbers?: boolean;
}

/** Cleans one free-text value: strips control characters, normalises whitespace, caps the length, refuses SSN-like text. */
export function cleanText(raw: unknown, opts: TextOptions): Checked<string | null> {
  if (raw === null || raw === undefined) {
    return opts.required ? { ok: false, error: `${opts.label} is required.` } : { ok: true, value: null };
  }
  if (typeof raw !== "string") return { ok: false, error: `${opts.label} must be text.` };
  let s = raw.replace(/\r\n?/g, "\n").replace(CONTROL, " ");
  s = opts.multiline
    ? s
        .split("\n")
        .map((l) => l.replace(/[ \t]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : s.replace(/\s+/g, " ").trim();
  if (s === "") return opts.required ? { ok: false, error: `${opts.label} is required.` } : { ok: true, value: null };
  if (s.length > opts.max) return { ok: false, error: `${opts.label} must be at most ${opts.max} characters.` };
  if (containsSsnLikeText(s)) return { ok: false, error: `${opts.label} looks like a Social Security Number, which is never stored here.` };
  if (opts.noAccountNumbers && containsAccountNumberLikeText(s)) {
    return { ok: false, error: `${opts.label} looks like an account number, which is never stored here.` };
  }
  return { ok: true, value: s };
}

/** An e-mail address, or an error. Only leading / trailing whitespace is trimmed; any CR, LF or space INSIDE is refused (header injection), one address only. */
export function cleanEmail(raw: unknown, label = "E-mail"): Checked<string> {
  if (typeof raw !== "string") return { ok: false, error: `${label} is required.` };
  const s = raw.trim();
  if (s === "") return { ok: false, error: `${label} is required.` };
  if (s.length > 254 || !/^[^@\s,;<>()[\]\\"]+@[^@\s,;<>()[\]\\"]+\.[^@\s,;<>()[\]\\"]+$/.test(s)) {
    return { ok: false, error: `${label} does not look like an e-mail address.` };
  }
  return { ok: true, value: s };
}

/** "YYYY-MM-DD" to a Date at 00:00 UTC, or null for anything that is not a real calendar day. */
export function parseCalendarDate(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** Issue date rules: not in the future, not before go-live. */
export function checkIssueDate(issueDate: Date, goLiveOn: Date, today: Date): { ok: true } | { ok: false; error: string } {
  if (issueDate.getTime() > today.getTime()) return { ok: false, error: "The issue date cannot be in the future." };
  if (issueDate.getTime() < goLiveOn.getTime()) {
    return { ok: false, error: `The issue date cannot be before invoicing started (${toIsoDate(goLiveOn)}).` };
  }
  return { ok: true };
}

export function dueDateFor(issueDate: Date, netDays: number): Date {
  return addDays(issueDate, netDays);
}

export function parseNetDays(raw: unknown): Checked<number | null> {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : /^\d{1,3}$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_NET_DAYS) return { ok: false, error: `Payment terms must be 0 to ${MAX_NET_DAYS} days.` };
  return { ok: true, value: n };
}

// ── Document draft ──────────────────────────────────────────────────────────────

export interface DraftLineInput {
  description: string;
  quantity: string;
  unit?: string | null;
  /** Dollars, e.g. "175" or "175.50". */
  unitPrice: string;
  discountKind?: string | null;
  /** percent: "10" or "12.5"; fixed: dollars. */
  discountValue?: string | null;
  glCodeId?: string | null;
  taxable?: boolean;
  workDate?: string | null;
  itemId?: string | null;
  unitCostCents?: number | null;
  markupBps?: number | null;
  costTransactionId?: string | null;
  receiptId?: string | null;
}

export interface DraftInput {
  clientId: string;
  billingModel?: string;
  title?: string | null;
  poNumber?: string | null;
  issueDate?: string | null;
  netDays?: number | string | null;
  notes?: string | null;
  internalNotes?: string | null;
  discountKind?: string | null;
  discountValue?: string | null;
  includeRemitTo?: boolean;
  showEin?: boolean;
  lines: DraftLineInput[];
}

export interface ValidatedLine {
  sortOrder: number;
  description: string;
  quantityMilli: number;
  unit: string | null;
  unitPriceCents: number;
  discount: DiscountInput | null;
  lineTotalCents: number;
  glCodeId: string | null;
  taxable: boolean;
  workDate: Date | null;
  itemId: string | null;
  unitCostCents: number | null;
  markupBps: number | null;
  costTransactionId: string | null;
  receiptId: string | null;
}

export interface ValidatedDraft {
  clientId: string;
  billingModel: BillingModel;
  title: string | null;
  poNumber: string | null;
  issueDate: Date | null;
  netDays: number | null;
  notes: string | null;
  internalNotes: string | null;
  discount: DiscountInput | null;
  includeRemitTo: boolean;
  showEin: boolean;
  lines: ValidatedLine[];
  totals: DocumentTotals;
}

export interface DraftContext {
  today: Date;
  goLiveOn: Date;
  /** Strict mode used when issuing: lines, GL on every line, total above zero and an issue date within the allowed window. */
  forIssue: boolean;
}

function parseDiscount(kindRaw: string | null | undefined, valueRaw: string | null | undefined, label: string): Checked<DiscountInput | null> {
  const kind = kindRaw ? kindRaw.trim() : "";
  const value = valueRaw ? valueRaw.trim() : "";
  if (kind === "" && value === "") return { ok: true, value: null };
  if (kind === "" || value === "") return { ok: false, error: `${label}: choose a kind and an amount, or clear both.` };
  if (!(DISCOUNT_KINDS as readonly string[]).includes(kind)) return { ok: false, error: `${label}: unknown discount kind.` };
  if (kind === "percent") {
    const bps = parsePercentToBps(value);
    if (bps === null) return { ok: false, error: `${label}: enter a percent from 0.01 to 100 (up to 2 decimals).` };
    return { ok: true, value: { kind: "percent", value: bps } };
  }
  const cents = parseDollarsToCents(value);
  if (!cents.ok) return { ok: false, error: `${label}: ${cents.error}` };
  return { ok: true, value: { kind: "fixed", value: cents.cents } };
}

/** Validates and normalises a document draft, then computes its totals with the shared money module. */
export function validateDraft(input: DraftInput, ctx: DraftContext): Checked<ValidatedDraft> {
  if (!isUuid(input.clientId)) return { ok: false, error: "Choose a client." };
  const model = (input.billingModel ?? "general").trim();
  if (!(BILLING_MODELS as readonly string[]).includes(model)) return { ok: false, error: "Unknown billing type." };

  const title = cleanText(input.title, { label: "Title", max: MAX_NAME });
  if (!title.ok) return title;
  const po = cleanText(input.poNumber, { label: "PO number", max: 60 });
  if (!po.ok) return po;
  const notes = cleanText(input.notes, { label: "Notes", max: MAX_NOTES, multiline: true, noAccountNumbers: true });
  if (!notes.ok) return notes;
  const internal = cleanText(input.internalNotes, { label: "Internal notes", max: MAX_NOTES, multiline: true, noAccountNumbers: true });
  if (!internal.ok) return internal;

  let issueDate: Date | null = null;
  if (input.issueDate) {
    issueDate = parseCalendarDate(input.issueDate);
    if (!issueDate) return { ok: false, error: "The issue date must be a real date (YYYY-MM-DD)." };
    const ck = checkIssueDate(issueDate, ctx.goLiveOn, ctx.today);
    if (!ck.ok) return ck;
  } else if (ctx.forIssue) {
    issueDate = ctx.today;
    const ck = checkIssueDate(issueDate, ctx.goLiveOn, ctx.today);
    if (!ck.ok) return ck;
  }
  const net = parseNetDays(input.netDays);
  if (!net.ok) return net;

  const docDiscount = parseDiscount(input.discountKind, input.discountValue, "Invoice discount");
  if (!docDiscount.ok) return docDiscount;

  if (!Array.isArray(input.lines)) return { ok: false, error: "The lines are missing." };
  if (input.lines.length > MAX_LINES_PER_DOCUMENT) return { ok: false, error: `At most ${MAX_LINES_PER_DOCUMENT} lines per document.` };
  if (ctx.forIssue && input.lines.length === 0) return { ok: false, error: "Add at least one line before issuing." };

  const lines: ValidatedLine[] = [];
  for (let i = 0; i < input.lines.length; i += 1) {
    const l = input.lines[i]!;
    const where = `Line ${i + 1}`;
    const desc = cleanText(l.description, { label: `${where} description`, max: MAX_LINE_DESCRIPTION, required: true });
    if (!desc.ok) return desc;
    const qty = parseQuantityMilli(String(l.quantity ?? ""));
    if (qty === null) return { ok: false, error: `${where}: enter a quantity above zero with up to 3 decimals (hours like 7.25 are fine).` };
    const price = parseDollarsToCents(String(l.unitPrice ?? ""), { allowZero: true });
    if (!price.ok) return { ok: false, error: `${where}: ${price.error}` };
    const unit = cleanText(l.unit, { label: `${where} unit`, max: 20 });
    if (!unit.ok) return unit;
    const disc = parseDiscount(l.discountKind, l.discountValue, `${where} discount`);
    if (!disc.ok) return disc;
    const gl = l.glCodeId ? (isUuid(l.glCodeId) ? l.glCodeId : null) : null;
    if (l.glCodeId && !gl) return { ok: false, error: `${where}: unknown income account.` };
    if (ctx.forIssue && !gl) return { ok: false, error: `${where}: choose an income account before issuing.` };
    let workDate: Date | null = null;
    if (l.workDate) {
      workDate = parseCalendarDate(l.workDate);
      if (!workDate) return { ok: false, error: `${where}: the work date must be a real date (YYYY-MM-DD).` };
    }
    for (const [label, id] of [["catalog item", l.itemId], ["cost transaction", l.costTransactionId], ["receipt", l.receiptId]] as const) {
      if (id && !isUuid(id)) return { ok: false, error: `${where}: unknown ${label}.` };
    }
    const cost = l.unitCostCents ?? null;
    if (cost !== null && (!Number.isSafeInteger(cost) || cost < 0)) return { ok: false, error: `${where}: the cost snapshot is invalid.` };
    const mk = l.markupBps ?? null;
    if (mk !== null && (!Number.isSafeInteger(mk) || mk < 0)) return { ok: false, error: `${where}: the markup snapshot is invalid.` };
    lines.push({
      sortOrder: i,
      description: desc.value ?? "",
      quantityMilli: qty,
      unit: unit.value,
      unitPriceCents: price.cents,
      discount: disc.value,
      lineTotalCents: 0,
      glCodeId: gl,
      taxable: l.taxable === true,
      workDate,
      itemId: l.itemId || null,
      unitCostCents: cost,
      markupBps: mk,
      costTransactionId: l.costTransactionId || null,
      receiptId: l.receiptId || null,
    });
  }

  const totals = computeDocumentTotals(
    lines.map((l) => ({ quantityMilli: l.quantityMilli, unitPriceCents: l.unitPriceCents, discount: l.discount })),
    docDiscount.value
  );
  if (!totals.ok) return totals;
  lines.forEach((l, i) => {
    l.lineTotalCents = totals.totals.lines[i]!.totalCents;
  });
  if (ctx.forIssue && totals.totals.totalCents <= 0) return { ok: false, error: "An invoice cannot be issued with a total of zero. Use a discount for reductions." };

  return {
    ok: true,
    value: {
      clientId: input.clientId,
      billingModel: model as BillingModel,
      title: title.value,
      poNumber: po.value,
      issueDate,
      netDays: net.value,
      notes: notes.value,
      internalNotes: internal.value,
      discount: docDiscount.value,
      includeRemitTo: input.includeRemitTo === true,
      showEin: input.showEin === true,
      lines,
      totals: totals.totals,
    },
  };
}

// ── Payment ───────────────────────────────────────────────────────────────────────

export interface PaymentInput {
  clientId: string;
  method: string;
  receivedOn: string;
  /** Dollars. */
  amount: string;
  fee?: string | null;
  reference?: string | null;
  notes?: string | null;
  depositTransactionId?: string | null;
  requestKey: string;
  allocations: { invoiceId: string; amount: string }[];
}

export interface ValidatedPayment {
  clientId: string;
  method: PaymentMethod;
  receivedOn: Date;
  amountCents: number;
  feeCents: number;
  reference: string | null;
  notes: string | null;
  depositTransactionId: string | null;
  requestKey: string;
  allocations: { invoiceId: string; amountCents: number }[];
}

export function validatePayment(input: PaymentInput, ctx: { today: Date; goLiveOn: Date }): Checked<ValidatedPayment> {
  if (!isUuid(input.clientId)) return { ok: false, error: "Choose a client." };
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.method)) return { ok: false, error: "Choose how the payment was made." };
  const receivedOn = parseCalendarDate(input.receivedOn);
  if (!receivedOn) return { ok: false, error: "The received date must be a real date (YYYY-MM-DD)." };
  if (receivedOn.getTime() > ctx.today.getTime()) return { ok: false, error: "The received date cannot be in the future." };
  if (receivedOn.getTime() < ctx.goLiveOn.getTime()) return { ok: false, error: `The received date cannot be before invoicing started (${toIsoDate(ctx.goLiveOn)}).` };
  const amount = parseDollarsToCents(input.amount);
  if (!amount.ok) return { ok: false, error: `Amount: ${amount.error}` };
  let feeCents = 0;
  if (input.fee && input.fee.trim() !== "") {
    const fee = parseDollarsToCents(input.fee, { allowZero: true });
    if (!fee.ok) return { ok: false, error: `Fee: ${fee.error}` };
    feeCents = fee.cents;
  }
  if (feeCents >= amount.cents) return { ok: false, error: "The fee must be less than the payment amount." };
  const reference = cleanText(input.reference, { label: "Reference", max: 60, noAccountNumbers: true });
  if (!reference.ok) return reference;
  const notes = cleanText(input.notes, { label: "Notes", max: MAX_NOTES, multiline: true, noAccountNumbers: true });
  if (!notes.ok) return notes;
  if (input.depositTransactionId && !isUuid(input.depositTransactionId)) return { ok: false, error: "Unknown bank deposit." };
  if (!isUuid(input.requestKey)) return { ok: false, error: "The form is out of date. Reload the page." };
  if (!Array.isArray(input.allocations) || input.allocations.length > MAX_ALLOCATIONS_PER_PAYMENT) return { ok: false, error: "Too many invoices on one payment." };
  const seen = new Set<string>();
  const allocations: { invoiceId: string; amountCents: number }[] = [];
  let allocated = 0;
  for (const a of input.allocations) {
    if (!isUuid(a.invoiceId)) return { ok: false, error: "Unknown invoice in the applications." };
    if (seen.has(a.invoiceId)) return { ok: false, error: "An invoice is listed twice in the applications." };
    seen.add(a.invoiceId);
    if (a.amount.trim() === "") continue;
    const c = parseDollarsToCents(a.amount);
    if (!c.ok) return { ok: false, error: `Applied amount: ${c.error}` };
    allocations.push({ invoiceId: a.invoiceId, amountCents: c.cents });
    allocated += c.cents;
  }
  if (allocated > amount.cents) return { ok: false, error: "The amounts applied to invoices add up to more than the payment." };
  return {
    ok: true,
    value: {
      clientId: input.clientId,
      method: input.method as PaymentMethod,
      receivedOn,
      amountCents: amount.cents,
      feeCents,
      reference: reference.value,
      notes: notes.value,
      depositTransactionId: input.depositTransactionId || null,
      requestKey: input.requestKey,
      allocations,
    },
  };
}

// Re-exports so callers need one import for the limits they validate against.
export { MAX_ADDRESS, MAX_NAME, MAX_NOTES, MAX_SHORT };
export type { DiscountKind };
