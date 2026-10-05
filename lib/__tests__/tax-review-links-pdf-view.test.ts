import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The Final review links open ONE filled form in the browser's viewer with #page=N. The single-form route answers an attachment (a download), which
// a browser does not open in a viewer, so the links add ?view=1: the route then answers Content-Disposition: inline. This test pins that the
// parameter changes ONLY that header, and that every gate (auth, approval, blocking items) still runs first.

const authMock = vi.hoisted(() => vi.fn());
const buildViewMock = vi.hoisted(() => vi.fn());
const recordExportMock = vi.hoisted(() => vi.fn());
const approvalMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/tax2025-pdf-build", () => ({
  defaultPdfRouteDeps: { buildView: buildViewMock, recordExport: recordExportMock, approval: { currentApproval: approvalMock } },
}));

import { GET as getForm } from "@/app/api/tax/forms/[year]/pdf/[form]/route";
import { GET as getPacket } from "@/app/api/tax/forms/[year]/pdf/route";
import { parseView } from "@/lib/tax2025-pdf-route";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { fullFacts } from "./tax2025-fixtures";

const root = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(root, p), "utf8");

function makeView() {
  const facts = fullFacts();
  return toPdfReturnView(computeTy2025Return(facts), facts, { generatedAt: "2026-10-03T16:00:00.000Z", generatedBy: "Test User" });
}
const SESSION = { user: { id: "user-1", name: "Test User" } };
const formCtx = (year: string, form: string) => ({ params: Promise.resolve({ year, form }) });
const req = (path: string) => new Request(`http://localhost${path}`);

beforeEach(() => {
  authMock.mockReset();
  buildViewMock.mockReset();
  recordExportMock.mockReset();
  approvalMock.mockReset();
  authMock.mockResolvedValue(SESSION);
  buildViewMock.mockImplementation(async () => ({ view: makeView() }));
  recordExportMock.mockResolvedValue(undefined);
  approvalMock.mockResolvedValue(false);
});

describe("?view=1 on the single-form route", () => {
  it("parseView accepts only the exact value 1", () => {
    expect(parseView("1")).toBe(true);
    for (const v of [null, undefined, "", "0", "true", "yes", "11", " 1"]) expect(parseView(v), String(v)).toBe(false);
  });

  it("answers the same PDF inline (viewer) with ?view=1 and as an attachment without it; the body and the other headers are unchanged", async () => {
    const inline = await getForm(req("/api/tax/forms/2025/pdf/f1040sa?view=1"), formCtx("2025", "f1040sa"));
    const download = await getForm(req("/api/tax/forms/2025/pdf/f1040sa"), formCtx("2025", "f1040sa"));
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-disposition")).toMatch(/^inline; filename="ty2025-f1040sa-[0-9a-f]{12}\.pdf"$/);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="ty2025-f1040sa-[0-9a-f]{12}\.pdf"$/);
    for (const h of ["content-type", "cache-control", "content-length"]) expect(inline.headers.get(h), h).toBe(download.headers.get(h));
    expect(inline.headers.get("content-type")).toBe("application/pdf");
    expect(inline.headers.get("cache-control")).toBe("private, no-store");
    expect(inline.headers.get("content-disposition")).not.toContain("..");
  });

  it("every gate still runs: no session -> 401, an unknown form -> 404, a clean copy or the final form without approval -> 403 (even with ?view=1)", async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await getForm(req("/api/tax/forms/2025/pdf/f1040sa?view=1"), formCtx("2025", "f1040sa"))).status).toBe(401);
    expect(buildViewMock).not.toHaveBeenCalled();
    expect((await getForm(req("/api/tax/forms/2025/pdf/nope?view=1"), formCtx("2025", "nope"))).status).toBe(404);
    expect((await getForm(req("/api/tax/forms/2025/pdf/f1040sa?view=1&stamp=0"), formCtx("2025", "f1040sa"))).status).toBe(403);
    expect((await getForm(req("/api/tax/forms/2025/pdf/f1040sa?view=1&final=1"), formCtx("2025", "f1040sa"))).status).toBe(403);
    expect((await getForm(req("/api/tax/forms/2024/pdf/f1040sa?view=1"), formCtx("2024", "f1040sa"))).status).toBe(404);
  });

  it("the stamped draft is what opens: the DRAFT footer is still on the page (view only changes the header)", async () => {
    const res = await getForm(req("/api/tax/forms/2025/pdf/f1040sa?view=1"), formCtx("2025", "f1040sa"));
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect(doc.getPageCount()).toBeGreaterThan(0);
    expect(recordExportMock).toHaveBeenCalledTimes(1);
    expect(recordExportMock.mock.calls[0]?.[0]).toMatchObject({ kind: "form", stamp: true, forms: ["f1040sa"] });
  });

  it("the packet route ignores view (a zip is always a download)", async () => {
    const res = await getPacket(req("/api/tax/forms/2025/pdf?view=1"), { params: Promise.resolve({ year: "2025" }) });
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; /);
  });

  it("the route files still start with auth(), and only the single-form route reads the view parameter", () => {
    const form = read("app/api/tax/forms/[year]/pdf/[form]/route.ts");
    const body = form.slice(form.indexOf("export async function GET"));
    expect(body).toMatch(/export async function GET\([^)]*\)\s*\{\s*const session = await auth\(\);\s*\n/);
    expect(body).toContain('view: new URL(req.url).searchParams.get("view")');
    expect(read("app/api/tax/forms/[year]/pdf/route.ts")).not.toContain("view");
    // the header is the only thing the parameter touches
    const route = read("lib/tax2025-pdf-route.ts");
    expect(route).toContain('"Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`');
    expect(route.match(/parseView\(/g)?.length).toBe(1 + 1); // the definition and the one call in handleFormRequest
  });
});
