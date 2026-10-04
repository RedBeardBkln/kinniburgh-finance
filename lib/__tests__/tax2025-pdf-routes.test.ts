import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync } from "fflate";
import { PDFDocument, PDFTextField } from "pdf-lib";

// Mocks at the auth/db boundary only (repo convention: no integrated DB tests). The
// real route files, the real handlers, the real adapter and the real PDF engine run.
const authMock = vi.hoisted(() => vi.fn());
const buildViewMock = vi.hoisted(() => vi.fn());
const recordExportMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/tax2025-pdf-build", () => ({
  defaultPdfRouteDeps: { buildView: buildViewMock, recordExport: recordExportMock },
}));

import { GET as getPacket } from "@/app/api/tax/forms/[year]/pdf/route";
import { GET as getForm } from "@/app/api/tax/forms/[year]/pdf/[form]/route";
import {
  PACKET_EXPORT_CHANGE_TYPE,
  handleFormRequest,
  handlePacketRequest,
  parseStamp,
  parseYear,
  servableFormIds,
  type PacketExportAudit,
  type PdfRouteDeps,
} from "@/lib/tax2025-pdf-route";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { listFormIds } from "@/lib/tax2025/pdf/registry";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { fullFacts } from "./tax2025-fixtures";

const root = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(root, p), "utf8");
const PACKET_ROUTE = "app/api/tax/forms/[year]/pdf/route.ts";
const FORM_ROUTE = "app/api/tax/forms/[year]/pdf/[form]/route.ts";

function makeView() {
  const facts = fullFacts();
  return toPdfReturnView(computeTy2025Return(facts), facts, {
    generatedAt: "2026-10-03T16:00:00.000Z",
    generatedBy: "Test User",
  });
}

const SESSION = { user: { id: "user-1", name: "Test User" } };
const packetCtx = (year: string) => ({ params: Promise.resolve({ year }) });
const formCtx = (year: string, form: string) => ({ params: Promise.resolve({ year, form }) });
const req = (path: string) => new Request(`http://localhost${path}`);

beforeEach(() => {
  authMock.mockReset();
  buildViewMock.mockReset();
  recordExportMock.mockReset();
  buildViewMock.mockImplementation(async () => ({ view: makeView() }));
  recordExportMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("route source: auth first, nothing before it", () => {
  for (const file of [PACKET_ROUTE, FORM_ROUTE]) {
    describe(file, () => {
      const src = read(file);
      const body = src.slice(src.indexOf("export async function GET"));

      it("auth() is the first statement of GET and a missing session returns 401", () => {
        expect(body).toMatch(/export async function GET\([^)]*\)\s*\{\s*const session = await auth\(\);\s*\n/);
        expect(body).toMatch(/if \(!session\?\.user\?\.id\) return new NextResponse\("Unauthorized", \{ status: 401 \}\);/);
        // The 401 check precedes anything that could read data or parse the request.
        expect(body.indexOf("status: 401")).toBeLessThan(body.indexOf("await params"));
        expect(body.indexOf("status: 401")).toBeLessThan(body.indexOf("new URL("));
      });

      it("imports auth from the app's auth module, uses the Node runtime and a bounded duration", () => {
        expect(src).toContain('import { auth } from "@/lib/auth";');
        expect(src).toContain('export const runtime = "nodejs";');
        expect(src).toContain("export const maxDuration = 60;");
        expect(src).toContain('export const dynamic = "force-dynamic";');
      });

      it("is read-only: no db import, no write calls, no logging", () => {
        expect(src).not.toMatch(/@\/lib\/db|prisma|\.create\(|\.update\(|\.delete|console\./);
      });
    });
  }

  it("exports only the Next route fields (handlers and config)", () => {
    for (const file of [PACKET_ROUTE, FORM_ROUTE]) {
      const exports = [...read(file).matchAll(/^export (?:async function|const) (\w+)/gm)].map((m) => m[1]);
      expect(exports.sort()).toEqual(["GET", "dynamic", "maxDuration", "runtime"]);
    }
  });
});

describe("unauthenticated requests are rejected before any work", () => {
  const cases: Array<[string, unknown]> = [
    ["no session", null],
    ["session without a user", {}],
    ["user without an id", { user: { name: "Nobody" } }],
  ];
  for (const [label, session] of cases) {
    it(`packet route: ${label} -> 401, no build, no audit`, async () => {
      authMock.mockResolvedValue(session);
      const res = await getPacket(req("/api/tax/forms/2025/pdf"), packetCtx("2025"));
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type") ?? "").not.toMatch(/zip|pdf/);
      expect(buildViewMock).not.toHaveBeenCalled();
      expect(recordExportMock).not.toHaveBeenCalled();
    });
    it(`form route: ${label} -> 401, no build, no audit`, async () => {
      authMock.mockResolvedValue(session);
      const res = await getForm(req("/api/tax/forms/2025/pdf/f1040"), formCtx("2025", "f1040"));
      expect(res.status).toBe(401);
      expect(buildViewMock).not.toHaveBeenCalled();
      expect(recordExportMock).not.toHaveBeenCalled();
    });
  }

  it("401 even for invalid years or unknown forms (auth is decided first)", async () => {
    authMock.mockResolvedValue(null);
    expect((await getPacket(req("/x"), packetCtx("1999"))).status).toBe(401);
    expect((await getForm(req("/x"), formCtx("2025", "nope"))).status).toBe(401);
  });
});

describe("packet route (authenticated, injected builder)", () => {
  beforeEach(() => authMock.mockResolvedValue(SESSION));

  it("returns the zip with the attachment, content-type and no-store headers", async () => {
    const res = await getPacket(req("/api/tax/forms/2025/pdf"), packetCtx("2025"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="ty2025-draft-packet-[0-9a-f]{12}\.zip"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Number(res.headers.get("content-length"))).toBe(bytes.length);
    const files = unzipSync(bytes);
    const names = Object.keys(files);
    expect(names[0]).toBe("00-cover.pdf");
    expect(names).toContain("01-f1040.pdf");
    for (const name of names) {
      const f = files[name];
      expect(f).toBeDefined();
      expect(new TextDecoder().decode((f as Uint8Array).slice(0, 5))).toBe("%PDF-");
      await PDFDocument.load(f as Uint8Array); // every PDF in the zip loads
    }
    expect(buildViewMock).toHaveBeenCalledWith(2025, "Test User");
  });

  it("?stamp=0 gives a clean copy: different form bytes, '-clean' file name, audit says stamp false", async () => {
    const stamped = unzipSync(new Uint8Array(await (await getPacket(req("/p"), packetCtx("2025"))).arrayBuffer()));
    const res = await getPacket(req("/api/tax/forms/2025/pdf?stamp=0"), packetCtx("2025"));
    expect(res.headers.get("content-disposition")).toMatch(/-clean\.zip"$/);
    const clean = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Buffer.from(clean["01-f1040.pdf"] as Uint8Array).equals(Buffer.from(stamped["01-f1040.pdf"] as Uint8Array))).toBe(false);
    const audits = recordExportMock.mock.calls.map((c) => c[0] as PacketExportAudit);
    expect(audits.map((a) => a.stamp)).toEqual([true, false]);
  });

  it("writes exactly one audit entry with ids and counts only, never a value", async () => {
    await getPacket(req("/api/tax/forms/2025/pdf"), packetCtx("2025"));
    expect(recordExportMock).toHaveBeenCalledTimes(1);
    const entry = recordExportMock.mock.calls[0]?.[0] as PacketExportAudit;
    expect(Object.keys(entry).sort()).toEqual(
      ["engineVersion", "fileCount", "fingerprint", "forms", "kind", "openItemCount", "stamp", "taxYear", "userId"].sort(),
    );
    expect(entry.userId).toBe("user-1");
    expect(entry.kind).toBe("packet");
    expect(entry.taxYear).toBe(2025);
    expect(entry.forms).toContain("f1040");
    expect(entry.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // No amount from the return, no name, no free text anywhere in the serialised entry.
    const json = JSON.stringify(entry);
    const view = makeView();
    for (const line of Object.values(view.lines)) {
      if (line && line.amount !== null && Math.abs(line.amount) >= 10_000) expect(json).not.toContain(String(line.amount));
    }
    expect(json).not.toMatch(/Eric|Eva|Test User/);
  });

  it("the change type constant is tax_packet_export", () => {
    expect(PACKET_EXPORT_CHANGE_TYPE).toBe("tax_packet_export");
    expect(read("lib/tax2025-pdf-build.ts")).toContain("changeType: PACKET_EXPORT_CHANGE_TYPE");
  });

  it("year validation: only 2025 is served (404 for other valid years, 400 for malformed), nothing is built", async () => {
    expect((await getPacket(req("/x"), packetCtx("2024"))).status).toBe(404);
    expect((await getPacket(req("/x"), packetCtx("2026"))).status).toBe(404);
    expect((await getPacket(req("/x"), packetCtx("abcd"))).status).toBe(400);
    expect((await getPacket(req("/x"), packetCtx("202"))).status).toBe(400);
    expect((await getPacket(req("/x"), packetCtx("2025.0"))).status).toBe(400);
    expect(buildViewMock).not.toHaveBeenCalled();
    expect(recordExportMock).not.toHaveBeenCalled();
  });

  it("a builder error becomes a 500 JSON without a file and without an audit row", async () => {
    buildViewMock.mockResolvedValue({ error: "Personal entity not found" });
    const res = await getPacket(req("/x"), packetCtx("2025"));
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ error: "Personal entity not found" });
    expect(recordExportMock).not.toHaveBeenCalled();
  });

  it("an audit failure refuses the export (500, no file)", async () => {
    recordExportMock.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await getPacket(req("/x"), packetCtx("2025"));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/json/);
  });

  it("never logs or returns the message of an unexpected error (it could quote a value)", async () => {
    buildViewMock.mockRejectedValue(new RangeError("formatDollars needs a whole-dollar integer, got 12345.67 for 123-45-6789"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await getPacket(req("/x"), packetCtx("2025"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("12345.67");
    expect(text).not.toContain("123-45-6789");
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain("12345.67");
    expect(logged).not.toContain("123-45-6789");
    expect(logged).toContain("RangeError");
  });
});

describe("single-form route (authenticated, injected builder)", () => {
  beforeEach(() => authMock.mockResolvedValue(SESSION));

  it("returns the filled PDF with the headers and a loadable AcroForm", async () => {
    const res = await getForm(req("/api/tax/forms/2025/pdf/f1040"), formCtx("2025", "f1040"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="ty2025-f1040-[0-9a-f]{12}\.pdf"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    const filled = doc
      .getForm()
      .getFields()
      .filter((f): f is PDFTextField => f instanceof PDFTextField && (f.getText() ?? "") !== "");
    expect(filled.length).toBeGreaterThan(5);
    const entry = recordExportMock.mock.calls[0]?.[0] as PacketExportAudit;
    expect(entry.kind).toBe("form");
    expect(entry.forms).toEqual(["f1040"]);
    expect(entry.fileCount).toBe(1);
  });

  it("?stamp=0 changes the bytes and the file name", async () => {
    const a = new Uint8Array(await (await getForm(req("/x"), formCtx("2025", "f1040"))).arrayBuffer());
    const res = await getForm(req("/x?stamp=0"), formCtx("2025", "f1040"));
    expect(res.headers.get("content-disposition")).toMatch(/-clean\.pdf"$/);
    const b = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("form id whitelist: unknown, malformed, traversal, wrong case and manifest forms without a map -> 404, nothing built", async () => {
    const mapped = new Set(FORM_MAPS.map((m) => m.formId));
    const unmappedManifestForm = listFormIds().find((id) => !mapped.has(id));
    expect(unmappedManifestForm).toBeDefined();
    const bad = ["f9999", "../manifest", "..%2Fmanifest", "F1040", "f1040.pdf", "f1040/../f1040s1", "", " ", unmappedManifestForm as string];
    for (const form of bad) {
      const res = await getForm(req("/x"), formCtx("2025", form));
      expect(res.status, `form "${form}"`).toBe(404);
    }
    expect(buildViewMock).not.toHaveBeenCalled();
    expect(recordExportMock).not.toHaveBeenCalled();
  });

  it("year validation applies to the form route too", async () => {
    expect((await getForm(req("/x"), formCtx("2024", "f1040"))).status).toBe(404);
    expect((await getForm(req("/x"), formCtx("x", "f1040"))).status).toBe(400);
    expect(buildViewMock).not.toHaveBeenCalled();
  });
});

describe("handlers with a fully injected dependency set (no auth, no DB)", () => {
  it("serve from a stub builder and an in-memory audit sink", async () => {
    const audits: PacketExportAudit[] = [];
    const deps: PdfRouteDeps = {
      buildView: async () => ({ view: makeView() }),
      recordExport: async (e) => {
        audits.push(e);
      },
      maps: FORM_MAPS,
    };
    const res = await handlePacketRequest({ year: "2025", stamp: null, user: { id: "u", name: "U" } }, deps);
    expect(res.status).toBe(200);
    const res2 = await handleFormRequest({ year: "2025", form: "f1040", stamp: "0", user: { id: "u", name: "U" } }, deps);
    expect(res2.status).toBe(200);
    expect(audits.map((a) => a.kind)).toEqual(["packet", "form"]);
  });

  it("an empty map list still yields a cover-only packet; a form request then 404s", async () => {
    const deps: PdfRouteDeps = {
      buildView: async () => ({ view: makeView() }),
      recordExport: async () => undefined,
      maps: [],
    };
    const res = await handlePacketRequest({ year: "2025", stamp: null, user: { id: "u", name: "U" } }, deps);
    expect(Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())))).toEqual(["00-cover.pdf"]);
    expect((await handleFormRequest({ year: "2025", form: "f1040", stamp: null, user: { id: "u", name: "U" } }, deps)).status).toBe(404);
  });

  it("parseYear / parseStamp / servableFormIds", () => {
    expect(parseYear("2025")).toEqual({ ok: true, year: 2025 });
    expect(parseYear("2024")).toMatchObject({ ok: false, status: 404 });
    expect(parseYear("20255")).toMatchObject({ ok: false, status: 400 });
    expect(parseStamp(null)).toBe(true);
    expect(parseStamp("1")).toBe(true);
    expect(parseStamp("0")).toBe(false);
    expect(servableFormIds(FORM_MAPS)).toEqual(FORM_MAPS.map((m) => m.formId));
    expect(servableFormIds(FORM_MAPS).every((id) => listFormIds().includes(id))).toBe(true);
  });
});

describe("next.config: the blank forms ship with the PDF routes", () => {
  it("outputFileTracingIncludes covers data/forms for /api/tax/forms/**", () => {
    const cfg = read("next.config.ts");
    expect(cfg).toContain("outputFileTracingIncludes");
    expect(cfg).toContain('"/api/tax/forms/**"');
    expect(cfg).toContain('"./data/forms/**/*"');
  });
});

describe("download buttons component and its mount", () => {
  const src = read("components/tax/forms/pdf-download-buttons.tsx");
  const page = read("app/tax/forms/[year]/page.tsx");

  it("has the three kinds of plain links with the DRAFT / CPA-review wording and no confirm dialog", () => {
    expect(src).toContain("Download filing packet (zip)");
    expect(src).toContain("Download clean copy (no DRAFT footer)");
    expect(src).toContain("`${base}?stamp=0`");
    expect(src).toContain("`${base}/${m.formId}`");
    expect(src).toContain("DRAFT for CPA review");
    expect(src).toMatch(/CPA is the preparer of record/);
    expect(src).toMatch(/not tax advice/);
    expect(src).toMatch(/social security numbers, EINs, bank numbers, signatures and PINs are always left blank/);
    expect(src).not.toMatch(/window\.confirm|confirm\(|"use client"|onClick/);
    expect(src).toContain("/api/tax/forms/${year}/pdf");
  });

  it("renders nothing for a year other than the supported one", () => {
    expect(src).toMatch(/if \(year !== PDF_SUPPORTED_YEAR\) return null;/);
    expect(src).toContain("export const PDF_SUPPORTED_YEAR = 2025;");
  });

  it("is mounted on the Forms page header area for 2025 only", () => {
    expect(page).toContain('import { PDF_SUPPORTED_YEAR, PdfDownloadButtons } from "@/components/tax/forms/pdf-download-buttons";');
    expect(page).toContain("{year === PDF_SUPPORTED_YEAR ? <PdfDownloadButtons year={year} /> : null}");
    // Between the header block and the summary, i.e. in the header area, above the form cards.
    expect(page.indexOf("<PdfDownloadButtons")).toBeLessThan(page.indexOf("<FormsSummary"));
    expect(page.indexOf("<PdfDownloadButtons")).toBeGreaterThan(page.indexOf("CPA summary"));
  });
});
