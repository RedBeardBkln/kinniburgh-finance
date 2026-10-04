import { vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { beforeAll, describe, expect, it } from "vitest";
import type { OverrideRow } from "@/lib/tax2025/overrides";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { schAMap } from "@/lib/tax2025/pdf/maps/schA";
import type { FormMap } from "@/lib/tax2025/pdf/types";
import { PDFHexString, PDFName, PDFTextField } from "pdf-lib";
import type { Severity } from "@/lib/tax-review/types";
import {
  cleanDocs,
  cleanScenario,
  describeFindings,
  editPacketFile,
  fieldOfLine,
  interestDoc,
  richScenario,
  runPipeline,
  setText,
  significant,
  w2Doc,
} from "./tax-review-harness";
import type { L1Result } from "@/lib/tax-review/l1/run-l1";
import { EVA_ID, owner } from "./tax2025-fixtures";

// Seeded-defects harness (plan section 9.2): take a clean return, inject ONE known defect at the stage it simulates, and prove the
// named L1 check raises the named severity. The clean pipeline itself must raise nothing of severity medium or higher.

function expectFinding(result: L1Result, check: string, severity: Severity, acceptable?: boolean): void {
  const hits = result.findings.filter((f) => f.check === check);
  expect(hits.length, `expected a ${check} finding; got:\n${describeFindings(result.findings).join("\n")}`).toBeGreaterThan(0);
  expect(hits.some((f) => f.severity === severity), `${check} should be ${severity}; got ${hits.map((h) => h.severity).join(",")}`).toBe(true);
  if (acceptable !== undefined) expect(hits.some((f) => f.acceptable === acceptable)).toBe(true);
}

describe("the clean fixture", () => {
  let result: L1Result;
  beforeAll(async () => {
    result = (await runPipeline(cleanScenario())).result;
  });
  it("raises no finding of severity medium or higher, and every check ran", () => {
    expect(describeFindings(significant(result.findings))).toEqual([]);
    expect(result.status).toBe("completed");
    expect(result.summary.checks.every((c) => c.status === "ok")).toBe(true);
  });
});

describe("S1 wrong W-2 box 1 (facts differ from the documents)", () => {
  it("L1.C1: the W-2 total differs from line 1a", async () => {
    const { result } = await runPipeline(
      cleanScenario(cleanDocs(), (f) => {
        const w = f.income.w2s[0];
        if (w && w.wagesCents !== null) w.wagesCents += 12_300;
      })
    );
    expectFinding(result, "L1.C1.w2-box1", "blocker", false);
  });
});

describe("S2 dropped W-2", () => {
  it("L1.C1: the documents add up to more than line 1a, and the dropped document is reported as not used", async () => {
    const { result } = await runPipeline(
      cleanScenario(cleanDocs(), (f) => {
        f.income.w2s = f.income.w2s.slice(0, 1);
      })
    );
    expectFinding(result, "L1.C1.w2-box1", "blocker", false);
    expectFinding(result, "L1.C1.doc-not-reflected", "high");
  });
});

describe("S3 duplicated 1099", () => {
  it("L1.C2: the same 1099-INT twice is a possible double count", async () => {
    const docs = cleanDocs();
    const dup = interestDoc("Sample Bank", "33-3333333", 50_000, { id: "00000000-0000-4000-8000-0000000000bb" });
    const { result } = await runPipeline(cleanScenario([...docs, dup]));
    expectFinding(result, "L1.C2.duplicate", "high", true);
  });
  it("the same W-2 under both persons is caught too (the engine's own duplicate key includes the person)", async () => {
    const docs = cleanDocs();
    const second = w2Doc(EVA_ID, "Alpine Sample Co", "11-1111111", 9_000_000, 1_100_000, 300_000, {}, { id: "00000000-0000-4000-8000-0000000000cc" });
    const { result } = await runPipeline(cleanScenario([...docs, second]));
    expectFinding(result, "L1.C2.w2-both-persons", "high", true);
  });
});

describe("S4 wrong filing status", () => {
  it("L1.B4 (filing status in the view and a non-MFJ box) and L1.E1 (prior-year status)", async () => {
    const { result } = await runPipeline(
      cleanScenario(cleanDocs(), (f) => {
        f.priorYear.filingStatus = owner("single");
      }),
      {
        hooks: {
          afterView: (view) => {
            (view.answers as Record<string, string | boolean | null>)["filingStatus"] = "single";
          },
        },
      }
    );
    expectFinding(result, "L1.B4.answer", "blocker", false);
    expectFinding(result, "L1.B4.filing-status", "blocker", false);
    expectFinding(result, "L1.E1.filing-status", "medium", true);
  });
});

describe("S5 missing required form", () => {
  it("L1.G1: Schedule A is required but is not in the packet", async () => {
    const withoutSchA: readonly FormMap[] = FORM_MAPS.filter((m) => m.formId !== schAMap.formId);
    const { result } = await runPipeline(richScenario(), { fillMaps: withoutSchA, hooks: { mapsForChecks: FORM_MAPS } });
    expectFinding(result, "L1.G1.not-emitted", "blocker", false);
  });
});

describe("S6 swapped line in a form map", () => {
  it("L1.B3: the label audit sees the exchange that every map-based check cannot", async () => {
    const a = fieldOfLine(f1040Map, "f1040.1a");
    const b = fieldOfLine(f1040Map, "f1040.2b");
    const swapped: FormMap = {
      ...f1040Map,
      lines: f1040Map.lines.map((l) => (l.kind === "money" && l.field === a ? { ...l, field: b } : l.kind === "money" && l.field === b ? { ...l, field: a } : l)),
    };
    const maps = FORM_MAPS.map((m) => (m.formId === "f1040" ? swapped : m));
    const { result } = await runPipeline(cleanScenario(), { fillMaps: maps });
    expectFinding(result, "L1.B3.label", "blocker", false);
    // the PDF was filled from the same swapped map, so reading it back against that map finds no difference: only the labels see it
    expect(result.findings.some((f) => f.check === "L1.B1.money")).toBe(false);
  });
});

describe("S7 one-dollar footing error", () => {
  it("L1.F1: line 9 is $1 off the sum of its parts (tolerance 0)", async () => {
    const { result } = await runPipeline(cleanScenario(), {
      mutateRet: (ret) => {
        const l = ret.lines["f1040.9"];
        if (l && l.amount !== null) l.amount += 1;
      },
    });
    expectFinding(result, "L1.F1.f1040.9", "blocker", false);
  });
});

describe("S8 PDF field changed after the engine run", () => {
  it("L1.B1: a printed amount that differs from the return", async () => {
    const { result } = await runPipeline(cleanScenario(), {
      hooks: {
        afterPacket: (packet) => editPacketFile(packet, "01-f1040.pdf", (form) => setText(form, fieldOfLine(f1040Map, "f1040.1a"), "999,999")),
      },
    });
    expectFinding(result, "L1.B1.money", "blocker", false);
  });
});

describe("S9 stale override", () => {
  it("L1.D3: an override whose base value moved is a blocker; any line override is high", async () => {
    const row: OverrideRow = {
      id: "00000000-0000-4000-8000-0000000000dd",
      taxYear: 2025,
      targetKind: "line",
      targetKey: "sch1.3",
      version: 1,
      valueKind: "money_cents",
      valueCents: 6_000_000,
      valueText: null,
      computedSnapshot: { status: "computed", cents: 4_000_000 },
      authority: "owner",
      reason: "pinned for a test",
      setByName: "Test User",
      setAt: new Date("2026-10-01T12:00:00Z"),
      archivedAt: null,
    };
    const s = cleanScenario();
    s.overrideRows = [row];
    const { result } = await runPipeline(s);
    expectFinding(result, "L1.D3.stale", "blocker", false);
    expectFinding(result, "L1.D3.line-override", "high", false);
  });
});

describe("S10 stray SSN-like text", () => {
  it("L1.D4: text that looks like an SSN in the CSV export", async () => {
    const { result } = await runPipeline(cleanScenario(), { hooks: { afterCsv: (csv) => `${csv}note,123-45-6789\r\n` } });
    expectFinding(result, "L1.D4.text", "blocker", false);
  });
  it("L1.D4: SSN-like text inside a PDF field", async () => {
    const { result } = await runPipeline(cleanScenario(), {
      hooks: { afterPacket: (packet) => editPacketFile(packet, "01-f1040.pdf", (form) => setText(form, fieldOfLine(f1040Map, "f1040.8"), "123-45-6789")) },
    });
    expectFinding(result, "L1.D4.pdf", "blocker", false);
  });
});

describe("S11 blank printed as 0", () => {
  it("L1.B1: a line with no amount printed as 0", async () => {
    // 1040 line 35a (refund amount) carries no amount (informational): a 0 there reads as "refund of $0"
    const { result } = await runPipeline(cleanScenario(), {
      hooks: { afterPacket: (packet) => editPacketFile(packet, "01-f1040.pdf", (form) => setText(form, fieldOfLine(f1040Map, "f1040.35a"), "0")) },
    });
    expectFinding(result, "L1.B1.money", "blocker", false);
    expect(result.findings.some((f) => f.check === "L1.B1.money" && /no amount/.test(f.message))).toBe(true);
  });
});

describe("S12 surface disagreement", () => {
  it("L1.X1: one CSV cell differs from the return", async () => {
    const { result } = await runPipeline(cleanScenario(), {
      hooks: {
        afterCsv: (csv) =>
          csv.replace(/(\r\n[^\r\n]*,f1040\.9,[^,\r\n]*,)(-?\d+)/, (_m, head: string, n: string) => `${head}${Number(n) + 1}`),
      },
    });
    expectFinding(result, "L1.X1.csv", "blocker", false);
  });
});

describe("S15 paid-preparer block filled", () => {
  it("L1.B2: the paid-preparer / designee block must stay empty on a self-prepared return", async () => {
    const { result } = await runPipeline(cleanScenario(), {
      hooks: {
        afterPacket: (packet) =>
          editPacketFile(packet, "01-f1040.pdf", (form) => {
            const names = form.getFields().filter((f) => f instanceof PDFTextField).map((f) => f.getName());
            const target = names.find((n) => f1040Map.blank.some((b) => b.reason === "preparer" && ("field" in b ? b.field === n : ((b.match.lastIndex = 0), b.match.test(n)))));
            if (!target) throw new Error("no preparer text field found on the 1040");
            setText(form, target, "Some Preparer");
          }),
      },
    });
    expectFinding(result, "L1.B2.preparer", "blocker", false);
  });
});

describe("S16 final package leaks draft / tool wording", () => {
  it("L1.B6: a tooltip carrying override wording in a final package", async () => {
    const { result } = await runPipeline(cleanScenario(), {
      mode: "final",
      hooks: {
        afterPacket: async (packet) => {
          for (const f of packet.files) {
            if (f.formId === null) continue;
            // neutral document properties first, so only the injected tooltip is wrong
            await editPacketFile(packet, f.name, (form, doc) => {
              doc.setSubject("Tax year 2025");
              doc.setKeywords([]);
              if (f.name === "01-f1040.pdf") {
                const field = form.getFieldMaybe(fieldOfLine(f1040Map, "f1040.1a"));
                field?.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText("DRAFT override: was $1 computed, now $2"));
              }
            });
          }
        },
      },
    });
    expectFinding(result, "L1.B6.tooltip", "blocker", false);
  });
  it("L1.B6: DRAFT in the document properties of a final package", async () => {
    const { result } = await runPipeline(cleanScenario(), { mode: "final" });
    // the packet is filled by the draft filler here, whose document subject says DRAFT: exactly what must not ship as final
    expectFinding(result, "L1.B6.property", "blocker", false);
  });
});

describe("S13 and S14", () => {
  it("S13 (an input changes after the run) is covered per mutation by tax-review-fingerprint.test.ts and the gate tests", () => {
    expect(true).toBe(true);
  });
  it.skip("S14 engine arithmetic error: the independent recomputation (L2) is Phase C", () => {
    expect(true).toBe(true);
  });
});

