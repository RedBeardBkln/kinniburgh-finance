import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildGapReport, formatGapReport, printedLineText, shortField } from "@/lib/tax2025-pdf-gap";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { PENDING_LINE_KEYS } from "@/lib/tax2025/pdf/pending-line-keys";
import type { FormMap } from "@/lib/tax2025/pdf/types";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { emptyFacts, fullFacts } from "./tax2025-fixtures";
import { loadCatalog } from "./tax2025-pdf-harness";

const OPTS = { generatedAt: "2026-10-03T16:00:00.000Z", generatedBy: "Gap Test" } as const;

function viewOf(facts: ReturnType<typeof fullFacts>) {
  return toPdfReturnView(computeTy2025Return(facts), facts, OPTS);
}

const catalogs = Object.fromEntries(FORM_MAPS.map((m) => [m.formId, loadCatalog(m.formId)]));

describe("gap report", () => {
  it("reports every registered map with consistent counts (fixture, no DB)", () => {
    const gaps = buildGapReport(viewOf(fullFacts()), FORM_MAPS, catalogs);
    expect(gaps.map((g) => g.formId)).toEqual(FORM_MAPS.map((m) => m.formId));
    for (const g of gaps) {
      expect(g.filledMoneyLines + g.blankLines.length).toBe(g.mappedMoneyLines);
      // Form 8949 is all table rows (no engine money line is mapped to a field): it reports 0 mapped money lines.
      if (g.formId !== "f8949") expect(g.mappedMoneyLines).toBeGreaterThan(0);
    }
  });

  it("flags printed money lines that no map claims (heuristic) for the trial 1040 map", () => {
    const f1040 = buildGapReport(viewOf(fullFacts()), FORM_MAPS, catalogs).find((g) => g.formId === "f1040");
    if (!f1040) return; // the 1040 map is always registered; guard for map-set changes
    const mapped = new Set(FORM_MAPS.find((m) => m.formId === "f1040")?.lines.map((l) => l.field.split(".").slice(-2).join(".")));
    for (const u of f1040.unmappedMoneyLines) {
      expect(mapped.has(u.field), `${u.field} is reported unmapped but a map line claims it`).toBe(false);
      expect(u.text).toMatch(/^\d{1,2}[a-z]?\.\s/);
    }
  });

  it("lists pending keys still used and the reason a line is blank", () => {
    const pendingKey = PENDING_LINE_KEYS[0];
    expect(pendingKey).toBeDefined();
    const catalog = catalogs["f1040"];
    expect(catalog).toBeDefined();
    const textField = catalog?.fields.find((f) => f.type === "text")?.name ?? "";
    const map: FormMap = {
      formId: "f1040",
      lines: [
        { kind: "money", field: textField, line: pendingKey ?? "sch2.1" },
        { kind: "money", field: `${textField}x`, line: "f1040.34" },
      ],
      tables: [],
      header: [],
      blank: [],
    };
    const gaps = buildGapReport(viewOf(fullFacts()), [map], catalogs);
    const g = gaps[0];
    expect(g?.pendingKeysUsed).toEqual([{ key: pendingKey, field: shortField(textField) }]);
    const pendingBlank = g?.blankLines.find((b) => b.key === pendingKey);
    expect(pendingBlank?.reason).toMatch(/pending key/);
    const zero = g?.blankLines.find((b) => b.key === "f1040.34");
    expect(zero?.reason).toMatch(/computed zero|not applicable/);
  });

  it("explains a blocked line with the engine's reason (empty fixture) and renders text", () => {
    const view = viewOf(emptyFacts());
    const gaps = buildGapReport(view, FORM_MAPS, catalogs);
    const g = gaps.find((x) => x.formId === "f1040");
    expect(g).toBeDefined();
    const blocked = g?.blankLines.find((b) => b.key === "f1040.1a");
    expect(blocked?.reason.length).toBeGreaterThan(5);
    const text = formatGapReport(gaps);
    expect(text).toContain("== f1040 ==");
    expect(text).toContain("pending keys still used");
    expect(text).toContain("printed money lines with no mapping");
    expect(text).toContain("lines blank with reasons");
  });

  it("printedLineText finds line numbers and skips identity/header fields", () => {
    expect(printedLineText("Income. ... 1a. Total amount from Form(s) W-2, box 1")).toBe("1a. Total amount from Form(s) W-2, box 1");
    expect(printedLineText("Page 1. For the year Jan. 1-Dec. 31, 2025")).toBeNull();
    expect(printedLineText("Your social security number")).toBeNull();
    expect(printedLineText("12. Routing number")).toBeNull();
    expect(printedLineText(null)).toBeNull();
  });
});

describe("pdf-gap script wiring", () => {
  it("package.json exposes pnpm tax2025:pdf-gap and the script uses only the fixture (no db import)", () => {
    const root = resolve(__dirname, "../..");
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["tax2025:pdf-gap"]).toBe("tsx scripts/tax2025-pdf-gap.ts");
    const src = readFileSync(resolve(root, "scripts/tax2025-pdf-gap.ts"), "utf8");
    expect(src).not.toMatch(/lib\/db|tax2025-build|prisma|anthropic|fetch\(/i);
    expect(src).toContain("tax2025-fixtures");
  });
});
