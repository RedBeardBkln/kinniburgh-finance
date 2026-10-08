// Tool: get_tax_review_status. READ-ONLY view of the Final review state of the TY2025 return: the gate (computed by code, never by a model),
// the layers' run states, finding totals, the open gating findings, and the approval state. Shaper is PURE and unit-tested.
//
// Returned: gate items and verdict, layer states, counts, the OPEN GATING findings (check id, severity, layer, area, line, message and
// recommended action, clipped), approval state with first names and a 12-character fingerprint only, `canApproveNow` (information only).
// NOT returned: finding evidence and citation blobs, acceptance reasons (the owner's written words), the full fingerprint, typed
// confirmations, run configuration, AI review cost, token counts or prompts. The assistant can never start a review, accept a finding or approve.

import { z } from "zod";
import { links } from "@/lib/advisor/links";
import { loadTaxReviewOnce } from "@/lib/advisor/queries/tax";
import { safeField } from "@/lib/advisor/scrub";
import { firstNameOf } from "@/lib/advisor/names";
import { plainIds } from "@/lib/advisor/tools/tax-format";
import { parseInput } from "@/lib/advisor/tools/parse";
import { UNSUPPORTED_YEAR_HINT } from "@/lib/advisor/tools/get-tax-return-summary";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";
import type { ReviewStateDto } from "@/lib/tax-review/state";

const schema = z.object({ year: z.number().int().min(1990).max(2100) }).strict();
type Input = z.output<typeof schema>;

const MAX_FINDINGS = 25;

export function shapeReviewStatus(state: ReviewStateDto): ToolOutput {
  const gating = state.findings.filter((f) => f.gating);
  const shownFindings = gating.slice(0, MAX_FINDINGS).map((f) => ({
    check: safeField(f.check, 80),
    severity: f.severity,
    layer: f.layer,
    area: safeField(String(f.area), 40),
    line: f.lineKey === null ? null : safeField(f.lineKey, 60),
    message: safeField(plainIds(f.message), 300),
    recommended_action: safeField(plainIds(f.recommendedAction), 200),
    acceptable_by_owner: f.acceptable,
  }));
  const bySeverity: Record<string, number> = {};
  for (const f of state.findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  return {
    data: {
      tax_year: state.year,
      verdict: state.gate.verdict === "passed" ? "AI review: PASSED (a prerequisite for the owner's approval, never a substitute for it)" : "AI review: FLAGGED",
      gate: state.gate.items.map((i) => ({ item: i.id, label: safeField(i.label, 80), state: i.state, detail: safeField(plainIds(i.detail), 160), open_gating: i.openCount })),
      latest_run:
        state.latestRun === null
          ? null
          : {
              started_by: firstNameOf(state.latestRun.startedByName),
              started_at: safeField(state.latestRun.startedAt, 40),
              is_current_for_this_return: state.latestRun.isCurrent,
              fingerprint_12: state.latestRun.fingerprint12,
              engine_version: state.latestRun.engineVersion,
              checks_status: state.latestRun.l1Status,
            },
      run_is_stale: state.runIsStale,
      ai_review: { status: state.ai.status, completed_tasks: state.ai.completedCount, total_tasks: state.ai.totalCount },
      findings: { total: state.totals.findings, open: state.totals.open, accepted_by_owner: state.totals.accepted, open_gating: state.totals.gatingOpen, by_severity: bySeverity },
      rows: shownFindings,
      ...(gating.length > shownFindings.length ? { more: `${gating.length - shownFindings.length} more gating findings; see the Final review page.` } : {}),
      approval: {
        in_force: state.approval.inForce,
        counts_for_current_return: state.approval.current,
        approved_by: state.approval.approvedByName === null ? null : firstNameOf(state.approval.approvedByName),
        approved_at: state.approval.at === null ? null : safeField(state.approval.at, 40),
        fingerprint_12: state.approval.fingerprint12,
        why_it_no_longer_counts: (state.approval.revokedReasons ?? []).slice(0, 4).map((r) => safeField(plainIds(r), 200)),
      },
      owner_can_approve_now: state.canApproveNow,
      approver_note: state.approver.reason === null ? null : safeField(plainIds(state.approver.reason), 200),
      not_run_notice: state.notRunNotice === null ? null : safeField(plainIds(state.notRunNotice), 200),
      honesty:
        "The reviewer is software, not a CPA, EA or attorney. PASSED or FLAGGED does not guarantee correctness or acceptance, and only the owner's own account can approve. This assistant cannot run, accept or approve anything.",
    },
    rows: shownFindings.length,
    total: gating.length,
    links: [links.finalReview(2025), links.taxForms(2025)],
  };
}

export const getTaxReviewStatusTool = defineTool<Input>({
  name: "get_tax_review_status",
  description:
    "Status of the AI Return Reviewer and the owner's approval for the TY2025 DRAFT return: the gate items (return fingerprint, engine, deterministic checks, independent recalculation, AI review passes, verdict), whether the latest run is stale, finding counts, the open findings that block approval (check, severity, line, message, recommended action), and whether an approval counts for the current return. Read-only: it cannot start a review, accept a finding or approve. Only year 2025.",
  inputJsonSchema: {
    type: "object",
    properties: { year: { type: "integer", description: "Tax year. Only 2025 is supported." } },
    required: ["year"],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Checking review status",
  summarizeArgs: (i) => `year=${i.year}`,
  run: async (ctx, i) => {
    if (i.year !== 2025) return { data: { supported: false, hint: UNSUPPORTED_YEAR_HINT }, links: [links.taxFacts()] };
    const loaded = await loadTaxReviewOnce(ctx);
    if (!loaded.ok) return { data: { available: false, message: "The review state could not be read right now. Nothing was changed." }, links: [links.finalReview(2025)] };
    return shapeReviewStatus(loaded.state);
  },
  maxChars: 12_000,
  phase: 1,
});
