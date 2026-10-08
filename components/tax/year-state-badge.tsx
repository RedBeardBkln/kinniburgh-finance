import { yearBadgeText } from "@/lib/tax-year-close/format";
import type { YearState } from "@/lib/tax-year-close/state";

// Presentational: "TY2025 filed 2026-10-12" (green) or "TY2025 reopened for revision" (amber); nothing for an open year.
// A label only: it changes no computation, form, PDF or approval.

export function YearStateBadge({ state }: { state: Pick<YearState, "status" | "taxYear" | "filedOn"> | null | undefined }) {
  if (!state) return null;
  const text = yearBadgeText(state);
  if (text === null) return null;
  const tone =
    state.status === "closed"
      ? "border-green-300 bg-green-50 text-green-800"
      : "border-amber-300 bg-amber-50 text-amber-900";
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`} data-testid="year-state-badge">
      {state.status === "closed" ? "✓ " : ""}
      {text}
    </span>
  );
}
