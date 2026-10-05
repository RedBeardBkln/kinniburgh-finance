import { vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { L1_CHECKS, runL1 } from "@/lib/tax-review/l1/run-l1";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import { buildPipeline, cleanScenario, richScenario } from "./tax-review-harness";

let clean: L1Context;
let rich: L1Context;

beforeAll(async () => {
  clean = (await buildPipeline(cleanScenario())).ctx;
  rich = (await buildPipeline(richScenario())).ctx;
});

const sample = (check: string, severity: "blocker" | "info" = "info"): Finding =>
  makeFinding({ layer: "L1", check, severity, area: "process", message: "m", recommendedAction: "r", acceptable: severity !== "blocker" });

describe("runL1", () => {
  it("has every check of the plan, once each", () => {
    expect(L1_CHECKS.map((c) => c.id)).toEqual([
      "L1.F1", "L1.F2", "L1.F3", "L1.B1", "L1.B2", "L1.B3", "L1.B4", "L1.B5", "L1.B6", "L1.X1", "L1.C1", "L1.C2", "L1.D1", "L1.D2", "L1.D3", "L1.D4", "L1.D5", "L1.E1", "L1.E2", "L1.G1", "L1.G2",
    ]);
    expect(L1_CHECKS.every((c) => c.description.length > 20)).toBe(true);
  });
  it("a check that throws becomes a blocker finding (fail closed) and the run is 'failed'; only the error class is kept", async () => {
    const boom: L1Check = {
      id: "L1.TEST",
      description: "A check that throws an error whose text quotes a value",
      run() {
        throw new RangeError("secret value 123456789 leaked");
      },
    };
    const ok: L1Check = { id: "L1.OK", description: "A check that reports one note", run: () => [sample("L1.OK.note")] };
    const r = await runL1(clean, [boom, ok]);
    expect(r.status).toBe("failed");
    const failed = r.findings.find((f) => f.check === "L1.runner.check-failed");
    expect(failed?.severity).toBe("blocker");
    expect(failed?.acceptable).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/secret value|123456789/);
    expect(r.summary.checks.map((c) => `${c.id}:${c.status}`)).toEqual(["inputs:ok", "L1.TEST:failed", "L1.OK:ok"]);
    expect(r.summary.checks.find((c) => c.id === "L1.TEST")?.error).toBe("RangeError");
  });
  it("an unreadable PDF fails closed instead of being skipped", async () => {
    const files = clean.packet.files.map((f) => (f.formId === "f1040" ? { ...f, bytes: new Uint8Array([1, 2, 3, 4]) } : f));
    const r = await runL1({ ...clean, packet: { ...clean.packet, files } }, []);
    expect(r.status).toBe("failed");
    expect(r.findings.some((f) => f.check === "L1.runner.check-failed" && f.severity === "blocker")).toBe(true);
  });
  it("findings are de-duplicated by key, most serious first, and counted by severity", async () => {
    const dup: L1Check = { id: "L1.DUP", description: "Two findings with one key", run: () => [sample("L1.X.a", "info"), sample("L1.X.a", "blocker"), sample("L1.X.b", "info")] };
    const r = await runL1(clean, [dup]);
    expect(r.findings.map((f) => `${f.severity}:${f.check}`)).toEqual(["blocker:L1.X.a", "info:L1.X.b"]);
    expect(r.summary.counts).toEqual({ blocker: 1, high: 0, medium: 0, low: 0, info: 1 });
  });
  it("the summary is counts and coverage only", async () => {
    const r = await runL1(rich);
    const json = JSON.stringify(r.summary);
    expect(json).not.toMatch(/Sample|Alpine|Brewery|11-1111111|\d{7,}/);
    expect(r.summary.coverage.pdfFilesRead).toBe(rich.packet.files.length - 1);
    expect(r.summary.coverage.footingRules).toBeGreaterThan(100);
    expect(r.summary.coverage.documentsRead).toBe(rich.raw?.documents.length);
    expect(r.summary.version).toBe(1);
  });
  it("the full run on the clean fixture: every check ran, no medium or higher finding", async () => {
    const r = await runL1(clean);
    expect(r.status).toBe("completed");
    expect(r.findings.filter((f) => f.severity === "blocker" || f.severity === "high" || f.severity === "medium")).toEqual([]);
  });
});

describe("what the reviewer writes", () => {
  it("never implies a professional reviewed the return (no CPA / certified / licensed / approved wording) and never mentions the AI as preparer", async () => {
    const all = [...(await runL1(clean)).findings, ...(await runL1(rich)).findings];
    expect(all.length).toBeGreaterThan(5);
    for (const f of all) {
      const text = [f.message, f.recommendedAction, ...f.evidence.map((e) => e.note ?? ""), ...f.citation.sources.map((s) => s.quote ?? "")].join(" ");
      expect(text, f.check).not.toMatch(/\bCPA\b|certified|licensed|professionally reviewed|CPA-approved|audit-proof|guaranteed/i);
    }
  });
  it("findings stay free of SSN-like, EIN-like and long digit text", async () => {
    const all = [...(await runL1(clean)).findings, ...(await runL1(rich)).findings];
    const json = JSON.stringify(all);
    expect(json).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b/);
  });
});

describe("lib/tax-review/** is pure", () => {
  const root = path.join(process.cwd(), "lib", "tax-review");
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });
  }
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("no DB, no network, no file access, no clock, no randomness, no environment", () => {
    const files = walk(root);
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const src = strip(readFileSync(file, "utf8"));
      for (const banned of [/@\/lib\/db\b/, /@prisma\/client/, /from "node:fs"/, /from "fs"/, /\bfetch\(/, /Date\.now\(/, /new Date\(\)/, /Math\.random\(/, /process\.env/, /@anthropic-ai/]) {
        expect(banned.test(src), `${path.relative(process.cwd(), file)} matches ${banned}`).toBe(false);
      }
    }
  });
  it("no `any` and no non-null `as never` shortcuts in the review modules", () => {
    for (const file of walk(root)) {
      const src = strip(readFileSync(file, "utf8"));
      expect(/:\s*any\b|<any>|as any\b/.test(src), path.relative(process.cwd(), file)).toBe(false);
    }
  });
});
