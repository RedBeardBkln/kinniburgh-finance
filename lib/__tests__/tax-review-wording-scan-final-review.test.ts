import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ATTESTATION_V1_TEXT, evaluateGate, type GateInput } from "@/lib/tax-review/gate";
import { HONESTY_ALL, HONESTY_CANNOT, HONESTY_INTRO } from "@/lib/tax-review/honesty";
import { buildReviewState, NOT_RUN_NOTICE } from "@/lib/tax-review/state";
import { checkApprovalForm, checkReason, gateStateLabel, SEVERITY_LABELS, verdictChip } from "@/lib/tax-review/ui";
import { BY_HAND } from "@/lib/tax2025/pdf/final-package";
import { findFinalPackageBannedWording, findOwnerBannedWording } from "@/lib/tax-wording";

// ai-return-reviewer, plan 7.5: nothing the owner can SEE may say that a CPA reviews, prepares or signs the return. The Final review
// page is a new surface; this file adds it to the wording scan (the static scan of components/tax and app/tax in
// tax-review-wording-scan.test.ts already covers the upper-case word in every source line). The profession may be NAMED only in the
// honesty statements ("not a CPA", "enrolled agent, CPA or tax attorney"), which the wording layer's allow-list permits.

const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");

const DIR = "components/tax/review";
const FILES = [...readdirSync(resolve(ROOT, DIR)).map((f) => `${DIR}/${f}`), "app/tax/forms/[year]/final-review/page.tsx"];

function gateStrings(): string[] {
  const base: GateInput = {
    runFingerprint: "a".repeat(64),
    currentFingerprint: "a".repeat(64),
    engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 },
    findings: [],
    dispositions: [],
    l1: { status: "completed" },
    l2: { status: "not_run", coverageListed: false },
    l3: { status: "not_run", adversarialCompleted: false },
  };
  const variants: GateInput[] = [
    base,
    { ...base, runFingerprint: null },
    { ...base, runFingerprint: "b".repeat(64) },
    { ...base, engine: { complete: false, blockingItemCount: 3, lineOverrideCount: 2, staleOverrideCount: 1 } },
    { ...base, l1: { status: "failed" }, l2: { status: "partial", coverageListed: false }, l3: { status: "failed", adversarialCompleted: false } },
    { ...base, l2: { status: "completed", coverageListed: true }, l3: { status: "completed", adversarialCompleted: true } },
  ];
  return variants.flatMap((v) => evaluateGate(v).items.flatMap((i) => [i.label, i.detail]));
}

describe("Final review wording", () => {
  it("every sentence of the 'what this review can and cannot do' panel passes the owner-wording scan (the profession is named only to say the reviewer is not one)", () => {
    for (const s of HONESTY_ALL) expect(findOwnerBannedWording(s), s).toEqual([]);
    expect(HONESTY_INTRO).toMatch(/not a CPA, an enrolled agent or a licensed tax professional/);
    expect(HONESTY_INTRO).toMatch(/cannot guarantee/);
    expect(HONESTY_CANNOT.join(" ")).toMatch(/not an independent control/);
  });

  it("the not-run notice, the attestation, the gate lines, the verdict chips, severity names, reasons and button blockers are clean", () => {
    const strings = [
      NOT_RUN_NOTICE,
      ATTESTATION_V1_TEXT,
      ...gateStrings(),
      ...Object.values(SEVERITY_LABELS),
      gateStateLabel("pass"),
      gateStateLabel("fail"),
      gateStateLabel("not_run"),
      ...checkApprovalForm({ checked: false, typedPhrase: "", typedName: "", busy: true, gateGreen: false, accountAllowed: false, alreadyApproved: true }).blockers,
      checkReason("no").ok ? "" : (checkReason("no") as { error: string }).error,
      checkReason("123-45-6789 is a number").ok ? "" : (checkReason("123-45-6789 is a number") as { error: string }).error,
    ];
    const run = { id: "r", fingerprint: "a".repeat(64), engineVersion: "e", startedAt: "2026-10-05T10:00:00.000Z", startedByName: "x", l1Summary: { status: "completed" }, l2Summary: null };
    const base = { currentFingerprint: "a".repeat(64), engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 }, runs: [run], dispositions: [], approvals: [], approver: { allowed: true, ownerName: "x", reason: null } };
    strings.push(verdictChip(buildReviewState({ ...base, runs: [], latest: null })).label, verdictChip(buildReviewState({ ...base, latest: { run, findings: [] } })).label);
    for (const s of strings) {
      expect(findOwnerBannedWording(s), s).toEqual([]);
      expect(s, s).not.toMatch(/\bCPA\b|certified|professionally reviewed/i);
    }
    expect(NOT_RUN_NOTICE).toBe("Independent recalculation and AI review passes not run yet: required before approval.");
  });

  it("the page and every component are free of CPA / certification / licensed claims, and never claim the AI approved or guarantees anything", () => {
    for (const f of FILES) {
      const src = stripComments(read(f));
      expect(findOwnerBannedWording(src), f).toEqual([]);
      expect(src, f).not.toMatch(/(?<![A-Za-z0-9_-])CPA(?![A-Za-z0-9_-])/);
      expect(src, f).not.toMatch(/approved by (the )?AI|AI[- ]approved|certified|audit-proof|guarantee/i);
    }
  });

  it("the by-hand checklist the page shows is the package index's list, and it passes both banned-wording lists", () => {
    expect(read(`${DIR}/by-hand-checklist.tsx`)).toContain("BY_HAND");
    for (const t of BY_HAND) {
      expect(findOwnerBannedWording(t), t).toEqual([]);
      expect(findFinalPackageBannedWording(t), t).toEqual([]);
    }
  });

  it("the final-package banned list does not apply to the page, but the attestation never reaches the package index", () => {
    // the attestation contains 'review' (banned in the package): it must stay on the page
    expect(findFinalPackageBannedWording(ATTESTATION_V1_TEXT).length).toBeGreaterThan(0);
    const finalPackage = read("lib/tax2025/pdf/final-package.ts");
    expect(finalPackage).not.toContain("ATTESTATION");
    expect(finalPackage).not.toContain("tax-review/gate");
  });
});
