import { UsageArchiveButton } from "@/components/forecast/usage-archive-button";
import { UsageUploadForm } from "@/components/forecast/usage-upload-form";
import { MAX_TEXT_CHARS } from "@/lib/utility-usage-parse";
import type { UiSeasonalSite } from "@/lib/seasonal-energy-view";

// "Usage history" block of the Seasonal card for ONE site: a compact table per utility (one row per year, January to
// December, the month's total in the utility's unit), a per-year list of the saved rows with a Remove button (archive only),
// and the "Add history" form. Plain server component; the interactive parts are the two client leaves. When the usage table
// is not available the whole block is replaced by one muted line and nothing else on the card changes.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function UsageHistory({ site }: { site: UiSeasonalSite }) {
  if (site.usageStatus !== "ok") {
    return (
      <p className="text-xs text-muted-foreground" data-testid="usage-unavailable">
        {site.usageStatus === "not_set_up"
          ? "Usage history is not set up yet. The estimates above use your payments, as before."
          : "Usage history could not be read right now. The estimates above use your payments, as before."}
      </p>
    );
  }
  return (
    <section
      id={`usage-history-${site.entityId}`}
      data-toc-label="Usage history"
      data-toc-level="2"
      className="scroll-mt-4 space-y-3"
      aria-label="Usage history"
      data-testid="usage-history"
    >
      <h3 className="text-sm font-semibold">Usage history</h3>
      {site.usageHistory.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No usage uploaded yet. Add your monthly kWh, oil deliveries or firewood purchases so the estimates follow the real seasons; until then they use your payments.
        </p>
      ) : (
        site.usageHistory.map((h) => (
          <details key={h.kind} className="text-xs" data-testid={`usage-history-${h.kind}`}>
            <summary className="cursor-pointer text-muted-foreground">
              {h.title}: {h.count} row{h.count === 1 ? "" : "s"} on file ({h.unit})
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Year</th>
                    {MONTHS.map((m) => (
                      <th key={m} className="px-1 py-1 text-right font-medium">
                        {m}
                      </th>
                    ))}
                    <th className="py-1 pl-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {h.years.map((y) => (
                    <tr key={y.year} className="border-b last:border-0">
                      <td className="py-1 pr-2 font-medium">{y.year}</td>
                      {y.cells.map((c, i) => (
                        <td key={i} className="px-1 py-1 text-right tabular-nums">
                          {c ?? <span className="text-muted-foreground">-</span>}
                        </td>
                      ))}
                      <td className="py-1 pl-2 text-right font-medium tabular-nums">{y.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {h.years.map((y) => (
              <details key={y.year} className="mt-1">
                <summary className="cursor-pointer text-muted-foreground">
                  {y.year}: {y.rows.length} row{y.rows.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-1 divide-y rounded border bg-background">
                  {y.rows.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 py-1">
                      <span>
                        {r.date}
                        <span className="ml-2 tabular-nums">{r.quantity}</span>
                        {r.cost ? <span className="ml-2 tabular-nums text-muted-foreground">{r.cost}</span> : null}
                        {r.note ? <span className="ml-2 text-muted-foreground">({r.note})</span> : null}
                      </span>
                      <UsageArchiveButton entityId={site.entityId} id={r.id} label={`${h.title} ${r.date}`} />
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </details>
        ))
      )}
      {site.usageKinds.length > 0 && <UsageUploadForm entityId={site.entityId} kinds={site.usageKinds} maxChars={MAX_TEXT_CHARS} hasSolar={site.usageHasSolar} />}
    </section>
  );
}
