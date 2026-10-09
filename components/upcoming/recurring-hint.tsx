import Link from "next/link";
import type { Route } from "next";
import { RECURRING_UNAVAILABLE, type UiDetection } from "@/lib/upcoming-ledger-view";

// The dashboard hint lives apart from the review list on purpose: the widget imports only this file, so it never
// pulls in the client buttons and their server actions.

interface RecurringHintProps {
  detection: UiDetection | null | undefined;
  bucketSlug: string;
}

/** Dashboard: one muted line under the summary strip, only when there is something to say. */
export function RecurringHint({ detection, bucketSlug }: RecurringHintProps) {
  if (detection === undefined) return null;
  if (detection === null) return <p className="text-xs text-muted-foreground">{RECURRING_UNAVAILABLE}</p>;
  const looks = detection.suggestions.length;
  const late = detection.flags.filter((f) => f.type === "late");
  if (looks === 0 && late.length === 0) return null;

  const parts: string[] = [];
  if (looks > 0) parts.push(`${looks} item${looks === 1 ? " looks" : "s look"} recurring but ${looks === 1 ? "is" : "are"} not in your budget`);
  if (late.length > 0) parts.push(`${late.length} expected bill${late.length === 1 ? " has" : "s have"} not posted`);
  const href = `/forecast?bucket=${bucketSlug}#looks-recurring` as Route;

  return (
    <div className="space-y-1" data-testid="recurring-hint">
      <p className="text-xs text-muted-foreground">
        {parts.join(", ")}.{" "}
        <Link href={href} className="underline underline-offset-4">
          Review
        </Link>
      </p>
      {late.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Expected bills not posted ({late.length})</summary>
          <ul>
            {late.slice(0, 5).map((f) => (
              <li key={f.text} className="text-xs text-amber-700">
                {f.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
