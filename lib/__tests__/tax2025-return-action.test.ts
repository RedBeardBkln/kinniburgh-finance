import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Mocks at the auth / loader boundary (repo convention: no integrated DB tests). The real
// lib/tax2025-build.ts (DB-aware) is never imported: it is replaced by an injected fake.
const authMock = vi.hoisted(() => vi.fn());
const buildMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/tax2025-build", () => ({ buildTy2025Return: buildMock }));

import { exportTaxReturnCsv } from "@/actions/tax-return";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { emptyFacts, fullFacts1b } from "@/lib/__tests__/tax2025-fixtures";

const USER = "11111111-1111-4111-8111-111111111111";
const src = readFileSync(resolve(__dirname, "../../actions/tax-return.ts"), "utf8").replace(/\r\n/g, "\n");

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  buildMock.mockResolvedValue({ ret: computeTy2025Return(fullFacts1b()), raw: { documents: [] } });
});

describe("exportTaxReturnCsv", () => {
  it("rejects an unauthenticated caller before computing anything", async () => {
    authMock.mockResolvedValue(null);
    await expect(exportTaxReturnCsv(2025)).rejects.toThrow("Unauthorized");
    authMock.mockResolvedValue({ user: {} });
    await expect(exportTaxReturnCsv(2025)).rejects.toThrow("Unauthorized");
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("returns the CSV text and a DRAFT filename for 2025", async () => {
    const res = await exportTaxReturnCsv(2025);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(buildMock).toHaveBeenCalledWith(2025);
    expect(res.filename).toBe("ty2025-cpa-review-sheet-DRAFT.csv");
    expect(res.csv.startsWith("form,line_id,line_key,label,amount,status,provenance,citation_reason,override_amount,override_by,override_at,override_reason\r\n")).toBe(true);
    expect(res.csv).toContain("DRAFT NOTICE");
  });

  it("exports unresolved lines with an empty amount, never 0", async () => {
    buildMock.mockResolvedValue({ ret: computeTy2025Return(emptyFacts()), raw: { documents: [] } });
    const res = await exportTaxReturnCsv(2025);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const line = res.csv.split("\r\n").find((l) => l.includes(",f1040.1a,"));
    expect(line).toBeDefined();
    expect(line).toMatch(/^Form 1040,1a,f1040\.1a,("[^"]*"|[^,]*),,missing input,/);
  });

  it("validates the year with zod (garbage never reaches the builder) and says TY2025 only for other years", async () => {
    for (const bad of [Number.NaN, 1999, 2101, 2025.5, Infinity]) {
      const res = await exportTaxReturnCsv(bad);
      expect(res).toEqual({ ok: false, error: "Invalid tax year" });
    }
    expect(await exportTaxReturnCsv(2024)).toEqual({ ok: false, error: "The return engine is TY2025 only" });
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("surfaces a builder error without a stack or row data", async () => {
    buildMock.mockResolvedValue({ error: "Personal entity not found" });
    expect(await exportTaxReturnCsv(2025)).toEqual({ ok: false, error: "Personal entity not found" });
  });
});

describe("source checks: actions/tax-return.ts", () => {
  it('is a "use server" file and every exported function starts with `await requireAuth();`', () => {
    expect(src.startsWith('"use server";')).toBe(true);
    const names = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    expect(names).toEqual(["exportTaxReturnCsv"]);
    for (const name of names) {
      const start = src.indexOf(`export async function ${name}`);
      const body = src.slice(src.indexOf("{\n", start) + 2, src.indexOf("{\n", start) + 80);
      expect(body.trimStart().startsWith("await requireAuth();"), name).toBe(true);
    }
    // requireAuth throws when there is no session (same shape as the sibling actions)
    expect(src).toMatch(/if \(!session\?\.user\?\.id\) throw new Error\("Unauthorized"\);/);
  });

  it("validates the year with zod before any other use", () => {
    expect(src).toMatch(/import \{ z \} from "zod";/);
    expect(src).toMatch(/const yearSchema = z\.number\(\)\.int\(\)\.min\(2000\)\.max\(2100\);/);
    expect(src.indexOf("yearSchema.safeParse(year)")).toBeLessThan(src.indexOf("loadSheet("));
  });

  it("is read-only: no db client, no writes, no confirm dialog", () => {
    expect(src).not.toMatch(/@\/lib\/db|\.create\(|\.update\(|\.delete\(|\.upsert\(|revalidatePath/);
    expect(src).not.toMatch(/window\.confirm|\bconfirm\(/);
  });
});
