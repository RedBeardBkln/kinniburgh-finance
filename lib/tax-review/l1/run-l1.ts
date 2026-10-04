// runL1: runs every L1 check over one context and returns the findings and a counts-only summary (plan section 5.3).
// FAIL CLOSED: a check that throws is not dropped; it becomes a blocker finding ("the check failed to run"), because the review
// cannot vouch for what a check it could not run was supposed to cover. Only the error CLASS is recorded, never its text (it
// can quote values).

import { countBySeverity, dedupeFindings, makeFinding, sortFindings, type Finding, type Severity } from "@/lib/tax-review/types";
import type { L1Check, L1Context, ReadPdfFile } from "@/lib/tax-review/l1/context";
import { blankNotZeroCheck } from "@/lib/tax-review/l1/blank-not-zero";
import { doubleCountCheck } from "@/lib/tax-review/l1/double-count";
import { engineCompleteCheck, overridesInForceCheck, unresolvedChoicesCheck } from "@/lib/tax-review/l1/engine-state";
import { filingMethodCheck } from "@/lib/tax-review/l1/filing-method";
import { footingCheck, footingCoverageSummary, coverageDriftCheck, linkCheck } from "@/lib/tax-review/l1/footing";
import { requiredFormsCheck } from "@/lib/tax-review/l1/forms-required";
import { auditLabels, labelAuditCheck } from "@/lib/tax-review/l1/pdf-labels";
import { pdfAnswersCheck } from "@/lib/tax-review/l1/pdf-answers";
import { pdfMetadataCheck } from "@/lib/tax-review/l1/pdf-metadata";
import { readPacketFiles } from "@/lib/tax-review/l1/pdf-read";
import { strayInkCheck } from "@/lib/tax-review/l1/pdf-stray-ink";
import { unkeyedLinesCheck } from "@/lib/tax-review/l1/pdf-unkeyed";
import { pdfValuesCheck } from "@/lib/tax-review/l1/pdf-values";
import { priorYearCheck } from "@/lib/tax-review/l1/prior-year";
import { reasonablenessCheck } from "@/lib/tax-review/l1/reasonableness";
import { privacyGuardCheck } from "@/lib/tax-review/l1/privacy-guard";
import { sourceTieoutCheck } from "@/lib/tax-review/l1/source-tieout";
import { surfaceAgreementCheck } from "@/lib/tax-review/l1/surface-agreement";

export const L1_VERSION = 1;

/** Every L1 check, in the order of the plan (section 5.3). */
export const L1_CHECKS: readonly L1Check[] = [
  footingCheck,
  linkCheck,
  coverageDriftCheck,
  pdfValuesCheck,
  strayInkCheck,
  labelAuditCheck,
  pdfAnswersCheck,
  unkeyedLinesCheck,
  pdfMetadataCheck,
  surfaceAgreementCheck,
  sourceTieoutCheck,
  doubleCountCheck,
  engineCompleteCheck,
  unresolvedChoicesCheck,
  overridesInForceCheck,
  privacyGuardCheck,
  blankNotZeroCheck,
  priorYearCheck,
  reasonablenessCheck,
  requiredFormsCheck,
  filingMethodCheck,
];

export interface L1CheckSummary {
  id: string;
  description: string;
  status: "ok" | "failed";
  findings: number;
  /** Error class name only. */
  error?: string;
}

/** Counts and coverage only: no value, no name, no document text. */
export interface L1Summary {
  version: number;
  mode: "draft" | "final";
  checks: L1CheckSummary[];
  counts: Record<Severity, number>;
  coverage: {
    footingRules: number;
    footingRulesEvaluated: number;
    footingRulesSkipped: number;
    pdfFilesRead: number;
    pdfFieldsRead: number;
    labelFieldsCompared: number;
    formsNotLabelAudited: string[];
    documentsRead: number;
  };
}

export interface L1Result {
  findings: Finding[];
  summary: L1Summary;
  /** "completed" when every check ran (findings are separate); "failed" when any check could not run. */
  status: "completed" | "failed";
}

function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : "unknown error";
}

function failure(id: string, name: string): Finding {
  return makeFinding({
    layer: "L1",
    check: "L1.runner.check-failed",
    severity: "blocker",
    area: "process",
    ruleTag: id,
    message: `The check ${id} could not run (${name}), so the review cannot vouch for what it covers.`,
    evidence: [{ ref: `check:${id}`, amount: null, status: "failed to run" }],
    recommendedAction: "Run the review again. If it fails again the review has a defect: do not approve until it is fixed.",
    acceptable: false,
  });
}

export async function runL1(input: L1Context, checks: readonly L1Check[] = L1_CHECKS): Promise<L1Result> {
  const findings: Finding[] = [];
  const summaries: L1CheckSummary[] = [];
  let read: readonly ReadPdfFile[];
  try {
    read = input.read ?? (await readPacketFiles(input.packet.files));
  } catch (err) {
    read = [];
    findings.push(failure("pdf-read", errorClass(err)));
    summaries.push({ id: "pdf-read", description: "Read every packet PDF back from its bytes", status: "failed", findings: 1, error: errorClass(err) });
  }
  const ctx: L1Context = { ...input, read };
  for (const check of checks) {
    try {
      const got = await check.run(ctx);
      findings.push(...got);
      summaries.push({ id: check.id, description: check.description, status: "ok", findings: got.length });
    } catch (err) {
      const name = errorClass(err);
      findings.push(failure(check.id, name));
      summaries.push({ id: check.id, description: check.description, status: "failed", findings: 1, error: name });
    }
  }
  const final = sortFindings(dedupeFindings(findings));
  let fieldCount = 0;
  for (const f of read) fieldCount += f.fields.size;
  let footing = { rules: 0, evaluated: 0, skipped: 0 };
  let labels = { compared: 0, formsNotAudited: [] as string[] };
  try {
    footing = footingCoverageSummary(ctx);
    const a = auditLabels(ctx);
    labels = { compared: a.compared, formsNotAudited: a.formsNotAudited };
  } catch {
    /* coverage is informational; a failure of the check itself is reported above */
  }
  return {
    findings: final,
    status: summaries.some((s) => s.status === "failed") ? "failed" : "completed",
    summary: {
      version: L1_VERSION,
      mode: input.mode,
      checks: summaries,
      counts: countBySeverity(final),
      coverage: {
        footingRules: footing.rules,
        footingRulesEvaluated: footing.evaluated,
        footingRulesSkipped: footing.skipped,
        pdfFilesRead: read.length,
        pdfFieldsRead: fieldCount,
        labelFieldsCompared: labels.compared,
        formsNotLabelAudited: labels.formsNotAudited,
        documentsRead: input.raw?.documents.length ?? 0,
      },
    },
  };
}
