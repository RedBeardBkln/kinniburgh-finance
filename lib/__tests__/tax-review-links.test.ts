import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { ct1040Geometry } from "@/lib/tax2025/pdf/ct-overlay";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { LINE_KEYS } from "@/lib/tax2025/line-catalog";
import { buildSheetModel } from "@/lib/tax2025-sheet";
import { FINDING_AREAS } from "@/lib/tax-review/types";
import { findOwnerBannedWording } from "@/lib/tax-wording";
import { FOOTING_RULES } from "@/lib/tax-review/l1/footing-rules";
import { TASKS } from "@/lib/tax-review/llm/tasks";
import { INFO_CARDS } from "@/lib/tax-review/info-cards";
import { BY_HAND } from "@/lib/tax2025/pdf/final-package";
import { anchorSlug, conflictAnchorId, decisionAnchorId, lineAnchorId, openItemAnchorId } from "@/lib/tax-anchors";
import {
  AREA_FALLBACK,
  BY_HAND_TARGETS,
  EMPTY_LINK_CONTEXT,
  FINDINGS_HASH,
  INFO_TARGETS,
  LINK_RULES,
  OPEN_ITEM_RULES,
  SECTION_KEYS,
  SPEC09_TARGETS,
  byHandLinks,
  conflictLinks,
  findingLinks,
  fnv1a,
  gateLinks,
  infoLinks,
  isSafeLinkHref,
  linkRuleFor,
  openItemLinks,
  openItemRuleFor,
  registerLinks,
  sectionLink,
  type FindingLink,
  type LinkContext,
  type LinkableFinding,
} from "@/lib/tax-review/links";
import { buildLinkContext } from "@/lib/tax-review/links-context";
import { loadCatalogs } from "./tax-review-harness";
import { emptyFacts, fullFacts, fullFacts1b } from "./tax2025-fixtures";

const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const NOW = new Date("2026-10-05T12:00:00Z");

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";

/** A small hand-made context: every kind of target exists, so each rule can be driven precisely. */
const CTX: LinkContext = {
  year: 2025,
  sheetLines: { "scha.8a": "Schedule A line 8a", "f1040.9": "Form 1040 line 9", "f1040.2b": "Form 1040 line 2b", "ct1040.6": "CT-1040 line 6", "schc.28": "Schedule C line 28", "schc.7": "Schedule C line 7" },
  decisions: { X1: { label: "Home office method", recorded: false }, X5: { label: "Tax on non-primary real estate", recorded: true } },
  openItems: { "rule:scha.itemize": fnv1a("Schedule A needs the property tax paid."), "doc-unverified:abc": fnv1a("A document is unverified.") },
  conflicts: [conflictAnchorId("income.interest.books")],
  documents: { [DOC_A]: "W-2 2025", [DOC_B]: "1099 2025" },
  forms: {
    f1040sa: { label: "Schedule A", pdf: "f1040sa", card: "schedule-a", group: "form-schedule-a" },
    scha: { label: "Schedule A", pdf: "f1040sa", card: "schedule-a", group: "form-schedule-a" },
    f1040: { label: "Form 1040", pdf: "f1040", card: "form-1040", group: "form-form-1040" },
    ct1040: { label: "CT-1040", pdf: "ct1040", card: "ct-1040", group: "form-ct-1040" },
    f8949: { label: "Form 8949", pdf: "f8949", card: null, group: null },
    f6251: { label: "Form 6251", pdf: null, card: null, group: null },
  },
  linePdf: { "scha.8a": "f1040sa:1", "f1040.9": "f1040:1", "f1040.37": "f1040:2", "ct1040.6": "ct1040:2", "f1040.35a": "f1040:2" },
  fieldPages: { "f1040|Page2[0].f2_3[0]": 2 },
  signaturePages: { f1040: 2, ct1040: 3 },
  ruleLines: { "scha.itemize": ["scha.8a"] },
};

function finding(check: string, extra: Partial<LinkableFinding> = {}): LinkableFinding {
  return { check, area: "forms", message: "m", evidence: [], ...extra };
}
const ev = (...refs: string[]) => refs.map((ref) => ({ ref }));
const hrefs = (links: readonly FindingLink[]): string[] => links.map((l) => l.href);

// ── the real context (the engine's own return, the real maps and catalogs) ─────

const RET = computeTy2025Return(fullFacts());
const REAL_MODEL = buildSheetModel({ ret: RET, documents: [], now: NOW });
const REAL = buildLinkContext({ model: REAL_MODEL, ret: RET, maps: FORM_MAPS, catalogs: loadCatalogs() });

// ── static scan of every check id the layers can emit ─────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(resolve(ROOT, dir))) {
    const p = join(dir, name);
    if (statSync(resolve(ROOT, p)).isDirectory()) sourceFiles(p, out);
    else if (p.endsWith(".ts")) out.push(p.replace(/\\/g, "/"));
  }
  return out;
}

/** Every string / template literal in lib/tax-review that looks like a finding check id ("L1.B1.money", `L1.F1.${rule.id}`, "L2.coverage" ...). */
function checkIdsInSource(): string[] {
  const ids = new Set<string>();
  for (const f of sourceFiles("lib/tax-review")) {
    const src = read(f);
    for (const m of src.matchAll(/(["'`])(L[123]\.[A-Za-z0-9_.${}\-\[\]]*)\1/g)) {
      const raw = m[2] ?? "";
      const id = raw.replace(/\$\{[^}]*\}/g, "x");
      if (/^L[123]\.[A-Z]\d$/.test(id)) continue; // a check MODULE id (L1.B1), not a finding's check id
      if (/^L1\.[A-Z]\d\.\.\.$/.test(id)) continue;
      ids.add(id.endsWith(".") ? `${id}x` : id);
    }
  }
  return [...ids].sort();
}

describe("coverage guard: every check id has a link rule", () => {
  const ids = checkIdsInSource();

  it("the scan is not vacuous", () => {
    expect(ids.length).toBeGreaterThan(80);
    expect(ids).toContain("L1.B1.money");
    expect(ids).toContain("L2.coverage");
    expect(ids).toContain("L1.runner.check-failed");
  });

  it("every check id literal in lib/tax-review matches an explicit rule (a new check cannot ship without a link decision)", () => {
    const missing = ids.filter((id) => !linkRuleFor(id).explicit);
    expect(missing, `check ids with no rule in LINK_RULES: ${missing.join(", ")}`).toEqual([]);
  });

  it("every concrete id the layers expand from a template has a rule: footing rules, L3 pass x category, headline rows, reasonableness ratios", () => {
    const concrete: string[] = [
      ...FOOTING_RULES.map((r) => `L1.F1.${r.id}`),
      ...TASKS.flatMap((t) => (t.kind === "register" ? [] : [...t.categories, "other"].map((c) => `L3.${t.pass}.${c}`))),
      ...["federal.agi", "federal.totalTax", "connecticut.tax"].map((k) => `L2.diff.head.${k}`),
      ...LINE_KEYS.map((k) => `L2.diff.${k}`),
      ...["effective-rate", "se-ratio", "expense-ratio", "meals-ratio", "charity-ratio", "withholding-ratio", "ct-ratio", "niit-ratio", "itemize-margin"].map((r) => `L1.E2.${r}`),
      ...["w2-box1", "w2-box2", "w2-box3-7", "int", "div-ordinary", "1099-withholding", "1098-interest", "fed-estimates", "ct-estimates"].map((t) => `L1.C1.${t}`),
      ...["dup-w2", "dup-1099"].map((t) => `L1.C2.${t}`),
      ...["f1040", "f8959", "schb"].map((f) => `L2.forms.${f}`),
      "L1.F2.headline.federal-agi",
    ];
    expect(concrete.length).toBeGreaterThan(150);
    const missing = concrete.filter((id) => !linkRuleFor(id).explicit);
    expect(missing).toEqual([]);
  });

  it("the guard has teeth: an unknown family is reported as not explicit (and still gets the area fallback)", () => {
    expect(linkRuleFor("L1.Z9.brand-new").explicit).toBe(false);
    expect(linkRuleFor("L4.anything").explicit).toBe(false);
    const links = findingLinks(finding("L1.Z9.brand-new", { area: "process" }), EMPTY_LINK_CONTEXT);
    expect(links.length).toBe(1);
  });

  it("every rule has a note and is reachable (no rule is shadowed by an earlier one for its own sample)", () => {
    for (const r of LINK_RULES) expect(r.note.length).toBeGreaterThan(10);
    expect(new Set(LINK_RULES.map((r) => String(r.match))).size).toBe(LINK_RULES.length);
  });

  it("every finding area has a fallback section and a finding with no data gets a safe link in it", () => {
    for (const area of FINDING_AREAS) {
      expect(AREA_FALLBACK[area], area).toBeDefined();
      const links = findingLinks(finding("L1.Z9.none", { area }), EMPTY_LINK_CONTEXT);
      expect(links, area).toHaveLength(1);
      expect(isSafeLinkHref(links[0]?.href ?? ""), area).toBe(true);
    }
  });
});

// ── findingLinks, rule by rule (small context, exact expectations) ─────────────

describe("findingLinks maps finding data to the right place", () => {
  it("a line: the sheet row anchor, then the form PDF on its page, then the Forms page card", () => {
    const links = findingLinks(finding("L1.E2.expense-ratio", { lineKey: "scha.8a", formKey: "f1040sa", area: "deductions", evidence: ev("scha.8a") }), CTX);
    expect(hrefs(links)).toEqual(["/tax/forms/2025/return#line-scha-8a", "/api/tax/forms/2025/pdf/f1040sa?view=1", "/tax/forms/2025#schedule-a"]);
    expect(links[0]?.label).toBe("Open on the review sheet: Schedule A line 8a");
    expect(links[1]?.label).toBe("Open the form: Schedule A (PDF)");
    expect(links[1]?.newTab).toBe(true);
    expect(links[0]?.newTab).toBe(false);
  });

  it("the PDF link carries #page=N when the line is on a later page, and nothing for page 1", () => {
    const p2 = findingLinks(finding("L1.F1.f1040.37", { lineKey: "f1040.37", evidence: ev("f1040.37") }), CTX);
    expect(hrefs(p2)).toContain("/api/tax/forms/2025/pdf/f1040?view=1#page=2");
    expect(p2.find((l) => l.kind === "pdf")?.label).toBe("Open the form: Form 1040 (PDF, page 2)");
    const p1 = findingLinks(finding("L1.F1.f1040.9", { lineKey: "f1040.9", evidence: ev("f1040.9") }), CTX);
    expect(hrefs(p1).some((h) => h.includes("#page="))).toBe(false);
  });

  it("a named PDF field decides the page (L1.B2 stray ink on page 2) even without a line", () => {
    const links = findingLinks(finding("L1.B2.stray", { formKey: "f1040", evidence: ev("pdf:f1040:Page2[0].f2_3[0]") }), CTX);
    expect(hrefs(links)).toContain("/api/tax/forms/2025/pdf/f1040?view=1#page=2");
  });

  it("a form key from the engine (scha) and from the PDF maps (f1040sa) reach the same form", () => {
    const a = findingLinks(finding("L1.G1.not-emitted", { formKey: "scha" }), CTX);
    const b = findingLinks(finding("L1.B5.unmodeled", { formKey: "f1040sa" }), CTX);
    expect(hrefs(a)).toContain("/api/tax/forms/2025/pdf/f1040sa?view=1");
    expect(hrefs(b)).toContain("/api/tax/forms/2025/pdf/f1040sa?view=1");
    // no line: the form's own block on the review sheet
    expect(hrefs(a)).toContain("/tax/forms/2025/return#form-schedule-a");
  });

  it("a form the app has no PDF for still gets its card or the PDF section, never a PDF link", () => {
    const links = findingLinks(finding("L1.G1.no-pdf", { formKey: "f6251", area: "forms" }), CTX);
    expect(links.some((l) => l.kind === "pdf")).toBe(false);
    expect(hrefs(links)).toContain("/tax/forms/2025#filled-pdf-forms");
  });

  it("L1.D2.decision: Record this decision (undecided) / Change this decision (recorded) on the sheet's decision card", () => {
    const x1 = findingLinks(finding("L1.D2.decision", { area: "process", evidence: ev("check:decision.X1") }), CTX);
    expect(x1[0]).toMatchObject({ kind: "decision", href: "/tax/forms/2025/return#decision-x1" });
    expect(x1[0]?.label).toMatch(/^Record this decision: X1 /);
    const x5 = findingLinks(finding("L1.D2.decision", { area: "process", evidence: ev("check:decision.X5") }), CTX);
    expect(x5[0]?.label).toMatch(/^Change this decision: X5 /);
    expect(x5[0]?.href).toBe("/tax/forms/2025/return#decision-x5");
    // a decision the sheet does not show is not linked (no dead anchor)
    const none = findingLinks(finding("L1.D2.decision", { area: "process", evidence: ev("check:decision.X9") }), CTX);
    expect(none.some((l) => l.kind === "decision")).toBe(false);
    expect(none.length).toBeGreaterThan(0);
  });

  it("L1.D2.header-answer / L1.B4.answer: the exact question of the Return completeness questionnaire", () => {
    const d = findingLinks(finding("L1.D2.header-answer", { area: "process", evidence: ev("check:answer.digital-assets") }), CTX);
    expect(hrefs(d)).toContain("/tax/forms/2025/questionnaire/return-completeness#q-digital");
    const f = findingLinks(finding("L1.D2.header-answer", { area: "process", evidence: ev("check:answer.foreign-accounts") }), CTX);
    expect(hrefs(f)).toContain("/tax/forms/2025/questionnaire/return-completeness#q-foreign");
    const b4 = findingLinks(finding("L1.B4.answer", { evidence: ev("check:answer.foreignTrust") }), CTX);
    expect(hrefs(b4)).toContain("/tax/forms/2025/questionnaire/return-completeness#q-foreign");
    const other = findingLinks(finding("L1.B4.answer", { evidence: ev("check:answer.filingStatus") }), CTX);
    expect(hrefs(other)).toContain("/tax/forms/2025/questionnaire/return-completeness");
  });

  it("documents: Open the document for a real document id; an id the return does not use is not linked", () => {
    const links = findingLinks(finding("L1.C1.doc-not-reflected", { area: "income", evidence: ev(`doc:${DOC_A}`, `doc:${DOC_B}`, "doc:33333333-3333-4333-8333-333333333333", "doc:alias1") }), CTX);
    expect(hrefs(links)).toEqual(expect.arrayContaining([`/documents/${DOC_A}/review`, `/documents/${DOC_B}/review`]));
    expect(hrefs(links).filter((h) => h.startsWith("/documents/"))).toHaveLength(2);
    expect(links.find((l) => l.href.includes(DOC_A))?.label).toBe("Open the document: W-2 2025");
    expect(hrefs(links)).toContain("/documents?view=tax&year=2025");
  });

  it("L1.D1.blocking-item: the open item's row on the sheet (from the item text, or the rule tag when present)", () => {
    const byText = findingLinks(finding("L1.D1.blocking-item", { area: "process", message: "Blocking item (Schedule A): Schedule A needs the property tax paid." }), CTX);
    expect(hrefs(byText)[0]).toBe(`/tax/forms/2025/return#${openItemAnchorId("rule:scha.itemize")}`);
    const byTag = findingLinks(finding("L1.D1.blocking-item", { area: "process", ruleTag: "doc-unverified:abc", message: "Blocking item (x): something else" }), CTX);
    expect(hrefs(byTag)[0]).toBe(`/tax/forms/2025/return#${openItemAnchorId("doc-unverified:abc")}`);
    const unknown = findingLinks(finding("L1.D1.blocking-item", { area: "process", message: "Blocking item (x): not on the sheet" }), CTX);
    expect(hrefs(unknown)).toEqual(["/tax/forms/2025/return#part-5"]);
  });

  it("L1.D2.conflict: the conflict's block on the sheet", () => {
    const links = findingLinks(finding("L1.D2.conflict", { area: "process", evidence: ev("check:conflict.income.interest.books") }), CTX);
    expect(hrefs(links)[0]).toBe("/tax/forms/2025/return#conflict-income-interest-books");
  });

  it("L1.D3 overrides, L1.D1.incomplete, L1.D5.cover and headline findings land on the sheet's named blocks", () => {
    expect(hrefs(findingLinks(finding("L1.D3.stale", { area: "process" }), CTX))).toContain("/tax/forms/2025/return#overrides");
    expect(hrefs(findingLinks(finding("L1.D1.incomplete", { area: "process" }), CTX))).toEqual(expect.arrayContaining(["/tax/forms/2025/return#part-1", "/tax/forms/2025/return#part-5"]));
    expect(hrefs(findingLinks(finding("L1.D5.cover", { area: "packaging", evidence: ev("head:Federal AGI") }), CTX))).toContain("/tax/forms/2025/return#part-1");
    expect(hrefs(findingLinks(finding("L2.diff.head.federal.agi", { area: "tax", evidence: ev("head:federal.agi", "f1040.9") }), CTX))).toEqual(expect.arrayContaining(["/tax/forms/2025/return#headline-federal", "/tax/forms/2025/return#line-f1040-9"]));
    expect(hrefs(findingLinks(finding("L2.diff.head.connecticut.tax", { area: "state", evidence: ev("head:connecticut.tax") }), CTX))).toContain("/tax/forms/2025/return#headline-connecticut");
  });

  it("the by-hand and gate-related families jump inside the Final review page", () => {
    expect(hrefs(findingLinks(finding("L1.G2.by-hand", { area: "packaging" }), CTX))).toContain("#review-byhand");
    expect(hrefs(findingLinks(finding("L2.coverage", { area: "process" }), CTX))).toContain("#review-gate");
    expect(hrefs(findingLinks(finding("L1.runner.check-failed", { area: "process" }), CTX))).toContain("#run-checks");
  });

  it("a fixed line for a finding that names none (books interest on a 1099)", () => {
    const links = findingLinks(finding("L1.C2.books-interest", { area: "income" }), CTX);
    expect(hrefs(links)).toContain("/tax/forms/2025/return#line-f1040-2b");
  });

  it("a Connecticut line that is not on the sheet falls back to the Connecticut part, a federal one to the federal part", () => {
    const ct = findingLinks(finding("L2.diff.ct1040.99", { area: "state", lineKey: "ct1040.99" }), { ...CTX, linePdf: { ...CTX.linePdf, "ct1040.99": "ct1040:2" } });
    expect(hrefs(ct)).toContain("/tax/forms/2025/return#part-3");
    const fed = findingLinks(finding("L2.diff.f1040.99", { area: "tax", lineKey: "f1040.99" }), { ...CTX, linePdf: { ...CTX.linePdf, "f1040.99": "f1040:1" } });
    expect(hrefs(fed)).toContain("/tax/forms/2025/return#part-2");
  });

  it("a finding with several lines shows at most three rows and never more than eight links in all", () => {
    const keys = Object.keys(CTX.sheetLines);
    const links = findingLinks(finding("L1.D1.blocked-lines", { area: "process", evidence: ev(...keys) }), CTX);
    expect(links.filter((l) => l.kind === "sheet" && l.href.includes("#line-"))).toHaveLength(3);
    expect(links.length).toBeLessThanOrEqual(8);
  });

  it("every label is owner-facing: it passes the wording scan (no CPA, no certification claims) and says what the link does", () => {
    const labels = new Set<string>(SECTION_KEYS.map((k) => sectionLink(k).label));
    for (const rule of LINK_RULES) {
      const id = typeof rule.match === "string" ? `${rule.match}x` : rule.match.source.replace(/^\^/, "").replace(/\\\./g, ".").replace(/\(([^)|]+)[^)]*\)/g, "$1").replace(/[$\\]/g, "") + "x";
      const f = finding(id, { area: "deductions", lineKey: "scha.8a", formKey: "f1040sa", evidence: ev("scha.8a", `doc:${DOC_A}`, "check:decision.X1", "check:answer.digital-assets", "check:conflict.income.interest.books", "head:federal.agi", "pdf:f1040:Page2[0].f2_3[0]"), message: "Blocking item (Schedule A): Schedule A needs the property tax paid." });
      for (const l of findingLinks(f, CTX)) labels.add(l.label);
    }
    for (const t of BY_HAND) for (const l of byHandLinks(t, REAL)) labels.add(l.label);
    for (const c of INFO_CARDS) for (const s of c.statements) for (const l of infoLinks(s.id, REAL)) labels.add(l.label);
    for (const id of ["decision:X1", "rule:scha.itemize", "answer:x", "info:scha.8a", ...Object.keys(SPEC09_TARGETS).map((k) => `spec09:${k}`)]) for (const l of registerLinks({ id }, CTX)) labels.add(l.label);
    expect(labels.size).toBeGreaterThan(25);
    for (const label of labels) {
      expect(findOwnerBannedWording(label), label).toEqual([]);
      expect(label, label).toMatch(/^(Open|Answer|Record|Change|Jump to|Upload)\b/);
      expect(label, label).not.toMatch(/\bCPA\b|certif|approved by|undefined|null/i);
    }
  });

  it("every link is labelled in plain words and passes the safe-href check", () => {
    const sample = [
      finding("L1.E2.expense-ratio", { lineKey: "scha.8a", evidence: ev("scha.8a") }),
      finding("L1.D2.decision", { area: "process", evidence: ev("check:decision.X1") }),
      finding("L1.C1.w2-box1", { area: "income", lineKey: "f1040.9", evidence: ev("f1040.9", `doc:${DOC_A}`) }),
      finding("L1.B6.final-package", { area: "packaging" }),
    ];
    for (const f of sample) {
      for (const l of findingLinks(f, CTX)) {
        expect(isSafeLinkHref(l.href), l.href).toBe(true);
        expect(l.label, l.href).toMatch(/^(Open|Answer|Record|Change|Jump|Upload)/);
        expect(l.label).not.toMatch(/\bCPA\b|undefined|null|\[object/);
      }
    }
  });
});

describe("hostile input cannot reach an href", () => {
  const evil = [`javascript:alert(1)`, `"><script>alert(1)</script>`, `/../../etc/passwd`, `data:text/html;base64,AAAA`, `//evil.example/x`, `x" onmouseover="alert(1)`, "__proto__", "constructor", "toString", `${DOC_A}"><img src=x>`];

  it("text in the message, the rule tag, the form key, the line key, the area and the evidence never appears in a link", () => {
    for (const bad of evil) {
      const f: LinkableFinding = {
        check: `L1.B1.${bad}`,
        area: bad,
        formKey: bad,
        lineKey: bad,
        ruleTag: bad,
        message: `Blocking item (${bad}): ${bad}`,
        evidence: ev(bad, `doc:${bad}`, `form:${bad}`, `pdf:${bad}:${bad}`, `sheet:${bad}`, `csv:${bad}`, `check:decision.${bad}`, `check:conflict.${bad}`, `check:answer.${bad}`, `head:${bad}`),
      };
      const links = findingLinks(f, CTX);
      expect(links.length).toBeGreaterThan(0);
      for (const l of links) {
        expect(isSafeLinkHref(l.href), `${bad} -> ${l.href}`).toBe(true);
        expect(l.href).not.toMatch(/javascript|script|<|>|"|\s|\.\.|\/\/(?!$)/i);
        expect(l.label).not.toMatch(/[<>"]|javascript/i);
      }
    }
  });

  it("a hostile document label or decision label from the context is text only: it is cleaned and never part of an href", () => {
    const ctx: LinkContext = { ...CTX, documents: { [DOC_A]: `<script>alert(1)</script>\n"x"` }, decisions: { X1: { label: `<img src=x onerror=alert(1)>`, recorded: false } } };
    const links = findingLinks(finding("L1.C1.doc-not-reflected", { area: "income", evidence: ev(`doc:${DOC_A}`, "check:decision.X1") }), ctx);
    for (const l of links) {
      expect(l.label).not.toMatch(/[<>"\n]/);
      expect(isSafeLinkHref(l.href)).toBe(true);
    }
  });

  it("a prototype key never resolves to a form, a document or a decision", () => {
    for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const links = findingLinks(finding("L1.B5.unmodeled", { formKey: k, evidence: ev(`form:${k}`, `doc:${k}`, `check:decision.${k}`) }), CTX);
      expect(links.some((l) => l.kind === "pdf" || l.kind === "decision")).toBe(false);
    }
  });

  it("isSafeLinkHref accepts only the fixed route shapes", () => {
    for (const ok of [
      "/tax/forms/2025/return#line-scha-8a",
      "/tax/forms/2025#schedule-a",
      "/tax/forms/2025/final-review",
      "/tax/forms/2025/questionnaire/return-completeness#q-digital",
      `/documents/${DOC_A}/review`,
      "/documents?view=tax&year=2025",
      "/api/tax/forms/2025/pdf/f1040sa?view=1#page=2",
      "/business/ek-consulting/gl",
      "#review-findings",
    ])
      expect(isSafeLinkHref(ok), ok).toBe(true);
    for (const bad of [
      "javascript:alert(1)",
      "//evil.example",
      "https://evil.example/",
      "/tax/forms/2025/return#a b",
      "/tax/forms/2025/return#x\"",
      "/api/tax/forms/2025/pdf/../../x?view=1",
      "/api/tax/forms/2024/pdf/f1040?view=1",
      "/documents/not-a-uuid/review",
      "/business/other/gl",
      "/tax/forms/2025/return?x=1",
      "data:text/html,x",
      "",
    ])
      expect(isSafeLinkHref(bad), bad).toBe(false);
  });
});

// ── anchors: the one slug function ────────────────────────────────────────────

describe("anchors", () => {
  it("every line key of the catalog gets a distinct, URL-safe id (line-<slug>)", () => {
    const ids = LINE_KEYS.map((k) => lineAnchorId(k));
    expect(new Set(ids).size).toBe(LINE_KEYS.length);
    for (const id of ids) expect(id).toMatch(/^line-[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(lineAnchorId("scha.8a")).toBe("line-scha-8a");
    expect(lineAnchorId("ct1040.ctAgi")).toBe("line-ct1040-ctagi");
  });

  it("the link fragment of every line on the sheet equals the id the sheet row carries (same function on both sides)", () => {
    const keys = Object.keys(REAL.sheetLines);
    expect(keys.length).toBeGreaterThan(100);
    for (const k of keys) {
      const links = findingLinks(finding("L1.E2.x", { area: "tax", lineKey: k, evidence: ev(k) }), REAL);
      expect(links[0]?.href, k).toBe(`/tax/forms/2025/return#${lineAnchorId(k)}`);
    }
    expect(read("components/tax/forms/return-sheet.tsx")).toContain("id={lineAnchorId(line.key)}");
  });

  it("slugs are lower-case, dash-separated, never empty and bounded", () => {
    expect(anchorSlug("Schedule 1-A")).toBe("schedule-1-a");
    expect(anchorSlug("rule:scha.itemize")).toBe("rule-scha-itemize");
    expect(anchorSlug("")).toBe("x");
    expect(anchorSlug("!!!")).toBe("x");
    expect(anchorSlug("a".repeat(500)).length).toBeLessThanOrEqual(100);
    expect(decisionAnchorId("X1")).toBe("decision-x1");
  });
});

// ── the real context: pages come from the maps and the catalogs ───────────────

describe("the real link context", () => {
  const catalogs = loadCatalogs();

  it("every money line a map prints has a page, equal to the page of the FIRST field that prints it on its form (catalog page + 1; the CT-1040 uses its overlay geometry)", () => {
    let checked = 0;
    for (const m of FORM_MAPS) {
      const cat = catalogs[m.formId];
      const seen = new Set<string>();
      for (const e of m.lines) {
        if (e.kind !== "money") continue;
        const key = String(e.line);
        // the CT-1040 is a flat printed form: its fields are the overlay boxes of the calibrated geometry, not AcroForm fields
        const field = m.formId === "ct1040" ? ct1040Geometry().fields.find((f) => f.name === e.field) : cat?.fields.find((f) => f.name === e.field);
        expect(field, `${m.formId} ${e.field}`).toBeDefined();
        const v = REAL.linePdf[key];
        expect(v, `${m.formId} ${key}`).toBeDefined();
        const [form, page] = (v ?? ":").split(":");
        // a line printed on several forms keeps one (its own form, else the first); a line printed twice on one form keeps its first page
        if (form === m.formId && !seen.has(key)) expect(Number(page), `${m.formId} ${key}`).toBe((field?.page ?? 0) + 1);
        seen.add(key);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it("known pages: Schedule A 8a is on page 1, Form 1040 line 37 and the signature boxes are on page 2", () => {
    expect(REAL.linePdf["scha.8a"]).toBe("f1040sa:1");
    expect(REAL.linePdf["f1040.37"]).toBe("f1040:2");
    expect(REAL.linePdf["f1040.35a"]).toBe("f1040:2");
    expect(REAL.signaturePages["f1040"]).toBe(2);
    const links = findingLinks(finding("L1.F1.f1040.37", { lineKey: "f1040.37", evidence: ev("f1040.37") }), REAL);
    expect(hrefs(links)).toContain("/api/tax/forms/2025/pdf/f1040?view=1#page=2");
  });

  it("every registered form can be named, and every card id it points at exists on the Forms page", () => {
    const tf = read("lib/tax-forms.ts");
    for (const m of FORM_MAPS) {
      expect(REAL.forms[m.formId], m.formId).toBeDefined();
      expect(REAL.forms[m.formId]?.pdf).toBe(m.formId);
      if (m.engineFormId !== undefined) expect(REAL.forms[m.engineFormId]?.pdf, m.engineFormId).toBe(m.formId);
    }
    for (const info of Object.values(REAL.forms)) if (info.card !== null) expect(tf, info.card).toContain(`id: "${info.card}"`);
    // the Forms page card carries its own id
    expect(read("components/tax/forms/form-card.tsx")).toContain("id={entry.id}");
  });

  it("fieldPages only lists fields beyond page 1 and every entry is 2 or more", () => {
    const pages = Object.values(REAL.fieldPages);
    expect(pages.length).toBeGreaterThan(50);
    for (const p of pages) expect(p).toBeGreaterThanOrEqual(2);
  });

  it("the context is plain JSON of a sensible size (it travels to the browser)", () => {
    const json = JSON.stringify(REAL);
    expect(JSON.parse(json)).toEqual(REAL);
    expect(json.length).toBeLessThan(120_000);
  });

  it("the sheet's decisions: Change this decision once a choice is recorded", () => {
    for (const d of REAL_MODEL.decisions) expect(REAL.decisions[d.id]?.recorded).toBe(d.override !== null);
  });
});

// ── register, by hand, information statements, gate ───────────────────────────

describe("register, by-hand items, information statements and the gate", () => {
  it("register entries: decisions, rules, answers, informational lines and unverified-law items each get a link", () => {
    expect(hrefs(registerLinks({ id: "decision:X1" }, CTX))).toEqual(["/tax/forms/2025/return#decision-x1"]);
    expect(registerLinks({ id: "decision:X5" }, CTX)[0]?.label).toMatch(/^Change this decision: X5/);
    expect(hrefs(registerLinks({ id: "rule:scha.itemize" }, CTX))).toContain("/tax/forms/2025/return#line-scha-8a");
    expect(hrefs(registerLinks({ id: "answer:people[a].tips" }, CTX))).toEqual(["/tax/forms/2025/questionnaire/return-completeness"]);
    expect(hrefs(registerLinks({ id: "info:scha.8a" }, CTX))).toContain("/tax/forms/2025/return#line-scha-8a");
    for (const id of Object.keys(SPEC09_TARGETS)) expect(registerLinks({ id: `spec09:${id}` }, CTX).length, id).toBeGreaterThan(0);
    // an unknown entry still has somewhere to go
    expect(registerLinks({ id: "mystery:1" }, CTX)).toHaveLength(1);
  });

  it("every 'not verified in specs/09' register item has a target (pinned against the register's own list)", () => {
    const src = read("lib/tax-review/llm/register.ts");
    const ids = [...src.matchAll(/^\s+id: "([a-z0-9_]+)",\n\s+topic:/gm)].map((m) => m[1] ?? "");
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (const id of ids) expect(SPEC09_TARGETS[id], id).toBeDefined();
  });

  it("every 'To do by hand' entry has a target rule or an explicit 'nothing to open' (a new entry fails here)", () => {
    for (const t of BY_HAND) {
      const hit = BY_HAND_TARGETS.find((x) => x.match.test(t));
      expect(hit, t).toBeDefined();
    }
    const real = BY_HAND.map((t) => byHandLinks(t, REAL));
    // the signature / PIN / occupation items open the page that carries them
    expect(hrefs(byHandLinks(BY_HAND.find((t) => t.startsWith("Signatures")) ?? "", REAL))).toContain("/api/tax/forms/2025/pdf/f1040?view=1#page=2");
    // lines 35a and 36 of Form 1040: the rows on the sheet where the engine has them, and the printed page
    const refund = byHandLinks(BY_HAND.find((t) => t.startsWith("Form 1040 lines 35a")) ?? "", REAL);
    expect(hrefs(refund)).toContain("/api/tax/forms/2025/pdf/f1040?view=1#page=2");
    expect(real.filter((l) => l.length > 0).length).toBeGreaterThanOrEqual(BY_HAND.length - 1);
  });

  it("every information-card statement is listed (a link or an explicit 'no target')", () => {
    for (const c of INFO_CARDS) for (const s of c.statements) expect(Object.prototype.hasOwnProperty.call(INFO_TARGETS, s.id), s.id).toBe(true);
    expect(hrefs(infoLinks("fed_8949_statement", REAL))).toContain("/api/tax/forms/2025/pdf/f8949?view=1");
    expect(infoLinks("amend", REAL)).toEqual([]);
    expect(infoLinks("not-a-statement", REAL)).toEqual([]);
  });

  it("the gate: each row that is not green says where to go; a green row has none", () => {
    const items = [
      { id: "fingerprint", state: "fail" as const, detail: "stale" },
      { id: "engine", state: "fail" as const, detail: "2 blocking item(s); 1 line override(s) in force" },
      { id: "l1", state: "fail" as const, detail: "1 open item(s) that block approval" },
      { id: "l2", state: "not_run" as const, detail: "not run" },
      { id: "l3", state: "not_run" as const, detail: "not run" },
      { id: "verdict", state: "fail" as const, detail: "AI review: FLAGGED" },
      { id: "x", state: "pass" as const, detail: "" },
    ];
    const open = [
      { ...finding("L1.D2.decision", { area: "process", evidence: ev("check:decision.X1") }), status: "open" as const, gating: true, layer: "L1" },
      { ...finding("L1.D2.header-answer", { area: "process", evidence: ev("check:answer.digital-assets") }), status: "open" as const, gating: true, layer: "L1" },
      { ...finding("L1.D1.blocking-item", { area: "process", message: "Blocking item (Schedule A): Schedule A needs the property tax paid." }), status: "open" as const, gating: true, layer: "L1" },
      { ...finding("L1.D2.decision", { area: "process", evidence: ev("check:decision.X5") }), status: "accepted" as const, gating: false, layer: "L1" },
    ];
    const g = gateLinks({ items, findings: open }, CTX);
    expect(g["x"]).toBeUndefined();
    expect(hrefs(g["fingerprint"] ?? [])).toEqual(["#run-checks"]);
    expect(hrefs(g["engine"] ?? [])).toEqual(["/tax/forms/2025/return#part-5", "/tax/forms/2025/return#overrides"]);
    // L1 red: the filter jump, then the fixable ones (decision X1, the digital assets question, the open item), not the accepted one
    expect(hrefs(g["l1"] ?? [])).toEqual([
      `#${FINDINGS_HASH.gatingL1}`,
      "/tax/forms/2025/return#decision-x1",
      "/tax/forms/2025/questionnaire/return-completeness#q-digital",
      `/tax/forms/2025/return#${openItemAnchorId("rule:scha.itemize")}`,
    ]);
    expect(hrefs(g["l2"] ?? [])).toEqual(["#run-checks"]);
    expect(hrefs(g["l3"] ?? [])).toEqual(["#ai-review"]);
    expect(hrefs(g["verdict"] ?? [])).toEqual([`#${FINDINGS_HASH.gating}`]);
  });
});

// ── open items, conflicts and homework of the review sheet ─────────────────────

describe("open items of the review sheet", () => {
  const item = (id: string, over: Partial<{ who: string; lines: string[]; refs: { kind: string; id: string; label: string }[] }> = {}) => ({ id, who: over.who ?? "owner", lines: (over.lines ?? []).map((key) => ({ key })), refs: over.refs ?? [] });

  it("decision:X1 -> the decision card (Record this decision), decision:X5 recorded -> Change this decision", () => {
    expect(openItemLinks(item("decision:X1", { who: "cpa" }), CTX)[0]).toMatchObject({ kind: "decision", href: "/tax/forms/2025/return#decision-x1" });
    expect(openItemLinks(item("decision:X1", { who: "cpa" }), CTX)[0]?.label).toMatch(/^Record this decision: X1/);
    expect(openItemLinks(item("decision:X5", { who: "cpa" }), CTX)[0]?.label).toMatch(/^Change this decision: X5/);
  });

  it("none:<group> -> the question of that group; attest:digital -> the digital assets question", () => {
    expect(hrefs(openItemLinks(item("none:other_income"), CTX))).toContain("/tax/forms/2025/questionnaire/return-completeness#q-g_other_income");
    expect(hrefs(openItemLinks(item("attest:digital"), CTX))).toContain("/tax/forms/2025/questionnaire/return-completeness#q-digital");
    expect(hrefs(openItemLinks(item("attest:foreign"), CTX))).toContain("/tax/forms/2025/questionnaire/return-completeness#q-foreign");
  });

  it("an answer source (return-completeness.<node>) links to that exact question; a planning answer to the planning questions", () => {
    const links = openItemLinks(item("rule:x", { refs: [{ kind: "questionnaire", id: "return-completeness.oik", label: "Kinds of other income" }, { kind: "planning", id: "filing_status", label: "Filing status" }] }), CTX);
    expect(hrefs(links)).toEqual(expect.arrayContaining(["/tax/forms/2025/questionnaire/return-completeness#q-oik", "/tax/personal/2025"]));
  });

  it("a document item links to the document itself; a duplicate links to both", () => {
    expect(hrefs(openItemLinks(item(`doc-unverified:${DOC_A}`), CTX))).toContain(`/documents/${DOC_A}/review`);
    const dup = hrefs(openItemLinks(item(`doc-duplicate:w2:${DOC_A}:${DOC_B}`), CTX));
    expect(dup).toEqual(expect.arrayContaining([`/documents/${DOC_A}/review`, `/documents/${DOC_B}/review`]));
    expect(hrefs(openItemLinks(item("rule:y", { refs: [{ kind: "document", id: DOC_B, label: "1099-INT from Example Bank" }] }), CTX))).toContain(`/documents/${DOC_B}/review`);
    expect(openItemLinks(item("rule:y", { refs: [{ kind: "document", id: DOC_B, label: "1099-INT from Example Bank" }] }), CTX).find((l) => l.kind === "document")?.label).toBe("Open the document: 1099-INT from Example Bank");
  });

  it("upload / books / forms: the right page for the family", () => {
    expect(hrefs(openItemLinks(item("prior-year-return"), CTX))).toEqual(["/documents?view=tax&year=2025"]);
    expect(openItemLinks(item("prior-year-return"), CTX)[0]?.label).toBe("Upload a document: Documents page");
    expect(hrefs(openItemLinks(item("ekc-uncoded-transactions", { who: "owner", lines: ["schc.28"] }), CTX))).toContain("/business/ek-consulting/gl");
    expect(hrefs(openItemLinks(item("gl-sign-flip:4110", { refs: [{ kind: "gl", id: "4110", label: "Interest earned" }] }), CTX))).toContain("/business/ek-consulting/gl");
    expect(hrefs(openItemLinks(item("schedule-c-owner-unknown"), { ...CTX, forms: { ...CTX.forms, f1040sc: { label: "Schedule C", pdf: "f1040sc", card: "schedule-c", group: null } } }))).toContain("/tax/forms/2025#schedule-c");
    expect(hrefs(openItemLinks(item("override-stale:line:scha.8a", { who: "cpa" }), CTX))).toContain("/tax/forms/2025/return#overrides");
  });

  it("an item with lines links to each line (up to three), the form on the line's page and the card; one without data gets a fallback by who", () => {
    const links = openItemLinks(item("rule:scha.itemize", { lines: ["scha.8a", "f1040.9"] }), CTX);
    expect(hrefs(links)).toEqual(expect.arrayContaining(["/tax/forms/2025/return#line-scha-8a", "/tax/forms/2025/return#line-f1040-9", "/api/tax/forms/2025/pdf/f1040sa?view=1", "/tax/forms/2025#schedule-a"]));
    expect(links.find((l) => l.kind === "sheet")?.label).toBe("Open the line on the sheet: Schedule A line 8a");
    expect(hrefs(openItemLinks(item("rule:unknown", { who: "owner" }), EMPTY_LINK_CONTEXT))).toEqual(["/tax/forms/2025/questionnaire/return-completeness"]);
    expect(hrefs(openItemLinks(item("rule:unknown", { who: "cpa" }), EMPTY_LINK_CONTEXT))).toEqual(["/tax/forms/2025#forms-needs-input"]);
  });

  it("a conflict links to each source that disagrees; with no resolvable source, the Forms page", () => {
    const links = conflictLinks({ factKey: "income.interest.books", candidates: [{ refs: [{ kind: "gl", id: "4110", label: "Interest earned" }] }, { refs: [{ kind: "document", id: DOC_A, label: "1099-INT from Example Bank" }] }, { refs: [{ kind: "document", id: DOC_B, label: "1099-INT from Other Bank" }] }] }, CTX);
    expect(hrefs(links)).toEqual(["/business/ek-consulting/gl", `/documents/${DOC_A}/review`, `/documents/${DOC_B}/review`]);
    expect(links.map((l) => l.label)).toEqual(["Open the books: GL accounts of EK Consulting (Interest earned)", "Open the document: 1099-INT from Example Bank", "Open the document: 1099-INT from Other Bank"]);
    expect(hrefs(conflictLinks({ factKey: "k", candidates: [{ refs: [] }] }, CTX))).toEqual(["/tax/forms/2025#forms-needs-input"]);
  });

  it("hostile ids and refs on an item never reach an href", () => {
    const bad = `"><script>alert(1)</script>`;
    const links = openItemLinks({ id: `none:${bad}`, who: "owner", lines: [{ key: bad }], refs: [{ kind: "document", id: bad, label: bad }, { kind: "questionnaire", id: `return-completeness.${bad}`, label: bad }, { kind: "questionnaire", id: `none:${bad}`, label: bad }, { kind: "decision", id: bad, label: bad }, { kind: "javascript", id: bad, label: bad }] }, CTX);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(isSafeLinkHref(l.href), l.href).toBe(true);
      expect(l.label).not.toMatch(/[<>"]/);
    }
  });
});

describe("open-item coverage guard", () => {
  /** Every open-item id the engine can emit, from the source: `id: "x"` / `id: \`x:${y}\`` next to a `severity`, and openItem(`x`, ...) in the overrides. */
  function openItemIdsInSource(): string[] {
    const files = ["lib/tax2025/return.ts", "lib/tax2025/resolve-facts.ts", "lib/tax2025/rules/schedule-d.ts", "lib/tax2025/overrides.ts"];
    const ids = new Set<string>();
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/\bid:\s*(`[^`]*`|"[^"]*")\s*,\s*severity:/g)) ids.add((m[1] ?? "").slice(1, -1).replace(/\$\{[^}]*\}/g, "x"));
      for (const m of src.matchAll(/\bopenItem\(\s*(`[^`]*`|"[^"]*")/g)) ids.add((m[1] ?? "").slice(1, -1).replace(/\$\{[^}]*\}/g, "x"));
    }
    return [...ids].sort();
  }

  it("every open-item id family in the engine has a link rule (a new item cannot ship without one)", () => {
    const ids = openItemIdsInSource();
    expect(ids.length).toBeGreaterThan(45);
    expect(ids).toContain("rule:x");
    expect(ids).toContain("none:x");
    expect(ids).toContain("doc-unverified:x");
    const missing = ids.filter((id) => !openItemRuleFor(id).explicit);
    expect(missing, `open item ids with no rule in OPEN_ITEM_RULES: ${missing.join(", ")}`).toEqual([]);
  });

  it("the guard has teeth: an unknown family is not explicit", () => {
    expect(openItemRuleFor("brand-new-item").explicit).toBe(false);
    expect(OPEN_ITEM_RULES.every((r) => r.note.length > 10)).toBe(true);
  });

  it("every open item of real returns (complete, phase 1b and blocked) gets at least one safe link, and the lines it names have a row on the sheet", () => {
    let items = 0;
    for (const facts of [fullFacts(), fullFacts1b(), emptyFacts()]) {
      const ret = computeTy2025Return(facts);
      const model = buildSheetModel({ ret, documents: [], now: NOW });
      const ctx = buildLinkContext({ model, ret, maps: FORM_MAPS, catalogs: loadCatalogs() });
      for (const i of model.openItems) {
        const links = openItemLinks(i, ctx);
        expect(links.length, i.id).toBeGreaterThan(0);
        for (const l of links) expect(isSafeLinkHref(l.href), `${i.id}: ${l.href}`).toBe(true);
        for (const line of i.lines.slice(0, 3)) if (line.key in ctx.sheetLines) expect(hrefs(links), i.id).toContain(`/tax/forms/2025/return#${lineAnchorId(line.key)}`);
        items += 1;
      }
      for (const c of model.conflicts) expect(conflictLinks(c, ctx).length).toBeGreaterThan(0);
      for (const h of model.homework) expect(model.openItems.some((i) => i.id === h.id), h.id).toBe(true);
    }
    expect(items).toBeGreaterThan(30);
  });

  it("the none:<group> questions exist in the Return completeness questionnaire (the node id g_<group>), as do the header questions", async () => {
    const content = await import("@/lib/tax-questionnaire-content");
    const rc = content.questionnaireById("return-completeness");
    const nodeIds = new Set((rc?.nodes ?? []).map((n) => n.id));
    for (const g of content.RC_NONE_GROUP_IDS) expect(nodeIds.has(`g_${g}`), g).toBe(true);
    for (const n of ["digital", "foreign"]) expect(nodeIds.has(n), n).toBe(true);
    // a questionnaire page renders each node under id q-<node id>
    expect(read("components/tax/forms/questionnaire-runner.tsx")).toContain("id={`q-${node.id}`}");
  });

  it("an item's anchor on the sheet is the one the link points at", () => {
    const src = read("components/tax/forms/return-sheet.tsx");
    expect(src).toContain("id={openItemAnchorId(item.id)}");
    expect(src).toContain("id={conflictAnchorId(c.factKey)}");
    expect(src).toContain("id={decisionAnchorId(d.id)}");
    expect(src).toContain("id={homeworkAnchorId(h.id)}");
    expect(decisionAnchorId("X1")).toBe("decision-x1");
    expect(conflictAnchorId("income.interest.books")).toBe("conflict-income-interest-books");
  });
});
