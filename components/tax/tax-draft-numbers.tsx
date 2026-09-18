import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { documentTypeLabel } from "@/lib/doc-naming";
import { DRAFT_LABEL, type BalanceLabel, type SerializedTaxDraft } from "@/lib/tax-compute-display";

// ── TaxDraftNumbers ───────────────────────────────────────────────────────────
// Presentational only — no "use client" (no hooks/interactivity of its own).
// Rendered from the already-"use client" components/tax/personal-tax-client.tsx
// (bundled into client JS regardless, since the parent is already fully
// client-rendered — see plan Risks item 7).
//
// Ground rule 8 (CLAUDE.md): every dollar figure here is a draft, pre-credit
// estimate for CPA review, never a filed number nor financial/tax advice —
// enforced visually via the persistent DRAFT_LABEL badge (never a
// hover-only tooltip) plus per-section "before credits"/"upper bound" framing
// in row labels, not solely in the footer disclaimer below.

export interface MistaggedDocRef {
  id: string;
  docType: string;
  taxYear: number | null;
  createdAt: string;
}

interface Props {
  taxYear: number;
  taxDraft: SerializedTaxDraft | null;
  taxComputeError: string | null;
  scheduleCDataMissing: boolean;
  buildGaps: string[];
  mistaggedDocs: MistaggedDocRef[];
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

export function TaxDraftNumbers({
  taxYear,
  taxDraft,
  taxComputeError,
  scheduleCDataMissing,
  buildGaps,
  mistaggedDocs,
}: Props) {
  const otherCaveats = [...buildGaps, ...(taxDraft?.gaps ?? [])];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">Draft tax numbers</CardTitle>
          <Badge variant="warning" className="shrink-0 rounded-md text-[10px] uppercase tracking-wide">
            {DRAFT_LABEL}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Computed from your real uploaded documents, paystubs, and answers. Read the caveats below
          before treating any figure here as final — nothing on this card has been reviewed by a CPA.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Prominent, specific alerts — above the numbers themselves. */}
        {mistaggedDocs.map((doc) => (
          <div
            key={doc.id}
            className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          >
            <p className="font-medium">A document may be mistagged.</p>
            <p className="mt-0.5 leading-relaxed">
              &quot;{documentTypeLabel(doc.docType)}&quot; document uploaded {fmtDate(doc.createdAt)} didn&apos;t
              extract cleanly under that document type — the file&apos;s real content likely doesn&apos;t match
              (a known live example: a real 2025 mortgage-interest statement uploaded as a W-2). Use{" "}
              <strong>View</strong> on the document below to confirm what it actually is, then{" "}
              <strong>Rename / retype</strong> it to the correct type and save — re-extraction now runs
              automatically whenever the type changes. If the file itself is wrong (not just mislabeled),
              use <strong>Swap file</strong> instead.
            </p>
            <a href={`#doc-${doc.id}`} className="mt-1 inline-block text-xs font-medium underline">
              Jump to this document ↓
            </a>
          </div>
        ))}

        {scheduleCDataMissing && (
          <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            <p className="font-medium">Schedule C can&apos;t be computed yet.</p>
            <p className="mt-0.5 leading-relaxed">
              EK Consulting LLC has zero bank transactions on record for any period. Every figure below
              that includes Schedule C (net profit, total income, AGI, taxable income, federal tax, CT
              tax) is computed as if the business had $0 income and $0 expenses — which does not reflect
              real {taxYear} business activity. These numbers won&apos;t be trustworthy until EK
              Consulting&apos;s bank activity is connected and GL-coded.
            </p>
            <a href="/accounts?bucket=ek-consulting" className="mt-1 inline-block text-xs font-medium underline">
              Connect EK Consulting&apos;s accounts →
            </a>
          </div>
        )}

        {taxComputeError && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Draft numbers could not be computed: {taxComputeError}
          </p>
        )}

        {!taxComputeError && taxDraft === null && (
          <p className="text-sm text-muted-foreground">
            Computed draft numbers are only available for tax year 2025 today.
          </p>
        )}

        {taxDraft && (
          <div
            className={
              scheduleCDataMissing
                ? "space-y-4 rounded-lg border-2 border-red-400 p-4 dark:border-red-700"
                : "space-y-4"
            }
          >
            {scheduleCDataMissing && (
              <p className="text-xs font-semibold text-red-700 dark:text-red-300">
                These numbers are NOT reliable — EK Consulting has no bank data (see above).
              </p>
            )}

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Schedule C — EK Consulting
              </p>
              <NumberRow label="Mileage deduction" value={taxDraft.scheduleC.mileageDeduction} />
              <NumberRow
                label="Home office deduction (simplified method)"
                value={taxDraft.scheduleC.homeOfficeDeduction}
              />
              <NumberRow label="Net profit" value={taxDraft.scheduleC.netProfit} />
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Federal (Form 1040, MFJ) — before credits
              </p>
              <NumberRow label="Total income" value={taxDraft.federal.totalIncome} />
              <NumberRow
                label="AGI (upper bound — doesn't yet subtract retirement/HSA contributions)"
                value={taxDraft.federal.agiUpperBound}
              />
              <NumberRow
                label={`Deduction used (${taxDraft.federal.deductionMethod})`}
                value={taxDraft.federal.deductionUsed}
              />
              <NumberRow label="Taxable income" value={taxDraft.federal.taxableIncome} />
              <NumberRow label="Self-employment tax" value={taxDraft.federal.selfEmploymentTax} />
              <NumberRow label="Additional Medicare tax" value={taxDraft.federal.additionalMedicareTax} />
              <NumberRow label="QBI deduction" value={taxDraft.federal.qbiDeduction} />
              <NumberRow label="Federal tax before credits" value={taxDraft.federal.totalTaxBeforeCredits} />
              <NumberRow
                label="Total payments (withholding + estimated)"
                value={taxDraft.federal.totalPayments}
              />
              <BalanceRow
                label="Federal balance due / refund before credits"
                balance={taxDraft.federal.balance}
              />
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Connecticut (CT-1040) — before credits
              </p>
              <NumberRow label="CT AGI" value={taxDraft.connecticut.ctAGI} />
              <NumberRow label="CT taxable income" value={taxDraft.connecticut.ctTaxableIncome} />
              <NumberRow label="CT tax before credits" value={taxDraft.connecticut.ctTaxComputed ?? "Not computable"} />
              <NumberRow label="CT withholding" value={taxDraft.connecticut.ctWithholding} />
              <BalanceRow label="CT balance due / refund before credits" balance={taxDraft.connecticut.balance} />
            </div>
          </div>
        )}

        {otherCaveats.length > 0 && (
          <div className="border-t pt-3">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Other caveats behind this draft
            </p>
            <ul className="list-inside list-disc space-y-1">
              {otherCaveats.map((g, i) => (
                <li key={i} className="text-xs text-muted-foreground">
                  {g}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="border-t pt-3 text-xs text-muted-foreground">
          These are draft, pre-credit numbers for your CPA to review — not a filed return, not tax advice.
        </p>
      </CardContent>
    </Card>
  );
}

function NumberRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function BalanceRow({
  label,
  balance,
}: {
  label: string;
  balance: { label: BalanceLabel; amountFormatted: string | null };
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">
        {balance.amountFormatted ? `${balance.label}: ${balance.amountFormatted}` : balance.label}
      </span>
    </div>
  );
}
