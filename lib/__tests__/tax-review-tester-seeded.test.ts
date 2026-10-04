// TESTER: independently re-created seeded defects on the RICH return (injection points differ from the Coder's tests).
import { vi } from "vitest";
vi.setConfig({ testTimeout: 240000, hookTimeout: 240000 });
import { beforeAll, describe, expect, it } from "vitest";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { schAMap } from "@/lib/tax2025/pdf/maps/schA";
import { PDFCheckBox } from "pdf-lib";
import { brokerDoc, dividendDoc, editPacketFile, fieldOfLine, richDocs, richScenario, runPipeline, setText } from "./tax-review-harness";
import { EVA_ID } from "./tax2025-fixtures";

let baseKeys = new Set<string>();
beforeAll(async () => {
  baseKeys = new Set((await runPipeline(richScenario())).result.findings.map((f) => f.key));
});

async function added(scen = richScenario(), opts: Parameters<typeof runPipeline>[1] = {}) {
  const { result } = await runPipeline(scen, opts);
  return result.findings.filter((f) => !baseKeys.has(f.key));
}
const has = (list: Awaited<ReturnType<typeof added>>, check: string, severity: string) => list.some((f) => f.check === check && f.severity === severity);

describe("seeded defects on the rich return", () => {
  it("a printed Schedule A line changed by $1 after the engine run -> B1 blocker", async () => {
    const a = await added(richScenario(), {
      hooks: { afterPacket: (p) => editPacketFile(p, p.files.find((f) => f.formId === "f1040sa")!.name, (form) => setText(form, fieldOfLine(schAMap, "scha.5a"), "9,001")) },
    });
    expect(has(a, "L1.B1.money", "blocker")).toBe(true);
  });
  it("a printed money field blanked after the run -> B1 blocker", async () => {
    const a = await added(richScenario(), { hooks: { afterPacket: (p) => editPacketFile(p, "01-f1040.pdf", (form) => setText(form, fieldOfLine(f1040Map, "f1040.9"), "")) } });
    expect(has(a, "L1.B1.money", "blocker")).toBe(true);
  });
  it("a second filing-status box ticked in the PDF -> a non-acceptable blocker", async () => {
    const a = await added(richScenario(), {
      hooks: {
        afterPacket: (p) =>
          editPacketFile(p, "01-f1040.pdf", (form) => {
            const boxes = form.getFields().filter((f) => f instanceof PDFCheckBox) as PDFCheckBox[];
            const u = boxes.filter((b) => !b.isChecked() && /c1_[1-5]\b|Status/i.test(b.getName()));
            if (u.length === 0) throw new Error("no filing-status box found");
            u[0]!.check();
          }),
      },
    });
    expect(a.some((f) => f.severity === "blocker" && !f.acceptable)).toBe(true);
  });
  it("Eva's W-2 dropped from the facts while the document stays -> C1 blocker + doc-not-reflected", async () => {
    const a = await added(
      richScenario(richDocs(), (f) => {
        f.income.w2s = f.income.w2s.filter((w) => w.personUserId !== EVA_ID);
      })
    );
    expect(has(a, "L1.C1.w2-box1", "blocker")).toBe(true);
    expect(has(a, "L1.C1.doc-not-reflected", "high")).toBe(true);
  });
  it("a duplicate 1099-DIV and a duplicate broker statement -> two C2 highs", async () => {
    const a = await added(
      richScenario([
        ...richDocs(),
        dividendDoc("Sample Fund Co", "44-4444444", 250_000, 200_000, { id: "00000000-0000-4000-8000-0000000000e1" }),
        brokerDoc("Sample Brokerage B", "77-7777777", [{ box: "B", proceedsCents: 120_075, costCents: 100_040 }], { id: "00000000-0000-4000-8000-0000000000e2" }),
      ])
    );
    expect(a.filter((f) => f.check === "L1.C2.duplicate" && f.severity === "high").length).toBeGreaterThanOrEqual(2);
  });
  it("wrong filing status in the view answers -> B4 blocker", async () => {
    const a = await added(richScenario(), {
      hooks: {
        afterView: (v) => {
          (v.answers as Record<string, unknown>)["filingStatus"] = "mfs";
        },
      },
    });
    expect(a.some((f) => f.check.startsWith("L1.B4") && f.severity === "blocker")).toBe(true);
  });
  it.each(["f1040.11a", "sch1.10", "scha.17", "ct1040.17"] as const)("a $1 footing error on %s -> a non-acceptable blocker (tolerance 0)", async (key) => {
    const a = await added(richScenario(), {
      mutateRet: (ret) => {
        const l = ret.lines[key];
        if (l && l.amount !== null) l.amount += 1;
      },
    });
    expect(a.some((f) => f.severity === "blocker" && !f.acceptable), key).toBe(true);
  });
  it("document -> return ties: dividend 1a +$1, interest +$1, fed withholding +$1, CT withholding +$1, W-2 wages +$0.50 are each a C1 blocker", async () => {
    type Facts = ReturnType<typeof richScenario>["facts"];
    const mut: [string, (f: Facts) => void, string][] = [
      ["div1a", (f) => { const d = f.income.dividends[0]; if (d && d.box1aCents !== null) d.box1aCents += 100; }, "L1.C1.div-ordinary"],
      ["int", (f) => { const i = f.income.interest[0]; if (i && i.box1Cents !== null) i.box1Cents += 100; }, "L1.C1.int"],
      ["fedwh", (f) => { const w = f.income.w2s[0]; if (w && w.fedWithheldCents !== null) w.fedWithheldCents += 100; }, "L1.C1.w2-box2"],
      ["ctwh", (f) => { const w = f.income.w2s[0]; if (w && w.ctWithheldCents !== null) w.ctWithheldCents += 100; }, "L1.C1.w2-box17-ct"],
      ["w2 50c", (f) => { const w = f.income.w2s[0]; if (w && w.wagesCents !== null) w.wagesCents += 50; }, "L1.C1.w2-box1"],
    ];
    for (const [name, fn, check] of mut) expect(has(await added(richScenario(richDocs(), fn)), check, "blocker"), name).toBe(true);
  });
  it("a mortgage deduction dropped from the facts -> blocking engine items (D1)", async () => {
    const a = await added(
      richScenario(richDocs(), (f) => {
        f.deductions.mortgages = [];
      })
    );
    expect(a.some((f) => f.check.startsWith("L1.D1") && f.severity === "blocker")).toBe(true);
  });
});
