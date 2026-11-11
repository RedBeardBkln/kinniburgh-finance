import { describe, expect, it } from "vitest";
import { buildInvoiceList, parseShowArchived } from "@/lib/invoicing/invoice-list";
import type { InvoiceRow } from "@/lib/invoicing/documents-build";

function row(id: string, status: string): InvoiceRow {
  return {
    id,
    clientId: "c1",
    clientName: "Client",
    status,
    displayNumber: status === "draft" ? null : id,
    title: null,
    issueDate: null,
    dueDate: null,
    totalCents: 1000,
    allocatedCents: 0,
    balanceCents: 1000,
    state: status === "void" ? "void" : status === "draft" ? "draft" : "sent",
    overdue: false,
    daysPastDue: 0,
    sentAt: null,
    voidedAt: null,
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

describe("buildInvoiceList", () => {
  const live = [row("3103", "issued"), row("3102", "void"), row("d1", "draft"), row("3101", "issued")];
  const archived = [row("d0", "draft")];

  it("hides void invoices and archived drafts by default", () => {
    const v = buildInvoiceList(live, archived, false);
    expect(v.rows.map((r) => r.id)).toEqual(["3103", "d1", "3101"]);
    expect(v.hiddenCount).toBe(2);
    expect(v.empty).toBe(false);
  });

  it("shows them after the live rows when asked, marking archived drafts", () => {
    const v = buildInvoiceList(live, archived, true);
    expect(v.rows.map((r) => r.id)).toEqual(["3103", "d1", "3101", "3102", "d0"]);
    expect(v.rows.find((r) => r.id === "d0")?.archivedDraft).toBe(true);
    expect(v.rows.find((r) => r.id === "3102")?.archivedDraft).toBe(false);
  });

  it("is not empty when only archived rows exist", () => {
    const v = buildInvoiceList([row("3100", "void")], [], false);
    expect(v.rows).toEqual([]);
    expect(v.empty).toBe(false);
    expect(v.hiddenCount).toBe(1);
    expect(buildInvoiceList([], [], false).empty).toBe(true);
  });
});

describe("parseShowArchived", () => {
  it("accepts only 1", () => {
    expect(parseShowArchived("1")).toBe(true);
    expect(parseShowArchived(["1", "0"])).toBe(true);
    expect(parseShowArchived("true")).toBe(false);
    expect(parseShowArchived(undefined)).toBe(false);
  });
});
