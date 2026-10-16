// Assembles the content of an invoice PDF from the database (read-only). No auth here: the route (app/api/invoicing/[id]/pdf) has
// already run `auth()`. The allow-list gate still applies: a document of any entity but the allow-listed one is "not found".
// Encrypted values are read only through lib/invoicing/tin-store.ts: the business EIN only when the document's showEin is on,
// the bank / ACH text only when the document's includeRemitTo is on and the text exists.

import { db } from "@/lib/db";
import { isInvoicingSlug } from "@/lib/invoicing/entity-gate";
import { isMissingInvoicingTable } from "@/lib/invoicing/errors";
import { loadProfile } from "@/lib/invoicing/gate-build";
import { loadInvoiceDetail, type InvoiceDetail } from "@/lib/invoicing/documents-build";
import { nyToday } from "@/lib/invoicing/state";
import { readBusinessEin, readRemitText } from "@/lib/invoicing/tin-store";
import { safeFilename } from "@/lib/invoicing/pdf/filename";
import type { PdfInput } from "@/lib/invoicing/pdf/model";
import { downloadLogoFile } from "@/lib/supabase-storage";

export type PdfSource =
  | { status: "ok"; input: PdfInput; logo: { bytes: Uint8Array; mime: string } | null; filename: string; entityId: string; documentId: string }
  | { status: "not_found" }
  | { status: "not_migrated" };

const dollars = (cents: number) => `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;
const splitLines = (t: string | null) => (t ? t.split("\n").map((l) => l.trim()).filter((l) => l !== "") : []);

function dueText(d: InvoiceDetail, termsLabel: string): string {
  if (d.netDays !== null && d.netDays > 0 && d.dueDate) return `Net ${d.netDays} days, due ${d.dueDate}`;
  return termsLabel;
}

export async function loadInvoicePdfSource(documentId: string): Promise<PdfSource> {
  try {
    const head = await db.billingDocument.findFirst({
      where: { id: documentId, kind: "invoice", archivedAt: null },
      select: { entityId: true, clientId: true, entity: { select: { slug: true, name: true, dbaName: true } } },
    });
    if (!head || !isInvoicingSlug(head.entity.slug)) return { status: "not_found" };
    const profile = await loadProfile(head.entityId);
    if (!profile || !profile.enabled) return { status: "not_found" };
    const detail = await loadInvoiceDetail(head.entityId, documentId, nyToday(new Date()));
    if (!detail) return { status: "not_found" };
    const client = await db.client.findFirst({
      where: { id: head.clientId, entityId: head.entityId },
      select: { name: true, addressLine1: true, addressLine2: true, city: true, state: true, postalCode: true, country: true },
    });
    if (!client) return { status: "not_found" };

    const cityLine = [client.city, [client.state, client.postalCode].filter(Boolean).join(" ")].filter((x) => x && x !== "").join(", ");
    const billAddress = [client.addressLine1, client.addressLine2, cityLine, client.country && client.country !== "US" ? client.country : null].filter((x): x is string => Boolean(x && x.trim() !== ""));

    const einText = detail.showEin && profile.einLast4 ? await readBusinessEin(head.entityId) : null;
    const bankText = detail.includeRemitTo && profile.hasRemitBank ? await readRemitText(head.entityId) : null;

    let logo: { bytes: Uint8Array; mime: string } | null = null;
    if (profile.logoKey && profile.logoMime) {
      try {
        logo = { bytes: new Uint8Array(await downloadLogoFile(profile.logoKey)), mime: profile.logoMime };
      } catch {
        logo = null; // a missing logo never blocks the invoice
      }
    }

    const percentDisc = detail.discountKind === "percent";
    const input: PdfInput = {
      status: detail.status === "void" ? "void" : detail.status === "draft" ? "draft" : "issued",
      displayNumber: detail.displayNumber,
      title: detail.title,
      poNumber: detail.poNumber,
      business: { name: head.entity.name, dbaName: head.entity.dbaName, addressLines: splitLines(profile.businessAddress), einText },
      billTo: { name: client.name, addressLines: billAddress },
      issueDate: detail.issueDate,
      dueText: dueText(detail, profile.termsLabel),
      lines: detail.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitPriceCents: l.unitPriceCents,
        discountText: l.discountKind ? (l.discountKind === "percent" ? `${l.discountValueText}% off` : `${dollars(Number(l.discountValueText.replace(".", "")))} off`) : null,
        totalCents: l.lineTotalCents,
        workDate: l.workDate,
      })),
      subtotalCents: detail.subtotalCents,
      discountCents: detail.discountCents,
      discountLabel: detail.discountCents > 0 ? (percentDisc ? `Discount (${detail.discountValueText}%)` : "Discount") : null,
      totalCents: detail.totalCents,
      paidCents: detail.status === "issued" ? detail.allocatedCents : 0,
      balanceCents: detail.status === "issued" ? detail.balanceCents : detail.status === "void" ? 0 : detail.totalCents,
      notes: detail.notes,
      termsText: profile.termsText,
      footerText: profile.footerText,
      remit: { payableTo: profile.checkPayableTo, mailingLines: splitLines(profile.remitToMailingAddress), bankLines: splitLines(bankText) },
      documentLabel: "Invoice",
    };
    return { status: "ok", input, logo, filename: safeFilename(detail.displayNumber), entityId: head.entityId, documentId };
  } catch (err) {
    if (isMissingInvoicingTable(err)) return { status: "not_migrated" };
    throw err;
  }
}
