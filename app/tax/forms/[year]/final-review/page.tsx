import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { ApprovalCard } from "@/components/tax/review/approval-card";
import { ByHandChecklist } from "@/components/tax/review/by-hand-checklist";
import { FindingsTable } from "@/components/tax/review/findings-table";
import { HonestyPanel } from "@/components/tax/review/honesty-panel";
import { ReviewStatusBanner, GateChecklist } from "@/components/tax/review/review-status";
import { RunControls } from "@/components/tax/review/run-controls";
import { RunHistory } from "@/components/tax/review/run-history";
import { loadReviewState } from "@/lib/tax-review-server";
import { ATTESTATION_V1_TEXT, TYPED_PHRASE } from "@/lib/tax-review/gate";

// "Run the checks" is a server action hosted by this page: it builds the packet and the final package and reads them back, which can
// take a while, so the page raises the time limit (the PDF routes and the review-queue page use the same 60 seconds).
export const maxDuration = 60;

interface PageProps {
  params: Promise<{ year: string }>;
}

// FINAL REVIEW (TY2025): the deterministic checks, the findings, the gate and the owner's approval. Auth is checked HERE before anything
// is loaded (lib/tax-review-server.ts has no auth of its own). Only plain JSON built on the server reaches the components: findings,
// counts and the short fingerprint, never the facts, the raw documents or the full fingerprint. READ-ONLY while it renders: it
// writes nothing; every write is a server action the owner triggers (each starts with requireAuth()).
export default async function FinalReviewPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { year: yearStr } = await params;
  const year = Number(yearStr);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) notFound();

  const loaded = year === 2025 ? await loadReviewState(2025, session.user.id) : null;

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6" data-testid="final-review-page">
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Link href="/tax" className="hover:underline">
              Tax Workspaces
            </Link>
            <span>/</span>
            <Link href={`/tax/forms/${year}` as Route} className="hover:underline">
              Forms {year}
            </Link>
            <span>/</span>
            <span>Final review</span>
          </div>
          <h1 className="text-2xl font-semibold">Final review - {year}</h1>
          <p className="text-sm text-muted-foreground">
            Run the checks, look at what they found, accept what you have decided is fine, and approve the return yourself. Until you approve, every form carries a DRAFT footer; the clean copies and the final package are
            released only for the exact state of the return you approved.
          </p>
        </div>

        {loaded === null ? (
          <div className="space-y-2 rounded-lg border p-4">
            <p className="text-sm">The review is available for tax year 2025 only.</p>
            <Link href={"/tax/forms/2025/final-review" as Route} className="text-sm text-primary hover:underline">
              Open the 2025 Final review
            </Link>
          </div>
        ) : !loaded.ok ? (
          <div className="space-y-2 rounded-lg border border-red-300 bg-red-50 p-4" role="alert" data-testid="final-review-error">
            <p className="text-sm font-semibold">The Final review could not be loaded.</p>
            <p className="text-sm">{loaded.error}</p>
          </div>
        ) : (
          (() => {
            const state = loaded.state;
            const canDecide = state.approver.allowed && state.latestRun !== null && !state.runIsStale;
            const whyNotDecide = !state.approver.allowed
              ? state.approver.reason
              : state.latestRun === null
                ? "Run the checks first."
                : state.runIsStale
                  ? "The return changed after those checks. Run them again to decide."
                  : null;
            return (
              <>
                <ReviewStatusBanner state={state} />
                <GateChecklist state={state} />
                <RunControls year={2025} hasRun={state.latestRun !== null} runIsStale={state.runIsStale} />

                <section aria-labelledby="findings-heading" className="space-y-3 rounded-lg border p-4" data-testid="review-findings">
                  <div>
                    <h2 id="findings-heading" className="text-base font-semibold">
                      What the checks found
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {state.totals.findings} finding{state.totals.findings === 1 ? "" : "s"} in the latest checks: {state.totals.open} open ({state.totals.gatingOpen} blocking approval), {state.totals.accepted} accepted.
                      Findings that must be fixed cannot be accepted; the others can be, with a written reason.
                    </p>
                  </div>
                  <FindingsTable findings={state.findings} year={2025} canDecide={canDecide} whyNotDecide={whyNotDecide} />
                </section>

                {/* The honesty panel sits DIRECTLY above the approval card, so it is on screen when the owner approves. */}
                <div className="space-y-4">
                  <HonestyPanel />
                  <ApprovalCard
                    year={2025}
                    attestationText={ATTESTATION_V1_TEXT}
                    requiredPhrase={TYPED_PHRASE}
                    gateGreen={state.gate.verdict === "passed"}
                    accountAllowed={state.approver.allowed}
                    accountReason={state.approver.reason}
                    currentFingerprint12={state.currentFingerprint12}
                    approval={state.approval}
                    notRunNotice={state.notRunNotice}
                  />
                </div>

                <RunHistory runs={state.runs} year={2025} />
                <ByHandChecklist />
              </>
            );
          })()
        )}
      </div>
    </AppShell>
  );
}
