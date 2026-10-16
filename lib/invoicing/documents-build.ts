// Read-only loaders for invoices (list, detail with lines / applications / timeline) and the derived balances. No writes, explicit
// selects, plain strings and integer cents out (no Decimal, no Date), drafts that were archived are excluded.

import { db } from "@/lib/db";
import { formatBps } from "@/lib/invoicing/money";
import { deriveInvoiceState, type InvoiceDisplayState } from "@/lib/invoicing/state";
import { toIsoDate } from "@/lib/invoicing/validate";

export interface InvoiceRow {
  id: string;
  clientId: string;
  clientName: string;
  status: string;
  displayNumber: string | null;
  title: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalCents: number;
  allocatedCents: number;
  balanceCents: number;
  state: InvoiceDisplayState;
  overdue: boolean;
  daysPastDue: number;
  sentAt: string | null;
  voidedAt: string | null;
  updatedAt: string;
}

const ROW_SELECT = {
  id: true,
  clientId: true,
  status: true,
  displayNumber: true,
  number: true,
  title: true,
  issueDate: true,
  dueDate: true,
  totalCents: true,
  sentAt: true,
  voidedAt: true,
  updatedAt: true,
  client: { select: { name: true } },
  allocations: { where: { voidedAt: null }, select: { amountCents: true } },
} as const;

export async function loadInvoiceRows(entityId: string, today: Date): Promise<InvoiceRow[]> {
  const rows = await db.billingDocument.findMany({
    where: { entityId, kind: "invoice", archivedAt: null },
    select: ROW_SELECT,
    orderBy: [{ number: "desc" }, { createdAt: "desc" }],
    take: 1000,
  });
  return rows.map((r) => {
    const allocatedCents = r.allocations.reduce((s, a) => s + a.amountCents, 0);
    const d = deriveInvoiceState({ status: r.status, sentAt: r.sentAt, totalCents: r.totalCents, allocatedCents, dueDate: r.dueDate, today });
    return {
      id: r.id,
      clientId: r.clientId,
      clientName: r.client.name,
      status: r.status,
      displayNumber: r.displayNumber,
      title: r.title,
      issueDate: r.issueDate ? toIsoDate(r.issueDate) : null,
      dueDate: r.dueDate ? toIsoDate(r.dueDate) : null,
      totalCents: r.totalCents,
      allocatedCents,
      balanceCents: d.balanceCents,
      state: d.state,
      overdue: d.overdue,
      daysPastDue: d.daysPastDue,
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
      voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

export interface LineView {
  id: string;
  sortOrder: number;
  description: string;
  /** Exact decimal text, e.g. "7.25". */
  quantity: string;
  unit: string | null;
  unitPriceCents: number;
  discountKind: string | null;
  /** The text the editor shows: percent "10" or fixed dollars "5.00". */
  discountValueText: string;
  lineTotalCents: number;
  glCodeId: string | null;
  taxable: boolean;
  workDate: string | null;
  itemId: string | null;
  unitCostCents: number | null;
  markupBps: number | null;
  costTransactionId: string | null;
  receiptId: string | null;
}

export interface AllocationView {
  id: string;
  paymentId: string | null;
  amountCents: number;
  appliedOn: string;
  voidedAt: string | null;
  method: string | null;
  receivedOn: string | null;
  reference: string | null;
}

export interface EventView {
  id: string;
  kind: string;
  createdAt: string;
  data: Record<string, string | number | boolean | null>;
}

export interface InvoiceDetail extends InvoiceRow {
  number: number | null;
  billingModel: string;
  poNumber: string | null;
  netDays: number | null;
  notes: string | null;
  internalNotes: string | null;
  subtotalCents: number;
  discountKind: string | null;
  discountValueText: string;
  discountCents: number;
  includeRemitTo: boolean;
  showEin: boolean;
  issuedAt: string | null;
  voidReason: string | null;
  lines: LineView[];
  allocations: AllocationView[];
  events: EventView[];
}

function quantityText(q: { toFixed(dp: number): string }): string {
  const t = q.toFixed(3);
  const [whole, frac = ""] = t.split(".");
  const trimmed = frac.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : (whole ?? "0");
}

function discountText(kind: string | null, value: number | null): string {
  if (!kind || value === null) return "";
  if (kind === "percent") return formatBps(value);
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

export async function loadInvoiceDetail(entityId: string, id: string, today: Date): Promise<InvoiceDetail | null> {
  const r = await db.billingDocument.findFirst({
    where: { id, entityId, kind: "invoice", archivedAt: null },
    select: {
      ...ROW_SELECT,
      number: true,
      billingModel: true,
      poNumber: true,
      netDays: true,
      notes: true,
      internalNotes: true,
      subtotalCents: true,
      discountKind: true,
      discountValue: true,
      discountCents: true,
      includeRemitTo: true,
      showEin: true,
      issuedAt: true,
      voidReason: true,
      lines: {
        select: {
          id: true, sortOrder: true, description: true, quantity: true, unit: true, unitPriceCents: true, discountKind: true, discountValue: true,
          lineTotalCents: true, glCodeId: true, taxable: true, workDate: true, itemId: true, unitCostCents: true, markupBps: true,
          costTransactionId: true, receiptId: true,
        },
        orderBy: { sortOrder: "asc" },
      },
      allocations: {
        select: {
          id: true, paymentId: true, amountCents: true, appliedOn: true, voidedAt: true,
          payment: { select: { method: true, receivedOn: true, reference: true } },
        },
        orderBy: { appliedOn: "asc" },
      },
      events: { select: { id: true, kind: true, createdAt: true, data: true }, orderBy: { createdAt: "asc" }, take: 200 },
    },
  });
  if (!r) return null;
  const active = r.allocations.filter((a) => a.voidedAt === null);
  const allocatedCents = active.reduce((s, a) => s + a.amountCents, 0);
  const d = deriveInvoiceState({ status: r.status, sentAt: r.sentAt, totalCents: r.totalCents, allocatedCents, dueDate: r.dueDate, today });
  return {
    id: r.id,
    clientId: r.clientId,
    clientName: r.client.name,
    status: r.status,
    displayNumber: r.displayNumber,
    title: r.title,
    issueDate: r.issueDate ? toIsoDate(r.issueDate) : null,
    dueDate: r.dueDate ? toIsoDate(r.dueDate) : null,
    totalCents: r.totalCents,
    allocatedCents,
    balanceCents: d.balanceCents,
    state: d.state,
    overdue: d.overdue,
    daysPastDue: d.daysPastDue,
    sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
    updatedAt: r.updatedAt.toISOString(),
    number: r.number,
    billingModel: r.billingModel,
    poNumber: r.poNumber,
    netDays: r.netDays,
    notes: r.notes,
    internalNotes: r.internalNotes,
    subtotalCents: r.subtotalCents,
    discountKind: r.discountKind,
    discountValueText: discountText(r.discountKind, r.discountValue),
    discountCents: r.discountCents,
    includeRemitTo: r.includeRemitTo,
    showEin: r.showEin,
    issuedAt: r.issuedAt ? r.issuedAt.toISOString() : null,
    voidReason: r.voidReason,
    lines: r.lines.map((l) => ({
      id: l.id,
      sortOrder: l.sortOrder,
      description: l.description,
      quantity: quantityText(l.quantity),
      unit: l.unit,
      unitPriceCents: l.unitPriceCents,
      discountKind: l.discountKind,
      discountValueText: discountText(l.discountKind, l.discountValue),
      lineTotalCents: l.lineTotalCents,
      glCodeId: l.glCodeId,
      taxable: l.taxable,
      workDate: l.workDate ? toIsoDate(l.workDate) : null,
      itemId: l.itemId,
      unitCostCents: l.unitCostCents,
      markupBps: l.markupBps,
      costTransactionId: l.costTransactionId,
      receiptId: l.receiptId,
    })),
    allocations: r.allocations.map((a) => ({
      id: a.id,
      paymentId: a.paymentId,
      amountCents: a.amountCents,
      appliedOn: toIsoDate(a.appliedOn),
      voidedAt: a.voidedAt ? a.voidedAt.toISOString() : null,
      method: a.payment?.method ?? null,
      receivedOn: a.payment ? toIsoDate(a.payment.receivedOn) : null,
      reference: a.payment?.reference ?? null,
    })),
    events: r.events.map((e) => ({
      id: e.id,
      kind: e.kind,
      createdAt: e.createdAt.toISOString(),
      data: (typeof e.data === "object" && e.data !== null && !Array.isArray(e.data) ? e.data : {}) as Record<string, string | number | boolean | null>,
    })),
  };
}
