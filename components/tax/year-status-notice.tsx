import Link from "next/link";
import type { Route } from "next";
import { YearStateBadge } from "@/components/tax/year-state-badge";
import { yearBannerText } from "@/lib/tax-year-close/format";
import type { YearState } from "@/lib/tax-year-close/state";
import { loadYearCloseStates } from "@/lib/tax-year-close-store";

// The "this year is filed / reopened" indicator for any page that shows a tax year: the badge plus a one-line banner. It loads
// the state itself through the fail-soft loader and renders NOTHING for an open year, a missing table (the migration is not
// applied yet), no Personal entity or any error, so it can never break a page. It is a soft notice: it blocks nothing.

export function YearNoticeBlock({ state }: { state: YearState }) {
  const banner = yearBannerText(state);
  if (banner === null) return null;
  const closed = state.status === "closed";
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm print:hidden ${
        closed ? "border-green-300 bg-green-50 text-green-900" : "border-amber-300 bg-amber-50 text-amber-950"
      }`}
      role="status"
      data-testid="year-status-notice"
    >
      <YearStateBadge state={state} />
      <span>{banner}</span>
      <Link href={`/tax/forms/${state.taxYear}` as Route} className="text-xs font-medium underline">
        Tax Forms {state.taxYear}
      </Link>
    </div>
  );
}

export async function YearStatusNotice({ year }: { year: number }) {
  const load = await loadYearCloseStates();
  if (load.state !== "ok") return null;
  const state = load.byYear.get(year);
  if (!state || state.status === "open") return null;
  return <YearNoticeBlock state={state} />;
}
