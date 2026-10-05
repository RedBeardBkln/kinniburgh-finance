import React, { createElement } from "react";
import { vi } from "vitest";
vi.setConfig({ testTimeout: 120000 }); // the pipeline fills and reads back a dozen real IRS forms
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as { React?: typeof React }).React = React;
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/actions/tax-return-overrides", () => ({ clearTaxReturnOverride: vi.fn(), setTaxReturnOverride: vi.fn(), listTaxReturnOverrideHistory: vi.fn() }));

import { ReturnSheet } from "@/components/tax/forms/return-sheet";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { buildSheetModel } from "@/lib/tax2025-sheet";
import { runL2 } from "@/lib/tax-review/l2";
import { buildLinkContext } from "@/lib/tax-review/links-context";
import { conflictLinks, findingLinks, isSafeLinkHref, linkRuleFor, openItemLinks, type FindingLink } from "@/lib/tax-review/links";
import { lineAnchorId } from "@/lib/tax-anchors";
import type { OverrideRow } from "@/lib/tax2025/overrides";
import { buildPipeline, cleanScenario, loadCatalogs, richScenario, runPipeline } from "./tax-review-harness";
import { owner } from "./tax2025-fixtures";

// End to end over the real reviewer: the L1 checks and the independent recalculation (L2) run on real scenarios (real engine return, the real
// PDFs filled and read back), and EVERY finding they produce must get at least one safe link from a rule that exists for its check id.

const hrefs = (links: readonly FindingLink[]): string[] => links.map((l) => l.href);

describe("every finding of a real run has links", () => {
  for (const name of ["clean", "rich"] as const) {
    it(`${name} scenario: L1 + L2 findings, the sheet's open items and conflicts`, async () => {
      const s = name === "clean" ? cleanScenario() : richScenario();
      const { pipeline, result } = await runPipeline(s);
      const { ret, ctx: l1 } = pipeline;
      const model = buildSheetModel({ ret, documents: s.raw.documents.map((d) => ({ id: d.id, docType: d.docType, taxYear: d.taxYear, verified: d.verified, legacyFormat: d.legacyFormat, subjectType: d.subjectType })), now: new Date("2026-10-05T12:00:00Z") });
      const links = buildLinkContext({ model, ret, maps: FORM_MAPS, catalogs: loadCatalogs() });
      const l2 = runL2({ ret, effective: l1.effective, facts: s.facts });
      const findings = [...result.findings, ...l2.findings];
      expect(findings.length).toBeGreaterThan(0);

      for (const f of findings) {
        expect(linkRuleFor(f.check).explicit, f.check).toBe(true);
        const fl = findingLinks(f, links);
        expect(fl.length, `${f.check}: ${f.message.slice(0, 60)}`).toBeGreaterThan(0);
        for (const l of fl) expect(isSafeLinkHref(l.href), `${f.check}: ${l.href}`).toBe(true);
        // a finding that names a line on the sheet links to that row (the same id the sheet carries)
        if (f.lineKey !== undefined && f.lineKey in links.sheetLines) expect(hrefs(fl), f.check).toContain(`/tax/forms/2025/return#${lineAnchorId(f.lineKey)}`);
        // a finding about a printed form links to the filled PDF
        if (f.formKey !== undefined && links.forms[f.formKey]?.pdf !== null && links.forms[f.formKey] !== undefined) expect(fl.some((l) => l.kind === "pdf"), f.check).toBe(true);
        // a document the finding names is a document of the return and opens its review screen
        for (const e of f.evidence) if (e.ref.startsWith("doc:") && e.ref.slice(4) in links.documents) expect(hrefs(fl), f.check).toContain(`/documents/${e.ref.slice(4)}/review`);
      }
      for (const i of model.openItems) expect(openItemLinks(i, links).length, i.id).toBeGreaterThan(0);
      for (const c of model.conflicts) expect(conflictLinks(c, links).length).toBeGreaterThan(0);
    });
  }

  it("a decision at its default links to its card with 'Record this decision'; once recorded the sheet says 'Change decision' and the link follows", async () => {
    const withHomeOffice = (rows: OverrideRow[]) => {
      const s = richScenario(undefined, (f) => {
        f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive" as const);
        f.income.scheduleC.homeOfficeSqft = owner(150);
      });
      return { ...s, overrideRows: rows };
    };
    const decided = (rows: OverrideRow[]) => buildPipeline(withHomeOffice(rows));
    const rec: OverrideRow = {
      id: "00000000-0000-4000-8000-0000000000d1",
      taxYear: 2025,
      targetKind: "decision",
      targetKey: "homeOfficeMethod",
      version: 1,
      valueKind: "choice",
      valueCents: null,
      valueText: "actual",
      computedSnapshot: { status: "computed", cents: 0 },
      authority: "owner",
      reason: "checked",
      setByName: "Eric Kinniburgh",
      setAt: new Date("2026-10-05T10:00:00Z"),
      archivedAt: null,
    };
    for (const rows of [[], [rec]]) {
      const { ret, ctx } = await decided(rows);
      const model = buildSheetModel({ ret, documents: [], now: new Date("2026-10-05T12:00:00Z"), ...(ctx.effective ? { effective: ctx.effective } : {}) });
      const links = buildLinkContext({ model, ret, maps: FORM_MAPS, catalogs: loadCatalogs() });
      const x1 = model.decisions.find((d) => d.id === "X1");
      expect(x1, "X1 is on the sheet").toBeDefined();
      expect(x1?.override !== null).toBe(rows.length > 0);
      const f = { check: "L1.D2.decision", area: "process", message: "m", evidence: [{ ref: "check:decision.X1" }] };
      const l = findingLinks(f, links)[0];
      expect(l?.kind).toBe("decision");
      expect(l?.href).toBe("/tax/forms/2025/return#decision-x1");
      expect(l?.label.startsWith(rows.length > 0 ? "Change this decision" : "Record this decision")).toBe(true);
      // the open item of an undecided decision (decision:X1) points at the same card
      for (const i of model.openItems.filter((x) => x.id.startsWith("decision:"))) expect(hrefs(openItemLinks(i, links))[0]).toBe(`/tax/forms/2025/return#decision-${i.id.slice(9).toLowerCase()}`);
      // the rendered sheet: the card carries the anchor, its own control says the same thing the link says, and every same-page link resolves
      const html = renderToStaticMarkup(createElement(ReturnSheet, { model, links }));
      expect(html).toContain('id="decision-x1"');
      expect(html).toContain(rows.length > 0 ? ">Change decision<" : ">Record this decision<");
      const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ""));
      for (const m of html.matchAll(/\shref="\/tax\/forms\/2025\/return#([^"]+)"/g)) expect(ids.has(m[1] ?? ""), `#${m[1]}`).toBe(true);
      if (rows.length === 0) expect(model.openItems.some((i) => i.id === "decision:X1")).toBe(true);
    }
  });
});
