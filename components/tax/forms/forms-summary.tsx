import Link from "next/link";
import type { Route } from "next";
import type { FormsPageData } from "@/lib/tax-forms";

// Header strip for the Forms page: counts, draft status, document-attribution
// nag, and the visible (non-interactive) note that PDF fill/export is the next
// phase. There is deliberately NO export/fill control here.

function Stat({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <div className={`rounded-lg border px-4 py-3 ${className}`}>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs">{label}</p>
    </div>
  );
}

export function FormsSummary({ data }: { data: FormsPageData }) {
  const { summary, attribution, draft, taxYear } = data;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Required" value={summary.required} className="border-blue-200 bg-blue-50 text-blue-900" />
        <Stat label="Conditional" value={summary.conditional} className="border-amber-200 bg-amber-50 text-amber-900" />
        <Stat
          label="Needs CPA input"
          value={summary.needsCpaInput}
          className="border-violet-200 bg-violet-50 text-violet-900"
        />
        <Stat label="Not applicable" value={summary.notApplicable} className="bg-muted text-muted-foreground" />
      </div>

      {!data.personalWorkspaceExists && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          No Personal tax workspace exists for {taxYear} yet, so your planning-question answers are not available and
          answer-dependent forms (such as Form 5695) show as conditional.{" "}
          <Link href={`/tax/personal/${taxYear}` as Route} className="font-medium underline">
            Open the {taxYear} personal workspace
          </Link>{" "}
          (opening it creates it).
        </div>
      )}

      {draft.status === "unavailable" && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          The 2025 draft numbers are unavailable ({draft.reason}), so Schedule A and Schedule SE are shown as
          undetermined.
        </div>
      )}
      {draft.status === "not_computed" && (
        <p className="text-xs text-muted-foreground">
          Draft tax numbers exist only for tax year 2025, so for {taxYear} Schedule A is conditional and Schedule SE needs
          CPA input.
        </p>
      )}
      {draft.status === "available" && (
        <p className="text-xs text-muted-foreground">
          Schedule A and Schedule SE use the 2025 draft computation (a draft for your CPA, not a filed number).
        </p>
      )}

      {attribution.taxDocCount > 0 && (attribution.unassignedPersonCount > 0 || attribution.missingIssuerCount > 0) && (
        <p className="text-xs text-muted-foreground">
          {attribution.unassignedPersonCount > 0 && (
            <>
              {attribution.unassignedPersonCount} of {attribution.taxDocCount} tax documents have no person assigned
            </>
          )}
          {attribution.unassignedPersonCount > 0 && attribution.missingIssuerCount > 0 && "; "}
          {attribution.missingIssuerCount > 0 && (
            <>
              {attribution.missingIssuerCount} have no issuer/payer saved
            </>
          )}
          {" — "}
          <Link href={"/documents?bucket=taxes" as Route} className="text-primary hover:underline">
            assign them on Documents
          </Link>
          . This does not change any readiness or figure on this page.
        </p>
      )}

      <div className="rounded-md border border-dashed px-4 py-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Next phase: PDF form filling and export</p>
        <p className="mt-0.5">
          Filling the official PDF forms and exporting them is the next phase and is not available yet. The CSV bundle
          on each business workspace is unchanged. Everything here is a draft for your CPA to review — this is not tax
          advice, and nothing is filed from this page.
        </p>
      </div>
    </div>
  );
}
