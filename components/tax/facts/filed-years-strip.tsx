import Link from "next/link";
import type { Route } from "next";
import { YearStateBadge } from "@/components/tax/year-state-badge";
import type { YearState } from "@/lib/tax-year-close/state";

// A one-line strip on the facts pages: the tax years marked filed or reopened, each linking to its Tax Forms page. Editing a
// filed year's facts is allowed (the label is soft) but visible. Renders nothing when no year is marked.

export function FiledYearsStrip({ states }: { states: readonly YearState[] }) {
  const marked = states.filter((s) => s.status !== "open");
  if (marked.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="filed-years-strip">
      <span>Tax years marked:</span>
      {marked.map((s) => (
        <Link key={s.taxYear} href={`/tax/forms/${s.taxYear}` as Route} className="hover:opacity-80">
          <YearStateBadge state={s} />
        </Link>
      ))}
    </div>
  );
}
