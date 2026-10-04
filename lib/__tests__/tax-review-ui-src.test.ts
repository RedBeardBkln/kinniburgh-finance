import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// There is no jsdom / component-test infrastructure in this repo, so the Final review UI is pinned by SOURCE CHECKS (what must and must
// not be in the components and the page) plus the pure helpers' unit tests (tax-review-ui.test.ts, tax-review-state.test.ts). The
// interactive behaviour is checked by hand in Chrome (checklist in .claude/pipeline/ai-return-reviewer/02-implementation-A6.md).

const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const code = (p: string): string => read(p).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");

const DIR = "components/tax/review";
const CLIENT = ["run-controls.tsx", "findings-table.tsx", "finding-detail.tsx", "disposition-dialog.tsx", "approval-card.tsx", "run-history.tsx"].map((f) => `${DIR}/${f}`);
const SERVER = ["review-status.tsx", "honesty-panel.tsx", "by-hand-checklist.tsx"].map((f) => `${DIR}/${f}`);
const PAGE = "app/tax/forms/[year]/final-review/page.tsx";

describe("component inventory", () => {
  it("the review components are exactly the ones the page uses (nothing stray)", () => {
    expect(readdirSync(resolve(ROOT, DIR)).sort()).toEqual([...CLIENT, ...SERVER].map((p) => p.split("/").pop() as string).sort());
  });
  it("client components start with 'use client'; the page and the server components do not", () => {
    for (const f of CLIENT) expect(read(f).startsWith('"use client";'), f).toBe(true);
    for (const f of [...SERVER, PAGE]) expect(read(f), f).not.toMatch(/"use client"/);
  });
});

describe("no window.confirm, accessible dialogs, busy-state locking", () => {
  it("no window.confirm / confirm() anywhere (accept and withdraw are inline two-step forms)", () => {
    for (const f of [...CLIENT, ...SERVER, PAGE]) expect(code(f), f).not.toMatch(/window\.confirm|\bconfirm\s*\(|window\.alert|\balert\s*\(/);
    expect(read(`${DIR}/approval-card.tsx`)).toContain("Yes, withdraw it");
    expect(read(`${DIR}/approval-card.tsx`)).toContain("Keep it");
  });
  it("the accept dialog uses the repo's modal (role=dialog, Escape, focus return) and locks everything while a request is in flight", () => {
    const src = read(`${DIR}/disposition-dialog.tsx`);
    expect(src).toContain('from "@/components/tax/forms/modal-shell"');
    expect(src).toMatch(/<ModalShell [^>]*busy=\{busy\}/);
    expect(src).toContain("disabled={busy}"); // the reason field
    expect(src).toMatch(/disabled=\{!canSubmit\}/); // the submit button
    expect(src).toContain('aria-live="polite"');
    expect(src).toContain("setBusy(true)");
    expect(src).toMatch(/finally \{\s*setBusy\(false\)/);
    expect(read("components/tax/forms/modal-shell.tsx")).toContain('role="dialog"');
  });
  it("the accept dialog asks for the reason in plain words and says what accepting means", () => {
    const src = read(`${DIR}/disposition-dialog.tsx`);
    expect(src).toContain("Why is it fine to leave this as it is? (required)");
    expect(src).toContain("Accepting means you looked at this");
    expect(src).toContain("Do not type Social Security, employer ID or account numbers.");
  });
  it("Run checks and the approval button are locked while busy and announce their result", () => {
    const run = read(`${DIR}/run-controls.tsx`);
    expect(run).toMatch(/disabled=\{busy\}/);
    expect(run).toContain('aria-live="polite"');
    expect(run).toMatch(/finally \{\s*setBusy\(false\)/);
    const card = read(`${DIR}/approval-card.tsx`);
    expect(card).toMatch(/disabled=\{!form\.canApprove\}/);
    expect(card).toContain('aria-live="polite"');
    expect(card).toMatch(/finally \{\s*setBusy\(false\)/);
  });
});

describe("the findings list", () => {
  const src = read(`${DIR}/findings-table.tsx`);
  it("filters by severity, area, status and text; shows how many are shown", () => {
    for (const id of ["filter-severity-", "filter-area", "filter-status", "filter-text", "findings-count"]) expect(src).toContain(id);
    expect(src).toContain("Showing {shown.length} of {findings.length}");
    expect(src).toContain("filterFindings(findings, filters)");
  });
  it("the detail shows message, evidence, source with its quote, the recommended action and who accepted it", () => {
    const d = read(`${DIR}/finding-detail.tsx`);
    for (const t of ["The figures it rests on", "Source", "What to do", "finding-evidence", "finding-sources", "Accepted", "Reason:"]) expect(d, t).toContain(t);
    expect(d).toContain("Unverified: confirm this yourself before relying on it.");
  });
  it("a finding that must be fixed offers no Accept button and says why; Reopen exists for an accepted one", () => {
    const d = read(`${DIR}/finding-detail.tsx`);
    expect(d).toContain("This one cannot be accepted: it is something the return must get right.");
    expect(d).toMatch(/!finding\.acceptable \?/);
    expect(d).toContain("finding-reopen-button");
  });
  it("a past run is read-only", () => {
    expect(src).toContain("readOnly");
    expect(read(`${DIR}/run-history.tsx`)).toContain("readOnly");
  });
});

describe("the approval card", () => {
  const src = read(`${DIR}/approval-card.tsx`);
  it("shows the attestation text VERBATIM from a prop (the page passes the server's constant), a box, the phrase and the full name", () => {
    expect(src).toContain("{attestationText}");
    for (const id of ["attestation-text", "attestation-check", "attestation-phrase", "attestation-name", "approve-button"]) expect(src).toContain(id);
    expect(src).toContain("approveReturn({ taxYear: year, checked, attestationText, typedPhrase: phrase, typedName: name })");
  });
  it("shows the short fingerprint and whether an approval exists, is current or is stale", () => {
    expect(src).toContain("approval-fingerprint-line");
    expect(src).toContain("approved for this state");
    expect(src).toContain(": stale");
    expect(src).toContain("approval-stale");
  });
  it("offers the final package and the withdrawal only after an approval; the final package link is the route's ?final=1", () => {
    expect(src).toContain("`${base}?final=1`");
    expect(src).toContain("download-final-package");
    expect(src).toMatch(/approval\.current \?/);
    expect(src).toContain("withdrawApproval({ taxYear: year, reason: withdrawReason.trim() })");
  });
  it("has no waiver, no override and no 'approve anyway' path", () => {
    for (const f of [`${DIR}/approval-card.tsx`, `${DIR}/review-status.tsx`, PAGE]) expect(code(f), f).not.toMatch(/waiv|approve anyway|override the gate|skip the (check|review)|ignore the (gate|review)/i);
    // the only thing that enables the button is the helper that requires a green gate
    expect(src).toContain("gateGreen");
    expect(src).toContain("checkApprovalForm(");
  });
  it("sends no fingerprint and no gate state to the server", () => {
    expect(src).not.toMatch(/fingerprint\s*[:=][^=]/);
    for (const f of CLIENT) expect(code(f), f).not.toMatch(/\b(runFingerprint|currentFingerprint|verdict)\s*:/);
  });
});

describe("the page", () => {
  const src = read(PAGE);
  it("checks auth first, before anything is loaded, and only then reads the state on the server", () => {
    expect(src.indexOf("await auth()")).toBeGreaterThan(-1);
    expect(src.indexOf("await auth()")).toBeLessThan(src.indexOf("loadReviewState("));
    expect(src).toContain('redirect("/login")');
    expect(src).toContain("export const maxDuration = 60");
  });
  it("only 2025 is reviewed", () => {
    expect(src).toContain("year === 2025");
    expect(src).toContain("The review is available for tax year 2025 only.");
  });
  it("puts the 'what this review can and cannot do' panel DIRECTLY above the approval card", () => {
    const honesty = src.indexOf("<HonestyPanel />");
    const card = src.indexOf("<ApprovalCard");
    expect(honesty).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(honesty);
    // nothing but whitespace and a comment between the two elements
    const between = src.slice(honesty + "<HonestyPanel />".length, card);
    expect(between.replace(/\s+/g, "")).toBe("");
  });
  it("shows the gate, the findings, the history and the by-hand checklist, and says plainly that L2 / L3 have not run", () => {
    for (const c of ["<ReviewStatusBanner", "<GateChecklist", "<RunControls", "<FindingsTable", "<RunHistory", "<ByHandChecklist"]) expect(src, c).toContain(c);
    expect(read(`${DIR}/review-status.tsx`)).toContain("state.notRunNotice");
    expect(read(`${DIR}/approval-card.tsx`)).toContain("notRunNotice");
  });
  it("passes only plain JSON to the components (the state DTO), never facts, raw documents or the full fingerprint", () => {
    expect(code(PAGE)).not.toMatch(/facts|\.raw\b|extractionData|fingerprint\.fingerprint/);
  });
  it("is reachable from the Forms page, the PDF download section and the return review sheet", () => {
    expect(read("app/tax/forms/[year]/page.tsx")).toContain("/final-review");
    expect(read("components/tax/forms/pdf-download-buttons.tsx")).toContain("/final-review");
    expect(read("app/tax/forms/[year]/return/page.tsx")).toContain("/final-review");
    // the clean-copy link stays off the Forms page: it lives on the approval card only
    expect(read("components/tax/forms/pdf-download-buttons.tsx")).not.toContain("stamp=0");
  });
});

describe("browser bundle safety", () => {
  const IMPORT = /^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;
  it("no client component imports the gate, the finding model, the store or anything with node: modules at runtime", () => {
    for (const f of CLIENT) {
      for (const m of read(f).matchAll(IMPORT)) {
        const spec = m[1] ?? "";
        expect(spec, `${f} imports ${spec}`).not.toMatch(/^node:|tax-review\/(gate|types|state|fingerprint|redact|l1)|tax-review-(store|server|build)|^@\/lib\/db$/);
      }
    }
  });
  it("lib/tax-review/ui.ts and limits.ts import only each other, the redaction helper and types", () => {
    const imports = (f: string): string[] => [...read(f).matchAll(IMPORT)].map((m) => m[1] ?? "");
    expect(imports("lib/tax-review/limits.ts")).toEqual([]);
    expect(imports("lib/tax-review/ui.ts").sort()).toEqual(["@/lib/tax-review/limits", "@/lib/tax-review/redact"]);
    expect(imports("lib/tax-extraction-schema.ts")).toEqual([]);
  });
});
