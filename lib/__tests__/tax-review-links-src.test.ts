import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_FILTERS, filterFindings, filtersFromHash } from "@/lib/tax-review/ui";
import { FINDINGS_HASH, REVIEW_FILTER_EVENT } from "@/lib/tax-review/links";
import type { FindingDto } from "@/lib/tax-review/state";

// There is no jsdom in this repo, so what cannot be rendered is pinned by SOURCE CHECKS (what the components and pages must contain) plus the
// pure helpers' tests. The links and anchors are ALSO checked in rendered HTML (tax-review-links-render.test.ts); the browser behaviour is on the
// manual Chrome checklist (.claude/pipeline/final-review-deep-links/02-implementation-links.md).

const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const code = (p: string): string => read(p).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");

const DIR = "components/tax/review";
const PAGE = "app/tax/forms/[year]/final-review/page.tsx";

describe("the Final review components render the links", () => {
  it("the findings list computes each finding's links and shows them (first two on the row, all in the detail under 'Go to it')", () => {
    const t = read(`${DIR}/findings-table.tsx`);
    expect(t).toContain("findingLinks(f, links)");
    expect(t).toContain("<LinkList");
    expect(t).toContain("links={linksOf.get(f.key) ?? []}");
    const d = read(`${DIR}/finding-detail.tsx`);
    expect(d).toContain("Go to it");
    expect(d).toContain("<LinkList links={links}");
  });

  it("the gate checklist, the register, the by-hand list and the information cards each draw their links from the pure builders", () => {
    expect(read(`${DIR}/review-status.tsx`)).toContain("gateLinks(");
    expect(read(`${DIR}/review-status.tsx`)).toContain("gate-jump-");
    expect(read(`${DIR}/register-table.tsx`)).toContain("registerLinks(e, links)");
    expect(read(`${DIR}/by-hand-checklist.tsx`)).toContain("byHandLinks(t, links)");
    expect(read(`${DIR}/info-cards.tsx`)).toContain("infoLinks(s.id, links)");
  });

  it("the page loads the link context on the server and hands it to every component that shows links", () => {
    const p = read(PAGE);
    expect(p).toContain("const links = loaded.links");
    for (const c of ["<GateChecklist state={state} links={links}", "<FindingsTable", "<RegisterTable", "<RunHistory", "<ByHandChecklist links={links}", "<InfoCards"]) expect(p, c).toContain(c);
    expect(p).toMatch(/<FindingsTable [^>]*links=\{links\} listenForJumps/);
    expect(p).toMatch(/<RunHistory [^>]*links=\{links\}/);
    expect(p).toContain("<AnchorHighlight />");
    expect(read("lib/tax-review-server.ts")).toMatch(/links: linkContextOf\(inputs\)/);
  });

  it("the blocks the links jump to carry their ids: run controls, gate, AI review, findings, register, by-hand, information cards, gate rows", () => {
    expect(read(`${DIR}/run-controls.tsx`)).toContain("id={REVIEW_ANCHORS.runChecks}");
    expect(read(`${DIR}/review-status.tsx`)).toContain("id={REVIEW_ANCHORS.gate}");
    expect(read(`${DIR}/review-status.tsx`)).toContain("id={gateItemAnchorId(item.id)}");
    expect(read(`${DIR}/ai-review-panel.tsx`)).toContain("id={REVIEW_ANCHORS.aiReview}");
    expect(read(PAGE)).toContain("id={REVIEW_ANCHORS.findings}");
    expect(read(`${DIR}/register-table.tsx`)).toContain("id={REVIEW_ANCHORS.register}");
    expect(read(`${DIR}/by-hand-checklist.tsx`)).toContain("id={REVIEW_ANCHORS.byHand}");
    expect(read(`${DIR}/info-cards.tsx`)).toContain("id={REVIEW_ANCHORS.infoCards}");
  });

  it("the link component opens only the PDF in a new tab (with noopener), uses next/link for internal pages and never window.open or raw HTML", () => {
    const src = read(`${DIR}/finding-links.tsx`);
    expect(src).toContain('target="_blank"');
    expect(src).toContain('rel="noopener noreferrer"');
    expect(src.match(/target="_blank"/g)).toHaveLength(1);
    expect(src).toContain('from "next/link"');
    expect(src).toContain("prefetch={false}");
    expect(src).toContain("link.newTab");
    for (const f of ["finding-links.tsx", "findings-table.tsx", "finding-detail.tsx", "review-status.tsx", "register-table.tsx", "by-hand-checklist.tsx", "info-cards.tsx"]) {
      expect(code(`${DIR}/${f}`), f).not.toMatch(/window\.open|dangerouslySetInnerHTML|javascript:|location\.href\s*=/);
    }
    expect(code("components/tax/forms/return-sheet.tsx")).not.toMatch(/window\.open|dangerouslySetInnerHTML|javascript:/);
  });

  it("the pure link builder is browser-safe: it imports only the anchors module at runtime", () => {
    const imports = [...read("lib/tax-review/links.ts").matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual(["@/lib/tax-anchors"]);
    expect([...read("lib/tax-anchors.ts").matchAll(/^import\s/gm)]).toHaveLength(0);
  });
});

describe("the return review sheet links each open item, conflict and homework entry", () => {
  const sheet = read("components/tax/forms/return-sheet.tsx");
  it("computes the links with the SAME builder the Final review uses and hides them when printed", () => {
    expect(sheet).toContain("openItemLinks(item, links)");
    expect(sheet).toContain("conflictLinks(c, links)");
    expect(sheet).toContain("openItemLinks(itemOf.get(h.id) as SheetOpenItem, links)");
    expect(sheet).toContain('from "@/lib/tax-review/links"');
    expect(sheet).toContain("Answer or resolve");
    expect(sheet.match(/print:hidden/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
  it("the page builds the context from the sheet model it renders", () => {
    const p = read("app/tax/forms/[year]/return/page.tsx");
    expect(p).toContain("links={linkContextForSheet(loaded.model)}");
  });
  it("every id the links use is written by the sheet through the shared anchor functions (no hand-written duplicates)", () => {
    for (const fn of ["lineAnchorId(line.key)", "openItemAnchorId(item.id)", "conflictAnchorId(c.factKey)", "decisionAnchorId(d.id)", "homeworkAnchorId(h.id)", "documentAnchorId(d.id)", "formGroupAnchorId(group.form)"]) expect(sheet, fn).toContain(`id={${fn}}`);
    expect(sheet).not.toMatch(/id=\{`line-/);
    for (const k of ["summary", "federal", "connecticut", "decisions", "openItems", "documents", "headlineFederal", "headlineConnecticut", "attestations"]) expect(sheet, k).toContain(`SHEET_ANCHORS.${k}`);
    expect(read("components/tax/forms/overrides-panel.tsx")).toContain("id={SHEET_ANCHORS.overrides}");
  });
});

describe("the Forms page and the questionnaire page carry the anchors the links use", () => {
  it("the Forms page sections and the PDF section have ids; every form card already has its own", () => {
    const p = read("app/tax/forms/[year]/page.tsx");
    for (const k of ["federal", "connecticut", "needsInput", "business"]) expect(p, k).toContain(`id={FORMS_PAGE_ANCHORS.${k}}`);
    expect(read("components/tax/forms/pdf-download-buttons.tsx")).toContain("id={FORMS_PAGE_ANCHORS.pdf}");
    expect(read("components/tax/forms/form-card.tsx")).toMatch(/className=\{`anchor-target [^`]*`\} id=\{entry\.id\}/);
  });
  it("each question is an element with id q-<node id> and the anchor class", () => {
    const r = read("components/tax/forms/questionnaire-runner.tsx");
    expect(r).toContain("id={`q-${node.id}`}");
    expect(r).toMatch(/className=\{`anchor-target rounded-lg border bg-card p-4/);
  });
  it("the highlight component is mounted on the sheet, the Forms page, the questionnaire page and the Final review page", () => {
    for (const f of ["components/tax/forms/return-sheet.tsx", "app/tax/forms/[year]/page.tsx", "app/tax/forms/[year]/questionnaire/[questionnaireId]/page.tsx", PAGE]) expect(read(f), f).toContain("<AnchorHighlight />");
  });
});

describe("scroll offset and highlight", () => {
  const css = read("app/globals.css");
  it("an anchor target leaves room under the header and flashes when it is the target", () => {
    expect(css).toMatch(/\.anchor-target\s*\{\s*scroll-margin-top:\s*6rem;/);
    expect(css).toMatch(/\.anchor-target:target,\s*\.anchor-flash\s*\{[^}]*outline:[^}]*animation: anchor-flash 3s/);
    expect(css).toContain("@keyframes anchor-flash");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toMatch(/@media print\s*\{\s*\.anchor-target:target,\s*\.anchor-flash\s*\{[^}]*outline: none/);
  });
  it("the highlight component finds the fragment's element, scrolls it into view and flashes it, on arrival and on every hash change", () => {
    const src = read("components/tax/anchor-highlight.tsx");
    expect(src.startsWith('"use client";')).toBe(true);
    expect(src).toContain("document.getElementById(id)");
    expect(src).toContain("scrollIntoView");
    expect(src).toContain('classList.add("anchor-flash")');
    expect(src).toContain('addEventListener("hashchange", apply)');
    expect(src).toContain('removeEventListener("hashchange", apply)');
    expect(src).toContain("decodeURIComponent");
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});

describe("the gate's 'Jump to' filters the findings table", () => {
  it("the fragment grammar is read by one pure function", () => {
    expect(filtersFromHash(`#${FINDINGS_HASH.gating}`)).toEqual({ status: "gating", layer: "all" });
    expect(filtersFromHash(`#${FINDINGS_HASH.gatingL1}`)).toEqual({ status: "gating", layer: "L1" });
    expect(filtersFromHash(`#${FINDINGS_HASH.gatingL2}`)).toEqual({ status: "gating", layer: "L2" });
    expect(filtersFromHash(`#${FINDINGS_HASH.gatingL3}`)).toEqual({ status: "gating", layer: "L3" });
    expect(filtersFromHash(`#${FINDINGS_HASH.all}`)).toEqual({ status: "all", layer: "all" });
    expect(filtersFromHash("findings-gating")).toEqual({ status: "gating", layer: "all" });
    for (const bad of ["", "#", "#review-findings", "#findings-gating-l4", "#findings-gating-l1x", "#findings-open", "#line-scha-8a", "javascript:alert(1)", "#findings-all-l1"]) expect(filtersFromHash(bad), bad).toBeNull();
  });

  it("the layer filter keeps only that layer's findings and leaves existing filters untouched", () => {
    const f = (layer: "L1" | "L2" | "L3", gating: boolean): FindingDto =>
      ({ key: "k".repeat(16), evidenceHash: "e".repeat(16), layer, check: "c", severity: "medium", area: "process", formKey: null, lineKey: null, message: "m", evidence: [], citation: { sources: [], sourceStatus: "not_applicable" }, recommendedAction: "a", acceptable: true, status: "open", gating, acceptedReason: null, acceptedBy: null, acceptedAt: null }) as FindingDto;
    const all = [f("L1", true), f("L1", false), f("L2", true), f("L3", true)];
    expect(filterFindings(all, { ...DEFAULT_FILTERS, status: "gating", layer: "L1" })).toHaveLength(1);
    expect(filterFindings(all, { ...DEFAULT_FILTERS, status: "gating", layer: "all" })).toHaveLength(3);
    expect(filterFindings(all, { ...DEFAULT_FILTERS, layer: "L2" })).toHaveLength(1);
    expect(filterFindings(all, DEFAULT_FILTERS)).toHaveLength(4);
    expect(filterFindings(all, { severities: [], area: "all", status: "all", text: "" })).toHaveLength(4); // the filter object without a layer still works
  });

  it("the findings table applies the jump on arrival, on the link's event and on hash changes, then scrolls to itself; only the page's main list listens", () => {
    const t = read(`${DIR}/findings-table.tsx`);
    expect(t).toContain("filtersFromHash(hash)");
    expect(t).toContain("apply(window.location.hash)");
    expect(t).toContain("window.addEventListener(REVIEW_FILTER_EVENT, onEvent)");
    expect(t).toContain('window.addEventListener("hashchange", onHash)');
    expect(t).toContain("removeEventListener(REVIEW_FILTER_EVENT, onEvent)");
    expect(t).toContain("document.getElementById(REVIEW_ANCHORS.findings)?.scrollIntoView");
    expect(t).toContain("if (!listenForJumps) return;");
    expect(t).toContain("Layer {filters.layer} only");
    // the link tells the table even when the fragment does not change
    const l = read(`${DIR}/finding-links.tsx`);
    expect(l).toContain("window.dispatchEvent(new CustomEvent(REVIEW_FILTER_EVENT");
    expect(REVIEW_FILTER_EVENT).toBe("tax-review:filter");
  });

  it("the gate decides nothing here: no gate or approval module is imported by the links code", () => {
    const imports = (f: string): string[] => [...read(f).matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1] ?? "");
    for (const f of ["lib/tax-review/links.ts", "lib/tax-review/links-context.ts", `${DIR}/finding-links.tsx`]) {
      for (const spec of imports(f)) expect(spec, `${f} imports ${spec}`).not.toMatch(/tax-review\/(gate|approver|state|fingerprint)|tax-return-approval|tax-review-store/);
    }
  });
});
