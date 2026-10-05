import React, { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Render smoke tests (no DOM, no browser): the Final review components and the return review sheet are rendered to static markup with a real
// engine return, so the links and the anchors they point at are checked in the actual HTML: every fragment a link carries must be an id that
// the rendered sheet / Forms page / Final review page really has. (vitest's esbuild uses the classic JSX runtime for the components, so React
// is provided as a global, like tax-prefill-render.test.ts.)
(globalThis as { React?: typeof React }).React = React;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/actions/tax-return-overrides", () => ({ clearTaxReturnOverride: vi.fn(), setTaxReturnOverride: vi.fn(), listTaxReturnOverrideHistory: vi.fn() }));
vi.mock("@/actions/tax-review", () => ({ runReviewChecks: vi.fn(), getReviewRun: vi.fn(), acceptFinding: vi.fn(), reopenFinding: vi.fn(), cancelAiReview: vi.fn(), estimateAiReview: vi.fn(), runNextAiTask: vi.fn(), startAiReview: vi.fn() }));
vi.mock("@/actions/tax-return-approval", () => ({ approveReturn: vi.fn(), withdrawApproval: vi.fn() }));

import { ReturnSheet } from "@/components/tax/forms/return-sheet";
import { FindingsTable } from "@/components/tax/review/findings-table";
import { FindingDetail } from "@/components/tax/review/finding-detail";
import { GateChecklist } from "@/components/tax/review/review-status";
import { RegisterTable } from "@/components/tax/review/register-table";
import { ByHandChecklist } from "@/components/tax/review/by-hand-checklist";
import { InfoCards } from "@/components/tax/review/info-cards";
import { PdfDownloadButtons } from "@/components/tax/forms/pdf-download-buttons";
import { buildLinkContext } from "@/lib/tax-review/links-context";
import { findingLinks, type LinkContext } from "@/lib/tax-review/links";
import { buildRegister } from "@/lib/tax-review/llm/register";
import { buildReviewState, type FindingDto } from "@/lib/tax-review/state";
import { INFO_CARDS, type VerifiedCard } from "@/lib/tax-review/info-cards";
import { lineAnchorId } from "@/lib/tax-anchors";
import { buildSheetModel } from "@/lib/tax2025-sheet";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { loadCatalogs } from "./tax-review-harness";
import { emptyFacts, fullFacts } from "./tax2025-fixtures";

const NOW = new Date("2026-10-05T12:00:00Z");

function scenario(kind: "complete" | "blocked") {
  const facts = kind === "complete" ? fullFacts() : emptyFacts();
  const ret = computeTy2025Return(facts);
  const model = buildSheetModel({ ret, documents: [], now: NOW });
  const ctx = buildLinkContext({ model, ret, maps: FORM_MAPS, catalogs: loadCatalogs() });
  return { facts, ret, model, ctx };
}

const idsOf = (html: string): Set<string> => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ""));
const hrefsOf = (html: string): string[] => [...html.matchAll(/\shref="([^"]+)"/g)].map((m) => (m[1] ?? "").replace(/&amp;/g, "&"));
const fragmentsOf = (hrefs: string[], pathPrefix: string): string[] => hrefs.filter((h) => h.startsWith(`${pathPrefix}#`)).map((h) => h.slice(pathPrefix.length + 1));

describe("the return review sheet carries the anchors its links point at", () => {
  for (const kind of ["complete", "blocked"] as const) {
    describe(kind, () => {
      const { model, ctx } = scenario(kind);
      const html = renderToStaticMarkup(createElement(ReturnSheet, { model, links: ctx }));
      const ids = idsOf(html);

      it("every line of the sheet has a row with id line-<slug> (the same slug the links use)", () => {
        const lines = [...model.federal, ...model.connecticut].flatMap((g) => g.lines);
        expect(lines.length).toBeGreaterThan(50);
        for (const l of lines) expect(ids.has(lineAnchorId(l.key)), l.key).toBe(true);
      });

      it("every part, decision, open item, conflict, homework entry, document row, form block and the overrides panel has its id", () => {
        for (const part of ["part-1", "part-2", "part-3", "part-4", "part-5", "part-6", "overrides", "attestations", "headline-federal", "headline-connecticut"]) expect(ids.has(part), part).toBe(true);
        for (const d of model.decisions) expect(ids.has(`decision-${d.id.toLowerCase()}`), d.id).toBe(true);
        for (const g of [...model.federal, ...model.connecticut]) expect(ids.has(`form-${g.form.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`), g.form).toBe(true);
        expect(html.match(/data-item-id=/g)?.length ?? 0).toBe(model.openItems.length);
      });

      it("every link on the sheet that points back at the sheet resolves to an id of the rendered page", () => {
        const frags = fragmentsOf(hrefsOf(html), "/tax/forms/2025/return");
        expect(frags.length, "the sheet should carry same-page links").toBeGreaterThan(0);
        for (const f of frags) expect(ids.has(f), `#${f}`).toBe(true);
      });

      it("each open item row has an 'Answer or resolve' cell with at least one link; each conflict and homework entry has links", () => {
        const cells = html.match(/data-testid="item-links"/g)?.length ?? 0;
        expect(cells).toBe(model.openItems.length);
        expect(html.match(/data-testid="conflict-links"/g)?.length ?? 0).toBe(model.conflicts.length);
        expect(html.match(/data-testid="homework-links"/g)?.length ?? 0).toBe(model.homework.length);
        // every list that was rendered is not empty
        expect(html).not.toMatch(/data-testid="item-links"[^>]*>\s*<\/td>/);
        // links are hidden when printed
        expect(html).toContain("print:hidden");
      });

      it("links that go to other pages are the fixed shapes (documents, PDF, Forms page, questionnaire, books)", () => {
        for (const h of hrefsOf(html)) {
          if (h.startsWith("/tax/forms/2025/return") || !h.startsWith("/")) continue;
          expect(h, h).toMatch(/^(\/documents|\/api\/tax\/forms\/2025\/pdf\/[a-z0-9]+\?view=1|\/tax\/forms\/2025(\/questionnaire\/[a-z0-9-]+)?|\/tax\/(personal|fixed-assets|donations)\/2025|\/business\/ek-consulting\/(gl|mileage)|\/tax\/forms\/2025\/(cpa-summary|final-review)|\/tax$|\/tax\/forms\/2025\/return)/);
        }
      });
    });
  }

  it("the blocked return shows the owner-facing targets: questions for the 'none' statements and a decision card link", () => {
    const { model, ctx } = scenario("blocked");
    const html = renderToStaticMarkup(createElement(ReturnSheet, { model, links: ctx }));
    expect(html).toContain("Answer this question");
    expect(html).toContain("questionnaire/return-completeness#q-");
    expect(model.openItems.some((i) => i.id.startsWith("none:"))).toBe(true);
  });
});

function dto(over: Partial<FindingDto> & Pick<FindingDto, "check" | "message">): FindingDto {
  return {
    key: "a".repeat(16),
    evidenceHash: "b".repeat(16),
    layer: "L1",
    severity: "medium",
    area: "deductions",
    formKey: null,
    lineKey: null,
    evidence: [],
    citation: { sources: [], sourceStatus: "not_applicable" },
    recommendedAction: "Do the thing.",
    acceptable: true,
    status: "open",
    gating: false,
    acceptedReason: null,
    acceptedBy: null,
    acceptedAt: null,
    ...over,
  };
}

describe("the Final review components render their links", () => {
  const { ret, facts, ctx } = scenario("complete");
  const lineKey = Object.keys(ctx.sheetLines).find((k) => k === "scha.8a") ?? Object.keys(ctx.sheetLines)[0] ?? "f1040.9";
  const lineFinding = dto({ check: "L1.E2.expense-ratio", message: "Schedule A line 8a is large", lineKey, formKey: "f1040sa", evidence: [{ ref: lineKey, amount: 5, status: "computed" }], key: "c".repeat(16) });

  it("the findings list shows the first two links under each row, and the detail shows all of them under 'Go to it'", () => {
    const html = renderToStaticMarkup(createElement(FindingsTable, { findings: [lineFinding], year: 2025, canDecide: false, whyNotDecide: "x", links: ctx }));
    expect(html).toContain('data-testid="finding-row-links"');
    expect(html).toContain(`/tax/forms/2025/return#${lineAnchorId(lineKey)}`);
    const detail = renderToStaticMarkup(createElement(FindingDetail, { finding: lineFinding, links: findingLinks(lineFinding, ctx), canDecide: false, whyNotDecide: "x", onAccept: () => undefined, onReopen: () => undefined }));
    expect(detail).toContain("Go to it");
    expect(detail).toContain(`/tax/forms/2025/return#${lineAnchorId(lineKey)}`);
    expect(detail).toContain("/api/tax/forms/2025/pdf/f1040sa?view=1");
    expect(detail).toContain("/tax/forms/2025#schedule-a");
  });

  it("only the PDF opens in a new tab (target=_blank with noopener); no link uses window.open or javascript:", () => {
    const detail = renderToStaticMarkup(createElement(FindingDetail, { finding: lineFinding, links: findingLinks(lineFinding, ctx), canDecide: false, whyNotDecide: "x", onAccept: () => undefined, onReopen: () => undefined }));
    const anchors = [...detail.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(anchors.length).toBeGreaterThan(2);
    for (const a of anchors) {
      if (a.includes("/api/tax/forms/2025/pdf/")) {
        expect(a).toContain('target="_blank"');
        expect(a).toContain('rel="noopener noreferrer"');
      } else {
        expect(a).not.toContain("target=");
      }
      expect(a).not.toMatch(/javascript:/i);
    }
    expect(detail).toContain("(opens in a new tab)");
  });

  it("a finding with nothing resolvable still renders one link (its area's section)", () => {
    const f = dto({ check: "L1.Z9.future-check", message: "Something new", area: "process", key: "d".repeat(16) });
    const html = renderToStaticMarkup(createElement(FindingsTable, { findings: [f], year: 2025, canDecide: false, whyNotDecide: null, links: ctx }));
    expect(html).toContain("/tax/forms/2025/return#part-5");
  });

  it("the gate checklist: a 'Jump to' for each row that is not green, to the filter, the open item, the decision and the question", () => {
    const decisionFinding = dto({ check: "L1.D2.decision", severity: "medium", message: "Decision X1 is at its default", evidence: [{ ref: "check:decision.X1", amount: null, status: "default_undecided" }], key: "e".repeat(16), area: "process", gating: true });
    const run = { id: "r", fingerprint: "a".repeat(64), engineVersion: "e", startedAt: "2026-10-05T10:00:00.000Z", startedByName: "x", l1Summary: { status: "completed" }, l2Summary: null };
    const state = buildReviewState({
      currentFingerprint: "a".repeat(64),
      engine: { complete: false, blockingItemCount: 1, lineOverrideCount: 1, staleOverrideCount: 0 },
      latest: { run, findings: [] },
      runs: [run],
      dispositions: [],
      approvals: [],
      approver: { allowed: true, ownerName: "x", reason: null },
    });
    const withFinding = { ...state, findings: [decisionFinding], gate: { ...state.gate, items: state.gate.items.map((i) => (i.id === "l1" ? { ...i, state: "fail" as const, detail: "1 open item(s) that block approval" } : i)) } };
    const ctxWithDecision: LinkContext = { ...ctx, decisions: { ...ctx.decisions, X1: { label: "Home office method", recorded: false } } };
    const html = renderToStaticMarkup(createElement(GateChecklist, { state: withFinding, links: ctxWithDecision }));
    expect(html).toContain('data-testid="gate-jump-fingerprint"'.replace("fingerprint", "engine"));
    expect(html).toContain('data-testid="gate-jump-l1"');
    expect(html).toContain('href="#findings-gating-l1"');
    expect(html).toContain("/tax/forms/2025/return#decision-x1");
    expect(html).toContain("Record this decision: X1");
    expect(html).toContain('data-testid="gate-jump-l3"');
    expect(html).toContain('href="#ai-review"');
    expect(html).toContain('data-testid="gate-jump-verdict"');
    expect(html).toContain('id="gate-item-l1"');
    // a green row has none
    expect(html).not.toContain('data-testid="gate-jump-fingerprint"');
  });

  it("the judgments register, the by-hand list and the information cards render links", () => {
    const register = buildRegister({ ret, facts });
    const reg = renderToStaticMarkup(createElement(RegisterTable, { entries: register, narrated: false, links: ctx }));
    expect(reg).toContain('data-testid="register-links"');
    expect(register.length).toBeGreaterThan(0);
    const hand = renderToStaticMarkup(createElement(ByHandChecklist, { links: ctx }));
    expect(hand).toContain("/api/tax/forms/2025/pdf/f1040?view=1");
    expect(hand).toContain("#page=2");
    const cards: VerifiedCard[] = INFO_CARDS.map((c) => ({ id: c.id, title: c.title, label: c.label, dropped: [], statements: c.statements.map((s) => ({ ...s, url: "https://www.irs.gov/x", sourceTitle: "t" })) }));
    const info = renderToStaticMarkup(createElement(InfoCards, { cards, links: ctx }));
    expect(info).toContain("/api/tax/forms/2025/pdf/f8949?view=1");
    expect(info).toContain("/api/tax/forms/2025/pdf/f1040?view=1#page=2");
  });

  it("the Forms page's PDF section carries its anchor (the target of the 'filled PDF forms' links)", () => {
    const html = renderToStaticMarkup(createElement(PdfDownloadButtons, { year: 2025 }));
    expect(idsOf(html).has("filled-pdf-forms")).toBe(true);
  });
});
