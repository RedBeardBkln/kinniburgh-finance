// Round 3: the invoicing screens are read-only for a non-owner. The pages decide read-only mode on the SERVER from the owner rule and pass a
// plain boolean to the client components, which render no create / edit / archive / void / pay controls (and never import server code).
// The server actions are owner-only as well (invoicing-eva-readonly.test.ts), so hiding the controls is a convenience, not the protection.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/actions/clients", () => ({
  addContact: vi.fn(), archiveClient: vi.fn(), archiveContact: vi.fn(), createClient: vi.fn(), linkClientW9: vi.fn(), revealClientEin: vi.fn(), setClientEin: vi.fn(), updateClient: vi.fn(), updateContact: vi.fn(),
}));
vi.mock("@/actions/documents", () => ({ finalizeDocumentUpload: vi.fn(), requestDocumentUploadSlot: vi.fn() }));
vi.mock("@/actions/reimbursable-items", () => ({ archiveItem: vi.fn(), createItem: vi.fn(), updateItem: vi.fn() }));
vi.mock("@/actions/invoices", () => ({ duplicateInvoice: vi.fn(), voidInvoice: vi.fn() }));

import { ClientForm, ContactsPanel, W9Panel } from "@/components/invoicing/client-forms";
import { ItemRow } from "@/components/invoicing/item-forms";
import { InvoiceActions } from "@/components/invoicing/invoice-actions";
import type { ClientView, ContactView } from "@/lib/invoicing/clients-build";
import type { ItemView } from "@/lib/invoicing/catalog-build";

(globalThis as unknown as { React: typeof React }).React = React;
const ROOT = resolve(__dirname, "../..");
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const client: ClientView = {
  id: "c1", name: "Acme Robotics", addressLine1: "2 Client Way", addressLine2: null, city: "Clientown", state: "NY", postalCode: "11111", country: "US", einLast4: "6789",
  defaultNetDays: null, defaultTaxable: false, w9DocumentId: null, w9OnFile: false, w9ReceivedOn: null, w9Label: null, notes: null, contacts: [],
};
const contact: ContactView = { id: "k1", name: "Pat Payer", email: "pat@example.com", phone: null, role: "billing", roleLabel: null, receivesInvoices: true };
const item = { id: "i1", name: "Prints", unit: "ea", unitCostCents: 100, pricingMode: "markup", markupBps: 1000, billedUnitPriceCents: null, billedPriceCents: 110, glCodeId: "g1", glLabel: "4100 Billable", taxable: false } as unknown as ItemView;

describe("client screens in read-only mode", () => {
  it("ClientForm: the fields are disabled (fieldset) and there are no Save / Add / Archive buttons for a non-owner", () => {
    const ro = html(<ClientForm slug="ek-consulting" client={client} readOnly />);
    expect(ro).toContain("<fieldset");
    expect(ro).toMatch(/<fieldset[^>]*disabled/);
    expect(ro).toContain("View only");
    expect(ro).toContain("Acme Robotics"); // she can still read it
    // L-1: the buttons are not rendered at all (no CSS-hidden markup, no button element anywhere)
    expect(ro).not.toContain("Save client");
    expect(ro).not.toContain("Add client");
    expect(ro).not.toContain("Archive");
    expect(ro).not.toContain("<button");
    expect(ro).not.toContain('class="hidden"');
    expect(html(<ClientForm slug="ek-consulting" readOnly />)).not.toContain("Add client");
    const owner = html(<ClientForm slug="ek-consulting" client={client} />);
    expect(owner).not.toMatch(/<fieldset[^>]*disabled/);
    expect(owner).toContain("Save client");
    expect(owner).toContain("Archive");
    expect(owner).not.toContain("View only");
  });

  it("ContactsPanel: contacts are listed without Edit / Remove / Add a contact", () => {
    const ro = html(<ContactsPanel slug="ek-consulting" clientId="c1" contacts={[contact]} readOnly />);
    expect(ro).toContain("Pat Payer");
    expect(ro).not.toContain("Edit");
    expect(ro).not.toContain("Remove");
    expect(ro).not.toContain("Add a contact");
    expect(ro).toContain("Only the owner can add or change contacts");
    const owner = html(<ContactsPanel slug="ek-consulting" clientId="c1" contacts={[contact]} />);
    expect(owner).toContain("Edit");
    expect(owner).toContain("Remove");
    expect(owner).toContain("Add a contact");
  });

  it("W9Panel: status only; no upload, link or unlink controls for a non-owner", () => {
    const props = { slug: "ek-consulting", clientId: "c1", entityId: "e1", onFile: true, label: "W-9.pdf", receivedOn: "2026-10-01", options: [] };
    const ro = html(<W9Panel {...props} readOnly />);
    expect(ro).toContain("on file");
    expect(ro).not.toContain("Upload W-9");
    expect(ro).not.toContain("Unlink");
    expect(ro).not.toContain('type="file"');
    const owner = html(<W9Panel {...props} />);
    expect(owner).toContain("Upload W-9");
    expect(owner).toContain("Unlink");
  });
});

describe("items and invoice buttons in read-only mode", () => {
  it("ItemRow: no Edit button for a non-owner", () => {
    const tbl = (el: React.ReactElement) => html(<table><tbody>{el}</tbody></table>);
    expect(tbl(<ItemRow slug="ek-consulting" item={item} glOptions={[]} readOnly />)).not.toContain("Edit");
    expect(tbl(<ItemRow slug="ek-consulting" item={item} glOptions={[]} />)).toContain("Edit");
  });

  it("InvoiceActions: everyone can download the PDF; only the owner sees Duplicate and Void", () => {
    const ro = html(<InvoiceActions slug="ek-consulting" documentId="d1" status="issued" canEdit={false} voidBlockedReason={null} />);
    expect(ro).toContain("Download PDF");
    expect(ro).not.toContain("Duplicate as new draft");
    expect(ro).not.toContain("Void invoice");
    const owner = html(<InvoiceActions slug="ek-consulting" documentId="d1" status="issued" canEdit voidBlockedReason={null} />);
    expect(owner).toContain("Download PDF");
    expect(owner).toContain("Duplicate as new draft");
    expect(owner).toContain("Void invoice");
    // a draft shown read-only to a non-owner has the download and nothing else
    const draft = html(<InvoiceActions slug="ek-consulting" documentId="d1" status="draft" canEdit={false} voidBlockedReason={null} />);
    expect(draft).toContain("Download PDF");
    expect(draft).not.toContain("Duplicate");
  });
});

describe("the pages decide read-only mode on the server", () => {
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
  it("the list / editor pages hide the create entry points and show the editor only to the owner", () => {
    expect(read("app/business/[slug]/invoices/page.tsx")).toMatch(/ctx\.status === "ready" && ctx\.owner\.allowed/);
    expect(read("app/business/[slug]/invoices/new/page.tsx")).toMatch(/if \(!ctx\.owner\.allowed\)/);
    expect(read("app/business/[slug]/invoices/[id]/page.tsx")).toMatch(/detail\.status === "draft" && ctx\.owner\.allowed/);
    expect(read("app/business/[slug]/clients/page.tsx")).toMatch(/ctx\.owner\.allowed \?/);
    expect(read("app/business/[slug]/clients/[id]/page.tsx")).toMatch(/const readOnly = !ctx\.owner\.allowed/);
    expect(read("app/business/[slug]/items/page.tsx")).toMatch(/const readOnly = !ctx\.owner\.allowed/);
  });
  it("L-3: the settings summary prints the next invoice number with the configured zero padding", () => {
    expect(read("app/business/[slug]/invoicing/settings/page.tsx")).toMatch(/formatDisplayNumber\(profile\.invoicePrefix, profile\.nextInvoiceNumber, profile\.numberPad\)/);
  });
  it("client components receive plain booleans, not owner objects or server code", () => {
    for (const f of ["components/invoicing/client-forms.tsx", "components/invoicing/item-forms.tsx", "components/invoicing/invoice-actions.tsx"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/from "@\/lib\/invoicing\/(gate-build|owner|store|tin-store)"/);
      expect(src, f).toMatch(/readOnly|canEdit/);
    }
  });
});
