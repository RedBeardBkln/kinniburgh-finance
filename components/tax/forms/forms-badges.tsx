import type {
  FormApplicability,
  FormJurisdiction,
  FormReadiness,
} from "@/lib/tax-forms";

// Presentational badges for the Forms page (server-renderable, no state).

const APPLICABILITY: Record<FormApplicability, { label: string; className: string }> = {
  required: { label: "Required", className: "border-blue-300 bg-blue-50 text-blue-800" },
  conditional: { label: "Conditional", className: "border-amber-300 bg-amber-50 text-amber-800" },
  needs_cpa_input: { label: "Needs your input", className: "border-violet-300 bg-violet-50 text-violet-800" },
  not_applicable: { label: "Not applicable", className: "border-transparent bg-muted text-muted-foreground" },
};

const READINESS: Record<FormReadiness, { label: string; className: string }> = {
  ready: { label: "Ready", className: "border-green-300 bg-green-50 text-green-700" },
  partial: { label: "Partial", className: "border-amber-300 bg-amber-50 text-amber-800" },
  missing: { label: "Missing data", className: "border-red-300 bg-red-50 text-red-700" },
  not_assessed: { label: "Not assessed", className: "border-transparent bg-muted text-muted-foreground" },
};

const PILL = "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium";

export function ApplicabilityBadge({ applicability }: { applicability: FormApplicability }) {
  const a = APPLICABILITY[applicability];
  return <span className={`${PILL} ${a.className}`}>{a.label}</span>;
}

export function ReadinessBadge({ readiness }: { readiness: FormReadiness }) {
  const r = READINESS[readiness];
  return <span className={`${PILL} ${r.className}`}>{r.label}</span>;
}

export function JurisdictionBadge({ jurisdiction }: { jurisdiction: FormJurisdiction }) {
  return (
    <span className={`${PILL} border-transparent bg-secondary text-secondary-foreground`}>
      {jurisdiction === "ct" ? "Connecticut" : "Federal"}
    </span>
  );
}

export function ConfirmWithCpaBadge() {
  return <span className={`${PILL} border-amber-400 bg-amber-100 text-amber-900`}>Confirm yourself</span>;
}
