// The client's invoice page (/i/<token>): what it shows and never shows (plan P11), rendered from plain props, plus the source pins of
// the public surfaces (the page and its PDF route check the TOKEN first and never use auth() as a gate; next.config sends no-referrer and
// no-store for /i/*; the tracing include ships the fonts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/actions/public-invoice", () => ({ markInvoiceViewed: vi.fn(), startCheckout: vi.fn() }));

import { InvalidInvoiceLink, PublicInvoice } from "@/components/invoicing/public/public-invoice";
import { INVALID_LINK_MESSAGE } from "@/lib/invoicing/constants";
import type { PdfInput } from "@/lib/invoicing/pdf/model";
import { toPublicInvoiceView } from "@/lib/invoicing/public-view";

(globalThis as unknown as { React: typeof React }).React = React;
const root = process.cwd();
const read = (f: string) => readFileSync(join(root, f), "utf8");
const TOKEN = "Ab3_-".repeat(8) + "xyz";

const input = (over: Partial<PdfInput> = {}): PdfInput => ({
  status: "issued",
  displayNumber: "3100",
  title: "Website build",
  poNumber: null,
  business: { name: "Eric Kinniburgh Consulting, LLC", dbaName: "LaunchTime Solutions", addressLines: ["1 Test Road", "Testville, CT 06000"], einText: "12-3456789" },
  billTo: { name: "Acme Robotics", addressLines: ["2 Client Way", "Clientown, NY 11111"] },
  issueDate: "2026-10-20",
  dueText: "Due upon receipt",
  lines: [{ description: "Consulting", quantity: "10", unit: "hr", unitPriceCents: 10_000, discountText: null, totalCents: 100_000, workDate: null }],
  subtotalCents: 100_000,
  discountCents: 0,
  discountLabel: null,
  totalCents: 100_000,
  paidCents: 25_000,
  balanceCents: 75_000,
  notes: "Thanks for the project.",
  termsText: "Payment due on receipt.",
  footerText: "Thank you for your business!",
  remit: { payableTo: "LaunchTime Solutions", mailingLines: ["PO Box 1", "Testville, CT 06000"], bankLines: [] },
  documentLabel: "Invoice",
  ...over,
});
const html = (i: PdfInput, canPayOnline = true) => renderToStaticMarkup(<PublicInvoice view={toPublicInvoiceView(i, { canPayOnline })} token={TOKEN} track={false} />);

describe("the client's invoice page", () => {
  it("shows the number, the business (dba), the client name, lines, totals, paid and the balance, and a PDF link", () => {
    const h = html(input());
    for (const s of ["INVOICE 3100", "LaunchTime Solutions", "Acme Robotics", "Consulting", "10 hr", "$1,000.00", "$250.00", "$750.00", "Balance due", "Thanks for the project.", "Payment due on receipt."]) expect(h, s).toContain(s);
    expect(h).toContain(`/i/${TOKEN}/pdf`);
    expect(h).toContain("Pay $750.00 online");
  });

  it("never shows the EIN, the client's address, internal notes, contacts or e-mail addresses", () => {
    const h = html(input());
    expect(h).not.toContain("12-3456789");
    expect(h).not.toMatch(/EIN/);
    expect(h).not.toContain("2 Client Way");
    expect(h).not.toMatch(/@/);
  });

  it("bank / ACH text appears only when the invoice includes it", () => {
    expect(html(input())).not.toContain("Bank / ACH details");
    const h = html(input({ remit: { payableTo: null, mailingLines: [], bankLines: ["Routing #: 021000021"] } }));
    expect(h).toContain("Bank / ACH details");
    expect(h).toContain("021000021");
  });

  it("no Pay button when online payment is not offered", () => {
    expect(html(input(), false)).not.toContain("online</button>");
    expect(html(input(), false)).not.toMatch(/Pay \$/);
  });

  it("a paid invoice says so, with no amount due and no Pay button", () => {
    const h = html(input({ paidCents: 100_000, balanceCents: 0 }));
    expect(h).toContain("Paid in full");
    expect(h).not.toMatch(/Pay \$/);
  });

  it("a void invoice says it was cancelled, shows no amount due and no Pay button", () => {
    const h = html(input({ status: "void", paidCents: 0, balanceCents: 0 }));
    expect(h).toContain("This invoice was cancelled");
    expect(h).not.toContain("Amount due");
    expect(h).not.toContain("Balance due");
    expect(h).not.toMatch(/Pay \$/);
    expect(toPublicInvoiceView(input({ status: "void" }), { canPayOnline: true }).canPayOnline).toBe(false);
  });

  it("the invalid-link page shows only the neutral sentence", () => {
    const h = renderToStaticMarkup(<InvalidInvoiceLink />);
    expect(h).toContain(INVALID_LINK_MESSAGE);
    expect(h).not.toMatch(/expired|revoked|not found/i);
  });
});

describe("source pins of the public surfaces", () => {
  const strip = (s: string) =>
    s
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
  it("the page validates the token before it loads anything and never calls auth()", () => {
    const src = strip(read("app/i/[token]/page.tsx"));
    const body = src.slice(src.indexOf("export default async function"));
    expect(body.indexOf("resolvePublicAccess(token")).toBeGreaterThan(-1);
    expect(body.indexOf("resolvePublicAccess(token")).toBeLessThan(body.indexOf("loadInvoicePdfSource"));
    expect(body.indexOf("resolvePublicAccess(token")).toBeLessThan(body.indexOf("loadPaySettings"));
    expect(src).not.toMatch(/\bauth\(\)|@\/lib\/auth|AppShell/);
    expect(src).toMatch(/export const dynamic = "force-dynamic"/);
    expect(src).toMatch(/robots: \{ index: false, follow: false \}/);
  });
  it("the PDF route checks the token FIRST, answers 404 with the neutral text, and never caches", () => {
    const src = strip(read("app/i/[token]/pdf/route.ts"));
    const body = src.slice(src.indexOf("export async function GET"));
    expect(body.indexOf("resolvePublicAccess(token")).toBeGreaterThan(-1);
    expect(body.indexOf("resolvePublicAccess(token")).toBeLessThan(body.indexOf("loadInvoicePdfSource"));
    expect(body).toMatch(/INVALID_LINK_MESSAGE, \{ status: 404/);
    expect(src).toMatch(/private, no-store/);
    expect(src).toMatch(/hideEin: true/);
    expect(src).not.toMatch(/\bauth\(\)|@\/lib\/auth/);
    expect(src).toMatch(/export const runtime = "nodejs"/);
    expect(src).toMatch(/export const maxDuration = 30/);
  });
  it("the static return pages read nothing and carry no token", () => {
    for (const f of ["app/i/paid/page.tsx", "app/i/cancelled/page.tsx"]) {
      const src = strip(read(f));
      expect(src, f).not.toMatch(/params|searchParams|@\/lib\/|await /);
    }
    expect(read("app/i/paid/page.tsx")).toMatch(/will be confirmed shortly/);
  });
  it("next.config: /i/:path* gets no-referrer and no-store AFTER the catch-all, and /i/** ships the invoice fonts", () => {
    const cfg = read("next.config.ts");
    const all = cfg.indexOf('source: "/(.*)"');
    const mine = cfg.indexOf('source: "/i/:path*"');
    expect(all).toBeGreaterThan(-1);
    expect(mine).toBeGreaterThan(all);
    const block = cfg.slice(mine, cfg.indexOf("]", mine));
    expect(block).toMatch(/Referrer-Policy", value: "no-referrer"/);
    expect(block).toMatch(/Cache-Control", value: "private, no-store"/);
    expect(cfg).toMatch(/"\/i\/\*\*": \["\.\/data\/invoicing\/\*\*\/\*"\]/);
  });
});
