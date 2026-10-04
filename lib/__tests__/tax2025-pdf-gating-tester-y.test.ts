// TESTER (ai-return-reviewer unit Y): try to trick the clean-copy gate through the REAL route files (auth mocked,
// approval mocked to "nothing approved" unless a test says otherwise). Whatever the query string looks like, a request
// that is not exactly `stamp=0` / `final=1` must end as a STAMPED draft (never a clean copy), and an exact one must be
// refused with 403 until the approval for the CURRENT fingerprint exists.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 90000 });
import { beforeEach, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";

const authMock = vi.hoisted(() => vi.fn());
const buildViewMock = vi.hoisted(() => vi.fn());
const recordExportMock = vi.hoisted(() => vi.fn());
const approvalMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/tax2025-pdf-build", () => ({
  defaultPdfRouteDeps: { buildView: buildViewMock, recordExport: recordExportMock, approval: { currentApproval: approvalMock } },
}));

import { GET as getPacket } from "@/app/api/tax/forms/[year]/pdf/route";
import { GET as getForm } from "@/app/api/tax/forms/[year]/pdf/[form]/route";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { PacketExportAudit } from "@/lib/tax2025-pdf-route";
import { fullFacts } from "./tax2025-fixtures";

function makeView() {
  const facts = fullFacts();
  return toPdfReturnView(computeTy2025Return(facts), facts, { generatedAt: "2026-10-03T16:00:00.000Z", generatedBy: "Test User" });
}
const SESSION = { user: { id: "user-1", name: "Test User" } };
const formCtx = (year: string, form: string) => ({ params: Promise.resolve({ year, form }) });
const packetCtx = (year: string) => ({ params: Promise.resolve({ year }) });
const req = (path: string) => new Request(`http://localhost${path}`);
const audits = (): PacketExportAudit[] => recordExportMock.mock.calls.map((c) => c[0] as PacketExportAudit);

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

/** Query strings that are NOT exactly the clean/final switch: every one must come back as a stamped draft. */
const NOT_A_SWITCH = [
  "?stamp=00",
  "?STAMP=0",
  "?Stamp=0",
  "?stamp=0%20",
  "?stamp=%200",
  "?stamp=+0",
  "?stamp=false",
  "?stamp=",
  "?stamp",
  "?stamp=1&stamp=0",
  "?stamp[]=0",
  "?stamp=0.0",
  "?stamp=-0",
  "?xstamp=0",
  "?final=true",
  "?final=yes",
  "?final=11",
  "?final=0&final=1",
  "?FINAL=1",
  "?final%5B%5D=1",
  "?final=1%20",
  "?final=",
  "",
];

/** Query strings that DO switch to a clean copy / the final package (percent-encoding and repetition included). */
const IS_A_SWITCH = [
  "?stamp=0",
  "?stamp=%30",
  "?stamp=0&stamp=1",
  "?stamp=0&other=1",
  "?final=1",
  "?final=%31",
  "?final=1&final=0",
  "?final=1&stamp=1",
  "?stamp=1&final=1",
  "?stamp=0&final=1",
];

describe("single-form route: only an exact switch is a clean copy, and then only with an approval", () => {
  for (const q of NOT_A_SWITCH) {
    it(`${JSON.stringify(q)} -> stamped draft (200, stamp=true, DRAFT subject, no approval consulted)`, async () => {
      const res = await getForm(req(`/api/tax/forms/2025/pdf/f1040s3${q}`), formCtx("2025", "f1040s3"));
      expect(res.status).toBe(200);
      const disp = res.headers.get("Content-Disposition") ?? "";
      expect(disp).not.toMatch(/clean|final/);
      const [a] = audits();
      expect(a?.stamp).toBe(true);
      expect(a?.kind).toBe("form");
      expect(approvalMock).not.toHaveBeenCalled();
      const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()), { updateMetadata: false });
      expect(doc.getSubject()).toMatch(/^DRAFT/);
    });
  }

  for (const q of IS_A_SWITCH) {
    it(`${JSON.stringify(q)} -> 403 without an approval, nothing recorded`, async () => {
      const res = await getForm(req(`/api/tax/forms/2025/pdf/f1040s3${q}`), formCtx("2025", "f1040s3"));
      expect(res.status).toBe(403);
      expect(res.headers.get("Content-Type")).toMatch(/json/);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(recordExportMock).not.toHaveBeenCalled();
      expect(approvalMock).toHaveBeenCalledTimes(1);
    });
  }

  it("a rejected lookup (throws) is a refusal, never a clean copy", async () => {
    approvalMock.mockRejectedValue(new Error("db down"));
    const res = await getForm(req("/api/tax/forms/2025/pdf/f1040s3?stamp=0"), formCtx("2025", "f1040s3"));
    expect(res.status).toBe(403);
    expect(recordExportMock).not.toHaveBeenCalled();
  });

  it("a lookup returning a truthy non-boolean string/object is not special: only `true` from the store counts, and the lookup is asked for the CURRENT fingerprint", async () => {
    const view = makeView();
    approvalMock.mockImplementation(async (fp: string) => fp === view.fingerprint);
    const ok = await getForm(req("/api/tax/forms/2025/pdf/f1040s3?final=1"), formCtx("2025", "f1040s3"));
    expect(ok.status).toBe(200);
    expect(approvalMock).toHaveBeenCalledWith(view.fingerprint);
    // The return changes after the approval (different fingerprint): the same approval no longer unlocks anything.
    const other = { ...view, fingerprint: "f".repeat(64) };
    buildViewMock.mockImplementation(async () => ({ view: other }));
    const refused = await getForm(req("/api/tax/forms/2025/pdf/f1040s3?final=1"), formCtx("2025", "f1040s3"));
    expect(refused.status).toBe(403);
  });

  it("401 comes first for every variant, before the builder or the approval store is touched", async () => {
    authMock.mockResolvedValue(null);
    for (const q of [...IS_A_SWITCH, ...NOT_A_SWITCH]) {
      const res = await getForm(req(`/api/tax/forms/2025/pdf/f1040s3${q}`), formCtx("2025", "f1040s3"));
      expect(res.status).toBe(401);
    }
    authMock.mockResolvedValue({ user: {} });
    expect((await getForm(req("/api/tax/forms/2025/pdf/f1040s3?final=1"), formCtx("2025", "f1040s3"))).status).toBe(401);
    expect(buildViewMock).not.toHaveBeenCalled();
    expect(approvalMock).not.toHaveBeenCalled();
    expect(recordExportMock).not.toHaveBeenCalled();
  });

  it("form id path tricks are 404, whatever the switch", async () => {
    for (const form of ["F1040S3", "f1040s3.pdf", "../f1040", "f1040s3%00", "f1040s3/", "", " f1040s3", "f1040s3 ", "ct1040\n", "__proto__", "constructor"]) {
      const res = await getForm(req(`/api/tax/forms/2025/pdf/${form}?stamp=0`), formCtx("2025", form));
      expect(res.status, JSON.stringify(form)).toBe(404);
    }
    expect(buildViewMock).not.toHaveBeenCalled();
  });

  it("year tricks never reach the builder", async () => {
    for (const y of ["2024", "2026", "02025", "2025.0", "2025 ", "abcd", "", "20250"]) {
      const res = await getForm(req(`/api/tax/forms/${y}/pdf/f1040s3?final=1`), formCtx(y, "f1040s3"));
      expect([400, 404], JSON.stringify(y)).toContain(res.status);
    }
    expect(buildViewMock).not.toHaveBeenCalled();
  });
});

describe("packet route: same switch rules (one real packet per class, the rest are 403 before any build)", () => {
  for (const q of IS_A_SWITCH) {
    it(`${JSON.stringify(q)} -> 403 without an approval`, async () => {
      const res = await getPacket(req(`/api/tax/forms/2025/pdf${q}`), packetCtx("2025"));
      expect(res.status).toBe(403);
      expect(recordExportMock).not.toHaveBeenCalled();
    });
  }

  it("a near-miss ('?stamp=00') is the stamped draft packet: zip named draft-packet (no clean/final), stamp=true audit", async () => {
    const res = await getPacket(req("/api/tax/forms/2025/pdf?stamp=00"), packetCtx("2025"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/draft-packet-[0-9a-f]{12}\.zip/);
    expect(res.headers.get("Content-Disposition")).not.toMatch(/clean|final/);
    const [a] = audits();
    expect(a?.stamp).toBe(true);
    expect(a?.kind).toBe("packet");
    expect(a?.fileSha256).toBeUndefined();
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files)[0]).toBe("00-cover.pdf");
    expect(Object.keys(files).some((n) => n.startsWith("00-package-index"))).toBe(false);
  });
});

describe("approved return: final package audit rows carry ids, counts and hashes only", () => {
  it("?final=1 with the current approval: audit has no payer / name / amount text", async () => {
    const view = makeView();
    approvalMock.mockImplementation(async (fp: string) => fp === view.fingerprint);
    const res = await getPacket(req("/api/tax/forms/2025/pdf?final=1"), packetCtx("2025"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/ty2025-final-[0-9a-f]{12}\.zip/);
    const [a] = audits();
    expect(a?.kind).toBe("final");
    const json = JSON.stringify(a);
    for (const needle of ["Kinniburgh", "Ramirez", "Robinhood", "Test User", "Consulting", "reason", "Memberships"]) expect(json).not.toContain(needle);
    expect(Object.values(a?.fileSha256 ?? {}).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    // The zip is the final package: index first, forms/ and attachments/ only.
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const names = Object.keys(files);
    expect(names[0]).toBe("00-package-index.pdf");
    expect(names.every((n) => n === "00-package-index.pdf" || n.startsWith("forms/") || n.startsWith("attachments/"))).toBe(true);
    expect(names).not.toContain("00-cover.pdf");
  });
});

describe("fail-closed paths on an approved fingerprint", () => {
  it("packet ?final=1 with a BLOCKED return is 409 even with an approval; nothing recorded", async () => {
    const facts = (await import("./tax2025-fixtures")).emptyFacts();
    const blocked = toPdfReturnView(computeTy2025Return(facts), facts, { generatedAt: "2026-10-03T16:00:00.000Z", generatedBy: "Test User" });
    expect(blocked.openItems.some((i) => i.severity === "blocking")).toBe(true);
    buildViewMock.mockImplementation(async () => ({ view: blocked }));
    approvalMock.mockResolvedValue(true);
    const res = await getPacket(req("/api/tax/forms/2025/pdf?final=1"), packetCtx("2025"));
    expect(res.status).toBe(409);
    expect(recordExportMock).not.toHaveBeenCalled();
  });

  it("packet ?final=1 when the audit row cannot be written: no file is returned (500)", async () => {
    approvalMock.mockResolvedValue(true);
    recordExportMock.mockRejectedValue(new Error("audit down"));
    const res = await getPacket(req("/api/tax/forms/2025/pdf?final=1"), packetCtx("2025"));
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toMatch(/json/);
  });

  it("single-form ?final=1 on a blocked return with an approval is 409 like the packet route (tester Y D2, fixed), and records nothing", async () => {
    const facts = (await import("./tax2025-fixtures")).emptyFacts();
    const blocked = toPdfReturnView(computeTy2025Return(facts), facts, { generatedAt: "2026-10-03T16:00:00.000Z", generatedBy: "Test User" });
    buildViewMock.mockImplementation(async () => ({ view: blocked }));
    approvalMock.mockResolvedValue(true);
    const res = await getForm(req("/api/tax/forms/2025/pdf/f1040s3?final=1"), formCtx("2025", "f1040s3"));
    expect(res.status).toBe(409);
    expect(recordExportMock).not.toHaveBeenCalled();
  });
});
