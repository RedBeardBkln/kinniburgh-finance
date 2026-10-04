// TESTER: a check whose INPUT IS MISSING must fail closed. `it.fails` = confirmed defect (see 03-test-report-X.md).
import { vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { describe, expect, it } from "vitest";
import { buildPipeline, cleanScenario, richScenario } from "./tax-review-harness";
import { runL1 } from "@/lib/tax-review/l1/run-l1";

const gating = (r: Awaited<ReturnType<typeof runL1>>) => r.findings.filter((f) => f.severity === "blocker" || f.severity === "high" || !f.acceptable);

describe("missing input is reported, not silently passed", () => {
  it("no documents (raw=null) adds a gating finding", async () => {
    const { ctx } = await buildPipeline(cleanScenario());
    const base = await runL1(ctx);
    const r = await runL1({ ...ctx, raw: null });
    expect(r.findings.some((f) => f.check === "L1.C1.no-documents")).toBe(true);
    expect(gating(r).length).toBeGreaterThan(gating(base).length);
  });
  it("an empty packet raises a not-emitted blocker for every required form", async () => {
    const { ctx } = await buildPipeline(cleanScenario());
    const r = await runL1({ ...ctx, packet: { ...ctx.packet, files: [] } });
    expect(r.findings.filter((f) => f.check === "L1.G1.not-emitted" && f.severity === "blocker").length).toBeGreaterThanOrEqual(5);
  });
  it("no blank PDFs / no maps / empty CSV are reported", async () => {
    const { ctx } = await buildPipeline(cleanScenario());
    expect((await runL1({ ...ctx, blankFormIds: new Set() })).findings.some((f) => f.check === "L1.G1.no-blank")).toBe(true);
    expect((await runL1({ ...ctx, maps: [] })).findings.some((f) => f.check === "L1.B1.unbound")).toBe(true);
    expect((await runL1({ ...ctx, csvText: "" })).findings.some((f) => f.check === "L1.X1.csv")).toBe(true);
  });
  it("a printed table with NO rows while its total line is non-zero is reported (the table-footing rule silently skips it)", async () => {
    const { ctx } = await buildPipeline(richScenario(), {
      hooks: {
        afterView: (v) => {
          for (const k of Object.keys(v.tables)) (v.tables as Record<string, unknown[]>)[k] = [];
        },
      },
    });
    expect(ctx.view.lines["schb.2"]?.amount ?? 0).toBeGreaterThan(0);
    const r = await runL1(ctx);
    expect(r.findings.some((f) => f.check.startsWith("L1.F1.schb.") || f.check.startsWith("L1.F1.ct1040.18") || f.check.startsWith("L1.F1.schc.48"))).toBe(true);
  });
  it("no override layer (effective=null) is reported instead of passing the override checks silently", async () => {
    const { ctx } = await buildPipeline(cleanScenario());
    const base = await runL1(ctx);
    const r = await runL1({ ...ctx, effective: null });
    expect(r.findings.length).toBeGreaterThan(base.findings.length);
  });
});
