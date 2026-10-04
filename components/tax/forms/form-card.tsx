import Link from "next/link";
import type { Route } from "next";
import type { FormEntry, FormInputRef } from "@/lib/tax-forms";
import {
  ApplicabilityBadge,
  ConfirmWithCpaBadge,
  JurisdictionBadge,
  ReadinessBadge,
} from "@/components/tax/forms/forms-badges";
import { FormFieldList } from "@/components/tax/forms/form-field-list";
import { QuestionnaireCardBlock } from "@/components/tax/forms/questionnaire-card-block";
import type { ExtractionTone } from "@/lib/document-extraction-state";
import type { CardConclusion } from "@/lib/tax2025-sheet-conclusions";

// Same palette as the Documents list's Extraction badge (kept local: that map
// lives in a "use client" module, which a server component must not import values from).
const TONE_CLASS: Record<ExtractionTone, string> = {
  muted: "border-border bg-muted text-muted-foreground",
  blue: "border-blue-200 bg-blue-50 text-blue-700",
  red: "border-red-200 bg-red-50 text-red-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  green: "border-green-200 bg-green-50 text-green-700",
};

// One form's card: why it is (or is not) needed + the citation, which uploaded
// documents feed it, and how ready it is. Server-renderable; the missing-field
// disclosure uses a native <details>, so no client JS is needed.

function InputRow({ input }: { input: FormInputRef }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <Link href={input.href as Route} className="font-medium text-primary hover:underline">
        {input.name}
      </Link>
      <span className="text-muted-foreground">{input.docTypeLabel}</span>
      {input.priorYear && input.taxYear !== null && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          prior year · TY{input.taxYear}
        </span>
      )}
      <span
        className={
          input.personAssigned
            ? "rounded-full bg-muted px-1.5 py-0.5 text-[10px]"
            : "rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800"
        }
      >
        {input.personLabel}
      </span>
      {input.issuer && (
        <span className="text-muted-foreground">
          {input.issuer}
          {input.issuerIsSuggestion && <span className="italic"> (suggested from document)</span>}
        </span>
      )}
      {input.extraction ? (
        <span
          className={`rounded-full border px-1.5 py-0.5 text-[10px] ${TONE_CLASS[input.extraction.tone]}`}
          title={input.extraction.reason ?? input.extraction.hint}
        >
          {input.extraction.label}
        </span>
      ) : (
        !input.extractionComplete && (
          <span className="rounded-full border border-amber-300 px-1.5 py-0.5 text-[10px] text-amber-800">
            extraction {input.extractionStatus ?? "not run"}
          </span>
        )
      )}
      {input.reviewHref && (
        <Link href={input.reviewHref as Route} prefetch={false} className="text-[10px] text-primary hover:underline">
          {input.verified ? "View" : "Review"}
        </Link>
      )}
    </li>
  );
}

const CONCLUSION_CLASS: Record<CardConclusion["tone"], string> = {
  computed: "border-green-200 bg-green-50 text-green-900",
  not_required: "border-border bg-muted text-foreground",
  blocked: "border-amber-300 bg-amber-50 text-amber-900",
};

export function FormCard({
  entry,
  taxYear,
  conclusion,
}: {
  entry: FormEntry;
  taxYear: number;
  /** The TY2025 engine's one-sentence conclusion for this card (2025 only); does not touch any counter. */
  conclusion?: CardConclusion;
}) {
  const muted = entry.applicability === "not_applicable";
  const showReadiness = !muted && entry.readiness !== "not_assessed";
  const pct = entry.fieldsTotal > 0 ? Math.round((entry.fieldsReady / entry.fieldsTotal) * 100) : 0;

  return (
    <div className={`rounded-lg border bg-card p-4 ${muted ? "opacity-75" : ""}`} id={entry.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{entry.formName}</p>
          <p className="text-xs text-muted-foreground">{entry.filer}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <JurisdictionBadge jurisdiction={entry.jurisdiction} />
          <ApplicabilityBadge applicability={entry.applicability} />
          {entry.confirmWithCpa && <ConfirmWithCpaBadge />}
        </div>
      </div>

      <p className="mt-2 text-sm">{entry.reason}</p>
      {entry.cpaNote && <p className="mt-1 text-xs text-muted-foreground">{entry.cpaNote}</p>}
      <p className="mt-1 text-[11px] text-muted-foreground">Source: {entry.source}</p>

      {conclusion && (
        <p
          className={`mt-2 rounded-md border px-2 py-1.5 text-xs ${CONCLUSION_CLASS[conclusion.tone]}`}
          data-testid="engine-conclusion"
        >
          <span className="font-semibold">Engine conclusion (DRAFT, for the CPA): </span>
          {conclusion.text}{" "}
          <Link href={`/tax/forms/${taxYear}/return` as Route} className="underline print:hidden">
            See the review sheet
          </Link>
        </p>
      )}

      {entry.opportunity && (
        <p className="mt-2 text-xs">
          <span className="font-medium">Named by:</span> {entry.opportunity.title}{" "}
          <span className={`ml-1 rounded-full border px-1.5 py-0.5 text-[10px] ${entry.opportunity.riskClass}`}>
            {entry.opportunity.riskLabel}
          </span>
        </p>
      )}

      {entry.questionnaire && <QuestionnaireCardBlock state={entry.questionnaire} taxYear={taxYear} />}

      {showReadiness && (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <ReadinessBadge readiness={entry.readiness} />
            <span className="text-xs text-muted-foreground">
              {entry.fieldsReady}/{entry.fieldsTotal} fields have data
            </span>
          </div>
          {entry.fieldsReady > 0 && (
            <p className="text-[11px] text-muted-foreground" data-testid="basis-counts">
              {[
                entry.fieldsVerified > 0 ? `${entry.fieldsVerified} verified` : null,
                entry.fieldsUnverified > 0 ? `${entry.fieldsUnverified} from unverified AI extraction` : null,
                entry.fieldsOtherSource > 0 ? `${entry.fieldsOtherSource} from answers/books` : null,
                `${entry.fieldsTotal - entry.fieldsReady} missing`,
              ]
                .filter((part): part is string => part !== null)
                .join(" · ")}
            </p>
          )}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              {entry.missing.length > 0 ? `Show ${entry.missing.length} missing field(s) and all fields` : "Show fields"}
            </summary>
            <div className="mt-2">
              <FormFieldList fields={entry.fields} taxYear={taxYear} />
            </div>
          </details>
        </div>
      )}

      {entry.inputs.length > 0 && (
        <div className="mt-3 border-t pt-2">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
            Feeding documents
          </p>
          <ul className="space-y-1">
            {entry.inputs.map((input) => (
              <InputRow key={`${entry.id}-${input.id}`} input={input} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
