import { vi } from "vitest";
vi.setConfig({ testTimeout: 120000 });
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync } from "fflate";
import { makeApprovalLookup } from "@/lib/tax-review-approval-lookup";
import type { ApprovalDbRow, ReviewStoreDb } from "@/lib/tax-review-store";
import { CLEAN_COPY_REFUSED } from "@/lib/tax2025-pdf-approval";
import { handleFormRequest, handlePacketRequest, type PacketExportAudit, type PdfRouteDeps } from "@/lib/tax2025-pdf-route";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import type { PdfReturnView } from "@/lib/tax2025/pdf/types";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { fullFacts } from "./tax2025-fixtures";

// The clean-copy / final-package routes against the REAL approval state machine (lib/tax-review-store.ts findCurrentApproval over
// an in-memory approvals table): 403 before an approval, the final package after one for the current fingerprint, and 403 again
// after the return changes (another fingerprint) or the approval is withdrawn. No database, no network; the routes' own auth()-first
// behaviour is pinned in tax2025-pdf-routes.test.ts.

const root = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");

const ENTITY = "22222222-2222-4222-8222-222222222222";
const FP = "c".repeat(64);
const OTHER_FP = "d".repeat(64);
const USER = { id: "user-1", name: "Test User" };

function makeView(fingerprint: string): PdfReturnView {
  const facts = fullFacts();
  const view = toPdfReturnView(computeTy2025Return(facts), facts, { generatedAt: "2026-10-08T16:00:00.000Z", generatedBy: "Test User" });
  // production does the same: buildPdfViewForYear puts the return fingerprint v2 into view.fingerprint
  return { ...view, fingerprint };
}

let seq = 0;
function approvalRow(kind: "approved" | "withdrawn", fingerprint: string, minute: number): ApprovalDbRow {
  seq += 1;
  return {
    id: `row-${seq}`,
    taxYear: 2025,
    entityId: ENTITY,
    kind,
    runId: "run-1",
    fingerprint,
    verdictSnapshot: {},
    attestationVersion: kind === "approved" ? "v1" : null,
    attestationTextHash: kind === "approved" ? "e".repeat(64) : null,
    typedConfirmationHash: kind === "approved" ? "f".repeat(64) : null,
    reason: kind === "withdrawn" ? "Starting over." : null,
    approvedById: "user-1",
    approvedByName: "Eric Kinniburgh",
    at: new Date(Date.UTC(2026, 9, 9, 12, minute)),
  };
}

function fakeStore(rows: ApprovalDbRow[], reads: { n: number }, fail = false): ReviewStoreDb {
  return {
    taxReturnApproval: {
      findMany: async (args: { where: { taxYear: number; entityId: string } }) => {
        reads.n += 1;
        if (fail) throw new RangeError("db down: 123-45-6789");
        return rows.filter((r) => r.taxYear === args.where.taxYear && r.entityId === args.where.entityId);
      },
      create: async () => {
        throw new Error("the lookup never writes");
      },
    },
  } as unknown as ReviewStoreDb;
}

function harness(view: PdfReturnView, rows: ApprovalDbRow[], opts: { fail?: boolean } = {}) {
  const reads = { n: 0 };
  const audits: PacketExportAudit[] = [];
  const lookup = makeApprovalLookup({ resolveEntityId: async () => ENTITY, store: fakeStore(rows, reads, opts.fail === true) });
  const asked: string[] = [];
  const spied = {
    currentApproval: (fp: string) => {
      asked.push(fp);
      return lookup.currentApproval(fp);
    },
    approvedAt: (fp: string) => lookup.approvedAt?.(fp) ?? Promise.resolve(null),
  };
  const deps: PdfRouteDeps = { buildView: async () => ({ view }), recordExport: async (e) => void audits.push(e), maps: FORM_MAPS, approval: spied };
  return { deps, audits, reads, asked };
}

afterEach(() => vi.restoreAllMocks());

const finalReq = { year: "2025", stamp: null, final: "1", user: USER };
const cleanReq = { year: "2025", stamp: "0", user: USER };

describe("approval store -> clean-copy routes", () => {
  it("403 before any approval (both clean routes and the single form), the stamped draft stays available", async () => {
    const { deps, audits } = harness(makeView(FP), []);
    for (const req of [finalReq, cleanReq]) {
      const res = await handlePacketRequest(req, deps);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: CLEAN_COPY_REFUSED });
    }
    expect((await handleFormRequest({ ...finalReq, form: "f1040" }, deps)).status).toBe(403);
    expect((await handleFormRequest({ ...cleanReq, form: "f1040" }, deps)).status).toBe(403);
    expect((await handlePacketRequest({ year: "2025", stamp: null, user: USER }, deps)).status).toBe(200);
    expect(audits.map((a) => a.kind)).toEqual(["packet"]);
  });

  it("200 and the final package after a current approval; the approval date reaches the package build", async () => {
    const rows = [approvalRow("approved", FP, 5)];
    const h = harness(makeView(FP), rows);
    const res = await handlePacketRequest(finalReq, h.deps);
    expect(res.status).toBe(200);
    const names = Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())));
    expect(names[0]).toBe("00-package-index.pdf");
    expect(h.asked).toEqual([FP]);
    expect(h.audits.map((a) => [a.kind, a.fingerprint])).toEqual([["final", FP]]);
    // the date comes from the stored approval row, through the same lookup
    const lookup = makeApprovalLookup({ resolveEntityId: async () => ENTITY, store: fakeStore(rows, { n: 0 }) });
    expect(await lookup.approvedAt?.(FP)).toBe("2026-10-09T12:05:00.000Z");
    expect(await lookup.approvedAt?.(OTHER_FP)).toBeNull();
    // and the single form
    expect((await handleFormRequest({ ...finalReq, form: "f1040" }, h.deps)).status).toBe(200);
  });

  it("403 again when the return changes after the approval (another fingerprint), without deleting the approval", async () => {
    const rows = [approvalRow("approved", FP, 5)];
    const h = harness(makeView(OTHER_FP), rows);
    const res = await handlePacketRequest(finalReq, h.deps);
    expect(res.status).toBe(403);
    expect((await handlePacketRequest(cleanReq, h.deps)).status).toBe(403);
    expect(rows).toHaveLength(1);
    expect(h.audits).toEqual([]);
  });

  it("403 again after the approval is withdrawn (a withdrawal row is appended), 200 again after a fresh approval", async () => {
    const rows = [approvalRow("approved", FP, 5), approvalRow("withdrawn", FP, 10)];
    const view = makeView(FP);
    expect((await handlePacketRequest(finalReq, harness(view, rows).deps)).status).toBe(403);
    rows.push(approvalRow("approved", FP, 15));
    expect((await handlePacketRequest(finalReq, harness(view, rows).deps)).status).toBe(200);
    expect(rows.map((r) => r.kind)).toEqual(["approved", "withdrawn", "approved"]);
  });

  it("an approval for ANOTHER fingerprint (the latest approval is stale) does not open the current return", async () => {
    const rows = [approvalRow("approved", FP, 5), approvalRow("approved", OTHER_FP, 10)];
    expect((await handlePacketRequest(finalReq, harness(makeView(FP), rows).deps)).status).toBe(403);
    expect((await handlePacketRequest(finalReq, harness(makeView(OTHER_FP), rows).deps)).status).toBe(200);
  });

  it("a store failure is a refusal (fail closed): 403, and the thrown text is never logged", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    const h = harness(makeView(FP), [approvalRow("approved", FP, 5)], { fail: true });
    const res = await handlePacketRequest(finalReq, h.deps);
    expect(res.status).toBe(403);
    expect(errors.join("\n")).not.toContain("123-45-6789");
    expect(errors.join("\n")).toContain("RangeError");
  });

  it("a fingerprint that is not 64 hex never reaches the store", async () => {
    const h = harness(makeView("not-a-fingerprint"), [approvalRow("approved", FP, 5)]);
    expect((await handlePacketRequest(finalReq, h.deps)).status).toBe(403);
    expect(h.reads.n).toBe(0);
  });

  it("only the Personal entity's approvals count, and only tax year 2025", async () => {
    const other = { ...approvalRow("approved", FP, 5), entityId: "99999999-9999-4999-8999-999999999999" };
    const wrongYear = { ...approvalRow("approved", FP, 6), taxYear: 2024 };
    expect((await handlePacketRequest(finalReq, harness(makeView(FP), [other, wrongYear]).deps)).status).toBe(403);
  });
});

describe("where the fingerprint comes from", () => {
  it("buildPdfViewForYear computes fingerprint v2 on the server from the same read as the view, and the production deps use the store lookup", () => {
    const src = read("lib/tax2025-pdf-build.ts");
    expect(src).toContain("loadReviewInputs(year, generatedBy)");
    expect(src).toContain("fingerprint: inputs.fingerprint.fingerprint");
    expect(src).toContain("approval: storeApprovalLookup");
  });
  it("the route files take no fingerprint from the request (no query parameter, header or body reads one)", () => {
    for (const f of ["app/api/tax/forms/[year]/pdf/route.ts", "app/api/tax/forms/[year]/pdf/[form]/route.ts", "lib/tax2025-pdf-route.ts"]) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
      expect(code, f).not.toMatch(/get\(["']fingerprint["']\)|\.fingerprint\s*=\s*req|searchParams[^;]*fingerprint/i);
    }
  });
  it("the lookup is read-only (no create, update, delete or upsert call)", () => {
    const code = read("lib/tax-review-approval-lookup.ts").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
    expect(code).not.toMatch(/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(/);
  });
});
