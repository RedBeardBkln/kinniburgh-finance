import Link from "next/link";
import type { Route } from "next";
import { yearNotice } from "@/lib/tax-default-year";

/**
 * Shown on the Forms page and every questionnaire page when the viewed tax year is not the year being filed
 * (the owner once spent an hour answering the wrong year's questionnaire). Renders nothing for the default year.
 */
export function YearNotice({ viewedYear, defaultYear, hrefForDefaultYear }: { viewedYear: number; defaultYear: number; hrefForDefaultYear: string }) {
  const n = yearNotice(viewedYear, defaultYear, hrefForDefaultYear);
  if (n === null) return null;
  return (
    <div role="alert" className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">
      <strong>{n.message}</strong>{" "}
      <Link href={n.href as Route} className="underline">
        {n.linkText}
      </Link>
      .
    </div>
  );
}
