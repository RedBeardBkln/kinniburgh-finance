// ai-return-reviewer A5: clean copies (?stamp=0) and the final package (?final=1) exist only for an owner-approved
// return. Drives the real handlers with an injected builder, audit sink and ApprovalLookup (no auth, no DB); the route
// files' own `auth()`-first / 401 behaviour is pinned in tax2025-pdf-routes.test.ts.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 90000 });
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { CLEAN_COPY_REFUSED, noApprovalLookup, type ApprovalLookup } from "@/lib/tax2025-pdf-approval";
import {
  FINAL_PACKAGE_CHANGE_TYPE,
  PACKET_EXPORT_CHANGE_TYPE,
  handleFormRequest,
  handlePacketRequest,
  parseFinal,
  type PacketExportAudit,
  type PdfRouteDeps,
} from "@/lib/tax2025-pdf-route";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { getManifestEntry } from "@/lib/tax2025/pdf/registry";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { PdfReturnView } from "@/lib/tax2025/pdf/types";
import { emptyFacts, fullFacts } from "./tax2025-fixtures";

const root = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");

function makeView(facts = fullFacts()): PdfReturnView {
  return toPdfReturnView(computeTy2025Return(facts), facts, { generatedAt: "2026-10-08T16:00:00.000Z", generatedBy: "Test User" });
}

const USER = { id: "user-1", name: "Test User" };

function harness(over: Partial<PdfRouteDeps> & { view?: PdfReturnView } = {}) {
  const audits: PacketExportAudit[] = [];
  const view = over.view ?? makeView();
  const deps: PdfRouteDeps = {
    buildView: async () => ({ view }),
    recordExport: async (e) => {
      audits.push(e);
    },
    maps: FORM_MAPS,
    ...over,
  };
  return { audits, deps, view };
}

/** An approval store that approves exactly one fingerprint, and records what it was asked. */
function approvalFor(fingerprint: string | null): ApprovalLookup & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    currentApproval: async (fp) => {
      asked.push(fp);
      return fingerprint !== null && fp === fingerprint;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("the default is: nothing is approved", () => {
  it("noApprovalLookup approves nothing", async () => {
    expect(await noApprovalLookup.currentApproval("a".repeat(64))).toBe(false);
  });

  it("parseFinal accepts only 1", () => {
    expect(parseFinal("1")).toBe(true);
    for (const v of [null, "", "0", "true", "yes", "2"]) expect(parseFinal(v)).toBe(false);
  });

  it("the production deps use the review store's approval lookup (no longer the nothing-is-approved default)", () => {
    const src = read("lib/tax2025-pdf-build.ts");
    expect(src).toContain("approval: storeApprovalLookup");
    expect(src).not.toContain("noApprovalLookup");
    expect(src).toContain("FINAL_PACKAGE_CHANGE_TYPE");
    expect(FINAL_PACKAGE_CHANGE_TYPE).toBe("tax_final_package_download");
    expect(PACKET_EXPORT_CHANGE_TYPE).toBe("tax_packet_export");
  });

  it("both route files forward ?final= to the handlers (auth() stays their first statement)", () => {
    for (const f of ["app/api/tax/forms/[year]/pdf/route.ts", "app/api/tax/forms/[year]/pdf/[form]/route.ts"]) {
      const src = read(f);
      expect(src).toContain('searchParams.get("final")');
      expect(src.indexOf("await auth()")).toBeLessThan(src.indexOf("searchParams"));
    }
  });
});

describe("packet route", () => {
  it("the stamped draft is served without any approval lookup", async () => {
    const approval = approvalFor(null);
    const { deps, audits } = harness({ approval });
    const res = await handlePacketRequest({ year: "2025", stamp: null, user: USER }, deps);
    expect(res.status).toBe(200);
    expect(approval.asked).toEqual([]);
    expect(audits.map((a) => a.kind)).toEqual(["packet"]);
  });

  it("?stamp=0 and ?final=1 are 403 (JSON, no-store) without an approval, with nothing built or recorded", async () => {
    for (const req of [
      { year: "2025", stamp: "0", user: USER },
      { year: "2025", stamp: null, final: "1", user: USER },
      { year: "2025", stamp: "0", final: "1", user: USER },
    ]) {
      const { deps, audits } = harness(); // no approval dependency at all = default "no approval"
      const res = await handlePacketRequest(req, deps);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type") ?? "").toMatch(/json/);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.json()).toEqual({ error: CLEAN_COPY_REFUSED });
      expect(audits).toEqual([]);
    }
  });

  it("an approval for a DIFFERENT fingerprint (the return changed after approval) does not unlock anything", async () => {
    const approval = approvalFor("f".repeat(64));
    const { deps, view } = harness({ approval });
    for (const req of [
      { year: "2025", stamp: "0", user: USER },
      { year: "2025", stamp: null, final: "1", user: USER },
    ]) {
      expect((await handlePacketRequest(req, deps)).status).toBe(403);
    }
    expect(approval.asked).toEqual([view.fingerprint, view.fingerprint]); // the lookup is asked about the CURRENT fingerprint
  });

  it("an approval lookup that fails is a refusal, and only the error class is logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const approval: ApprovalLookup = { currentApproval: () => Promise.reject(new RangeError("db down: 123-45-6789")) };
    const { deps } = harness({ approval });
    const res = await handlePacketRequest({ year: "2025", stamp: "0", user: USER }, deps);
    expect(res.status).toBe(403);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("RangeError");
    expect(logged).not.toContain("123-45-6789");
  });

  it("?stamp=0 with an approval for the current fingerprint: the clean copies (as before) and a stamp=false audit row", async () => {
    const view = makeView();
    const approval = approvalFor(view.fingerprint);
    const { deps, audits } = harness({ approval, view });
    const res = await handlePacketRequest({ year: "2025", stamp: "0", user: USER }, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/-clean\.zip"$/);
    expect(audits.map((a) => [a.kind, a.stamp])).toEqual([["packet", false]]);
  });

  it("?final=1 with an approval: the final package zip, index first, an audit row of ids / counts / hashes only", async () => {
    const view = makeView();
    const approval = approvalFor(view.fingerprint);
    const { deps, audits } = harness({ approval, view });
    const res = await handlePacketRequest({ year: "2025", stamp: null, final: "1", user: USER }, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="ty2025-final-${view.fingerprint.slice(0, 12)}.zip"`);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const names = Object.keys(files);
    expect(names[0]).toBe("00-package-index.pdf");
    expect(names).toContain("forms/01-f1040.pdf");
    expect(names.some((n) => /draft|cover/i.test(n))).toBe(false);
    expect(audits).toHaveLength(1);
    const a = audits[0] as PacketExportAudit;
    expect(a.kind).toBe("final");
    expect(a.stamp).toBe(false);
    expect(a.fingerprint).toBe(view.fingerprint);
    expect(a.fileCount).toBe(names.length);
    expect(Object.keys(a.fileSha256 ?? {}).sort()).toEqual([...names].sort());
    for (const h of Object.values(a.fileSha256 ?? {})) expect(h).toMatch(/^[0-9a-f]{64}$/);
    // no amount, name or text from the return in the audit entry
    const json = JSON.stringify(a);
    expect(json).not.toMatch(/Eric|Eva|Test User/);
  });

  it("?final=1 is refused (409) while a blocking item remains, even with an approval", async () => {
    const view = makeView(emptyFacts());
    expect(view.openItems.some((i) => i.severity === "blocking")).toBe(true);
    const { deps, audits } = harness({ view, approval: approvalFor(view.fingerprint) });
    const res = await handlePacketRequest({ year: "2025", stamp: null, final: "1", user: USER }, deps);
    expect(res.status).toBe(409);
    expect(audits).toEqual([]);
  });
});

describe("single-form route", () => {
  it("?stamp=0 / ?final=1 are 403 without an approval and the draft form is always served", async () => {
    const { deps, audits } = harness();
    expect((await handleFormRequest({ year: "2025", form: "f1040", stamp: null, user: USER }, deps)).status).toBe(200);
    expect((await handleFormRequest({ year: "2025", form: "f1040", stamp: "0", user: USER }, deps)).status).toBe(403);
    expect((await handleFormRequest({ year: "2025", form: "f1040", stamp: null, final: "1", user: USER }, deps)).status).toBe(403);
    expect(audits.map((a) => a.kind)).toEqual(["form"]);
  });

  it("?final=1 with an approval: one form, neutral properties (Title = form title, no Subject / Keywords / Author), audit kind final", async () => {
    const view = makeView();
    const { deps, audits } = harness({ view, approval: approvalFor(view.fingerprint) });
    const res = await handleFormRequest({ year: "2025", form: "f1040", stamp: null, final: "1", user: USER }, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="ty2025-f1040-[0-9a-f]{12}-final\.pdf"$/);
    const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect(doc.getTitle()).toBe(getManifestEntry("f1040").title);
    expect(doc.getSubject()).toBeUndefined();
    expect(doc.getKeywords()).toBeUndefined();
    expect(doc.getAuthor()).toBeUndefined();
    expect(audits.map((a) => [a.kind, a.stamp])).toEqual([["final", false]]);
    expect(Object.keys(audits[0]?.fileSha256 ?? {})).toHaveLength(1);
  });

  it("?stamp=0 with an approval keeps the DRAFT subject in the properties (a clean page footer, not a final form)", async () => {
    const view = makeView();
    const { deps } = harness({ view, approval: approvalFor(view.fingerprint) });
    const res = await handleFormRequest({ year: "2025", form: "f1040", stamp: "0", user: USER }, deps);
    expect(res.status).toBe(200);
    const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect(doc.getSubject()).toContain("DRAFT");
  });
});
