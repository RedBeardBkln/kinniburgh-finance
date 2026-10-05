import React, { createElement } from "react";
import { vi } from "vitest";
vi.setConfig({ testTimeout: 120000 });
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// TESTER additions for final-review-deep-links. Independent of the Coder's tests:
//  - anchors: every LineKey (not only the ones on one return) round-trips through the ONE slug function, specific awkward keys by hand,
//    and no duplicate ids on the rendered sheet for four different returns;
//  - the single-form PDF route: ?view=1 combined with ?stamp=0 / ?final=1 never lifts the approval lock, only changes Content-Disposition,
//    and it cannot reach another form or year;
//  - fuzz: random hostile text in every free-text slot of a finding never produces an href outside the closed route list.
(globalThis as { React?: typeof React }).React = React;
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/actions/tax-return-overrides", () => ({ clearTaxReturnOverride: vi.fn(), setTaxReturnOverride: vi.fn(), listTaxReturnOverrideHistory: vi.fn() }));

import { ReturnSheet } from "@/components/tax/forms/return-sheet";
import { anchorSlug, conflictAnchorId, decisionAnchorId, lineAnchorId } from "@/lib/tax-anchors";
import { buildLinkContext } from "@/lib/tax-review/links-context";
import { conflictLinks, findingLinks, isSafeLinkHref, openItemLinks, LINK_RULES, type LinkContext, type LinkableFinding } from "@/lib/tax-review/links";
import { plainText } from "@/lib/tax-review/l1/helpers";
import { handleFormRequest, type PdfRouteDeps } from "@/lib/tax2025-pdf-route";
import { LINE_KEYS } from "@/lib/tax2025/line-catalog";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { buildSheetModel } from "@/lib/tax2025-sheet";
import { loadCatalogs } from "./tax-review-harness";
import { emptyFacts, fullFacts, fullFacts1b } from "./tax2025-fixtures";

const NOW = new Date("2026-10-05T12:00:00Z");

describe("anchors: one slug function for every line key", () => {
  it("awkward keys by hand", () => {
    expect(lineAnchorId("ct1040.s1.36a")).toBe("line-ct1040-s1-36a");
    expect(lineAnchorId("f8960.5c")).toBe("line-f8960-5c");
    expect(lineAnchorId("schd.1a.h")).toBe("line-schd-1a-h");
    expect(lineAnchorId("schd.1a.h")).not.toBe(lineAnchorId("schd.1a"));
    expect(decisionAnchorId("X1")).toBe("decision-x1");
    expect(anchorSlug("")).toBe("x");
    expect(anchorSlug("..--..")).toBe("x");
    expect(anchorSlug("A".repeat(300)).length).toBeLessThanOrEqual(100);
  });

  it("injective, URL-safe and prefix-stable over EVERY catalog key", () => {
    const seen = new Map<string, string>();
    for (const k of LINE_KEYS) {
      const id = lineAnchorId(k);
      expect(id, k).toMatch(/^line-[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(seen.get(id), `${k} collides with ${seen.get(id)}`).toBeUndefined();
      seen.set(id, k);
    }
    expect(seen.size).toBe(LINE_KEYS.length);
    expect(LINE_KEYS.length).toBeGreaterThan(500);
  });

  const scenarios = {
    complete: () => computeTy2025Return(fullFacts()),
    phase1b: () => computeTy2025Return(fullFacts1b()),
    blocked: () => computeTy2025Return(emptyFacts()),
  };
  for (const [name, mk] of Object.entries(scenarios)) {
    it(`${name}: no duplicate ids on the rendered sheet; every row id equals the link fragment; every same-page fragment of every item / conflict / homework link resolves to exactly one id`, () => {
      const ret = mk();
      const model = buildSheetModel({ ret, documents: [], now: NOW });
      const ctx = buildLinkContext({ model, ret, maps: FORM_MAPS, catalogs: loadCatalogs() });
      const html = renderToStaticMarkup(createElement(ReturnSheet, { model, links: ctx }));
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string);
      const count = new Map<string, number>();
      for (const i of ids) count.set(i, (count.get(i) ?? 0) + 1);
      expect([...count.entries()].filter(([, n]) => n > 1), "duplicate ids").toEqual([]);
      for (const g of [...model.federal, ...model.connecticut]) for (const l of g.lines) expect(count.get(lineAnchorId(l.key)), l.key).toBe(1);
      const links = [...model.openItems.flatMap((i) => openItemLinks(i, ctx)), ...model.conflicts.flatMap((c) => conflictLinks(c, ctx))];
      let checked = 0;
      for (const l of links) {
        const m = /^\/tax\/forms\/2025\/return#(.+)$/.exec(l.href);
        if (m === null) continue;
        expect(count.get(m[1] as string), l.href).toBe(1);
        checked += 1;
      }
      for (const c of model.conflicts) expect(count.get(conflictAnchorId(c.factKey))).toBe(1);
      expect(checked, "scenario produced no sheet-fragment links at all").toBeGreaterThan(0);
    });
  }
});

describe("single-form PDF route: ?view=1 cannot weaken the clean-copy lock or change what is served", () => {
  const facts = fullFacts();
  const makeView = () => toPdfReturnView(computeTy2025Return(facts), facts, { generatedAt: "2026-10-03T16:00:00.000Z", generatedBy: "Test User" });
  const mkDeps = (approved: boolean): PdfRouteDeps & { exports: unknown[] } => {
    const exports: unknown[] = [];
    return {
      exports,
      buildView: async () => ({ view: makeView() }),
      recordExport: async (e) => {
        exports.push(e);
      },
      approval: { currentApproval: async () => approved },
    };
  };
  const user = { id: "u1", name: "Test User" };
  const call = (deps: PdfRouteDeps, q: { stamp?: string | null; final?: string | null; view?: string | null }, form = "f1040sa", year = "2025") => handleFormRequest({ year, form, stamp: q.stamp ?? null, final: q.final ?? null, view: q.view ?? null, user }, deps);

  it("unapproved: view=1 with stamp=0 or final=1 (and every spelling of them) is still a 403 and writes no export row", async () => {
    const deps = mkDeps(false);
    for (const q of [{ view: "1", stamp: "0" }, { view: "1", final: "1" }, { view: "1", stamp: "0", final: "1" }, { view: "1", final: "1", stamp: "1" }]) {
      const res = await call(deps, q);
      expect(res.status, JSON.stringify(q)).toBe(403);
      expect(res.headers.get("content-disposition")).toBeNull();
    }
    expect(deps.exports).toHaveLength(0);
  });

  it("unapproved: plain view=1 is the stamped DRAFT (what the Final review opens) and the export row says stamp:true", async () => {
    const deps = mkDeps(false);
    const res = await call(deps, { view: "1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="ty2025-f1040sa-[0-9a-f]{12}\.pdf"$/);
    expect(deps.exports).toHaveLength(1);
    expect(deps.exports[0]).toMatchObject({ stamp: true, kind: "form" });
  });

  it("approved: view=1&stamp=0 is the clean copy inline with the -clean file name, still only that header differs from the download", async () => {
    const deps = mkDeps(true);
    const inline = await call(deps, { view: "1", stamp: "0" });
    const download = await call(deps, { stamp: "0" });
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-disposition")).toMatch(/^inline; filename="ty2025-f1040sa-[0-9a-f]{12}-clean\.pdf"$/);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="ty2025-f1040sa-[0-9a-f]{12}-clean\.pdf"$/);
    expect(Buffer.from(await inline.arrayBuffer()).equals(Buffer.from(await download.arrayBuffer()))).toBe(true);
  });

  it("anything but the exact value 1 downloads; the form and year whitelists are untouched by view", async () => {
    const deps = mkDeps(false);
    for (const v of ["", "0", "true", "01", "1 ", "1.0", "yes", "inline"]) {
      const res = await call(deps, { view: v });
      expect(res.headers.get("content-disposition"), JSON.stringify(v)).toMatch(/^attachment; /);
    }
    for (const bad of ["../f1040", "f1040%2f..", "F1040", "f1040sa/../x", "", "f1040sa.pdf", "nope"]) expect((await call(deps, { view: "1" }, bad)).status, bad).toBe(404);
    for (const y of ["2024", "2026", "abc", "2025.5", "02025"]) expect([400, 404], y).toContain((await call(deps, { view: "1" }, "f1040sa", y)).status);
  });
});

describe("fuzz: hostile text in every free-text slot never makes an href outside the closed route list", () => {
  const CTX: LinkContext = {
    year: 2025,
    sheetLines: { "scha.8a": "Schedule A line 8a" },
    decisions: { X1: { label: 'javascript:alert(1)"><img src=x onerror=alert(1)>', recorded: false } },
    openItems: {},
    conflicts: [],
    documents: { "11111111-1111-4111-8111-111111111111": "<script>alert(1)</script> 2025" },
    forms: { f1040sa: { label: "Schedule A", pdf: "f1040sa", card: "schedule-a", group: "form-schedule-a" } },
    linePdf: { "scha.8a": "f1040sa:1" },
    fieldPages: {},
    signaturePages: {},
    ruleLines: {},
  };
  const NASTY = ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "//evil.example/x", "https://evil.example", "/\\evil.example", "../../etc/passwd", "%2e%2e/%2e%2e", "\u0000", "\n\rLocation: x", "' onmouseover='x", "<a href=x>", "__proto__", "constructor", "toString", "hasOwnProperty", "f1040sa?x=1", "f1040sa#page=999999", "scha.8a‮", "X1;DROP", "doc:11111111-1111-4111-8111-111111111111/../../x", "pdf:f1040sa:../../x", "check:decision.X1", "check:conflict.__proto__", "head:connecticut' onclick=", "11111111-1111-4111-8111-111111111111"];
  let seed = 12345;
  const rnd = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const pick = (): string => NASTY[rnd(NASTY.length)] as string;
  const checks = LINK_RULES.map((r) => (typeof r.match === "string" ? r.match : r.match.source.replace(/\^|\$|\\|\(\w+\|?[^)]*\)|\[[^\]]*\]|\?|\*|\+/g, "").replace(/\.\./g, ".") + "x"));

  it("2000 random findings", () => {
    for (let n = 0; n < 2000; n += 1) {
      const f: LinkableFinding = {
        check: rnd(3) === 0 ? pick() : (checks[rnd(checks.length)] as string),
        area: pick(),
        formKey: rnd(2) === 0 ? pick() : "f1040sa",
        lineKey: rnd(2) === 0 ? pick() : "scha.8a",
        ruleTag: rnd(2) === 0 ? pick() : null,
        message: pick() + pick(),
        evidence: Array.from({ length: rnd(5) }, () => ({ ref: ["doc:", "pdf:f1040sa:", "pdf:", "check:answer.", "check:decision.", "check:conflict.", "form:", "head:", "sheet:", "csv:", ""][rnd(11)] + pick() })),
      };
      const links = findingLinks(f, CTX);
      expect(links.length).toBeGreaterThan(0);
      for (const l of links) {
        expect(isSafeLinkHref(l.href), `${l.href}  <- ${JSON.stringify(f).slice(0, 200)}`).toBe(true);
        expect(l.href).not.toMatch(/javascript|data:|evil|<|>|"|'|\s|\\|%/i);
        expect(l.label).not.toMatch(/[<>"`]/);
        if (l.newTab) expect(l.href).toMatch(/^\/api\/tax\/forms\/2025\/pdf\/[a-z0-9]+\?view=1(?:#page=\d+)?$/);
      }
    }
  });
});

describe("open item match for L1.D1.blocking-item findings (text based, because ruleTag is not stored)", () => {
  // Found by the tester (final-review-deep-links), fixed by the reviewer: BLOCKING_ITEM_PREFIX in lib/tax-review/links.ts was
  // /^Blocking item \([^)]*\): /, which could not span a form label that itself contains parentheses ("Form 8889 (spouse A)" / "(spouse B)"),
  // so those findings lost the "Open on the review sheet: this open item" link (and the gate row its fixable-item link). The prefix now
  // reads the label up to the first "): ".
  const blocked = () => {
    const f = emptyFacts();
    const ret = computeTy2025Return(f);
    const view = toPdfReturnView(ret, f, { generatedAt: "2026-10-05T12:00:00.000Z", generatedBy: "t" });
    const model = buildSheetModel({ ret, documents: [], now: NOW });
    const ctx = buildLinkContext({ model, ret, maps: FORM_MAPS, catalogs: loadCatalogs() });
    return { view, ctx };
  };
  const findingFor = (item: { id: string; formLabel: string; message: string; lineKeys: readonly string[] }): LinkableFinding => ({
    check: "L1.D1.blocking-item",
    area: "process",
    message: `Blocking item (${item.formLabel}): ${plainText(item.message)}`,
    evidence: item.lineKeys.map((k) => ({ ref: k })),
  });

  it("every blocking item of a blocked return whose form label has NO parentheses gets its open item link", () => {
    const { view, ctx } = blocked();
    const plain = view.openItems.filter((i) => i.severity === "blocking" && !/[()]/.test(i.formLabel));
    expect(plain.length).toBeGreaterThan(10);
    for (const item of plain) expect(findingLinks(findingFor(item), ctx).some((l) => l.label.endsWith("this open item")), item.id).toBe(true);
  });

  it("a blocking item whose form label has parentheses (Form 8889 (spouse A)) gets its open item link", () => {
    const { view, ctx } = blocked();
    const paren = view.openItems.filter((i) => i.severity === "blocking" && /[()]/.test(i.formLabel));
    expect(paren.length).toBeGreaterThan(0);
    for (const item of paren) expect(findingLinks(findingFor(item), ctx).some((l) => l.label.endsWith("this open item")), item.id).toBe(true);
  });

  it("the 'Form 8889 (spouse A)' open item (rule:hsa-8889) links to its own row on the sheet", () => {
    const { view, ctx } = blocked();
    const item = view.openItems.find((i) => i.id === "rule:hsa-8889");
    expect(item, "rule:hsa-8889 is a blocking item of the empty-facts return").toBeDefined();
    if (item === undefined) return;
    expect(item.formLabel).toBe("Form 8889 (spouse A)");
    const links = findingLinks(findingFor(item), ctx);
    expect(links.find((l) => l.label.endsWith("this open item"))?.href).toBe("/tax/forms/2025/return#item-rule-hsa-8889");
  });
});
