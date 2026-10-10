import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OilPriceForm } from "@/components/forecast/oil-price-form";
import { McCarthyToggle } from "@/components/forecast/mccarthy-toggle";
import { CHECK_TITLE, EXCLUDED_TITLE, type UiSeasonalLine, type UiSeasonalSite, type UiToggleRow } from "@/lib/seasonal-energy-view";

// "Seasonal bills" card(s) on /forecast: one card per entity that has Electric / Oil / Firewood lines. Plain server
// component (no hooks); the only interactive part is the client leaf OilPriceForm. Everything shown is an estimate built
// from the owner's own payments (observation, not advice); a gated line says why and which figure stays in use, and
// shows no number of its own.

function Badge({ line }: { line: UiSeasonalLine }) {
  return line.status === "estimate" ? (
    <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-amber-700">
      {line.badge}
    </span>
  ) : (
    <span className="rounded-full border border-muted-foreground/30 bg-muted px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground">
      {line.badge}
    </span>
  );
}

function ToggleList({ title, help, rows, entityId, notOil }: { title: string; help: string; rows: UiToggleRow[]; entityId: string; notOil: boolean }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border bg-muted/20 p-2" data-testid={notOil ? "mccarthy-check" : "mccarthy-excluded"}>
      <p className="text-xs font-medium">
        {title} ({rows.length})
      </p>
      <p className="text-xs text-muted-foreground">{help}</p>
      <ul className="divide-y rounded border bg-background text-xs">
        {rows.map((row) => (
          <li key={row.txId} className="flex flex-wrap items-center justify-between gap-2 px-2 py-1">
            <span>
              {row.date}
              {row.account ? <span className="text-muted-foreground"> · {row.account}</span> : null}
              <span className="ml-2 tabular-nums">{row.amount}</span>
              {row.notes.map((n) => (
                <span key={n} className="block text-muted-foreground">
                  {n}
                </span>
              ))}
            </span>
            <McCarthyToggle entityId={entityId} txId={row.txId} notOil={notOil} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function LineBlock({ line, entityId }: { line: UiSeasonalLine; entityId: string }) {
  return (
    <section className="space-y-2" aria-label={line.title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{line.title}</h3>
        <Badge line={line} />
      </div>

      {line.status === "gated" && (
        <p className="text-xs text-muted-foreground">
          {line.reason}
          {line.budgetNote ? ` The budget figure (${line.budgetNote}) stays in use.` : " The budget and bill figures stay in use."}
        </p>
      )}

      {line.status === "estimate" && (
        <>
          {line.headline && <p className="text-sm">{line.headline}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Month</th>
                  <th className="py-1.5 px-3 text-right font-medium">Estimate</th>
                  <th className="py-1.5 px-3 text-right font-medium">Range</th>
                  <th className="py-1.5 px-3 text-right font-medium">Budget figure</th>
                  <th className="py-1.5 pl-3 font-medium">Based on</th>
                </tr>
              </thead>
              <tbody>
                {line.table.map((row) => (
                  <tr key={row.period} className="border-b last:border-0">
                    <td className="py-1.5 pr-3 font-medium">{row.label}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-medium">
                      ~{row.amount}
                    </td>
                    <td className="py-1.5 px-3 text-right tabular-nums text-muted-foreground">{row.range}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums text-muted-foreground">{row.budget ?? "-"}</td>
                    <td className="py-1.5 pl-3 text-xs text-muted-foreground">{row.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {line.basis && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">Basis. </span>
              {line.basis}
            </p>
          )}
        </>
      )}

      {line.extra.map((text) => (
        <p key={text} className="text-xs text-muted-foreground">
          {text}
        </p>
      ))}

      {line.payments.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {line.paymentsTitle} ({line.payments.length})
          </summary>
          <ul className="mt-1 divide-y rounded border bg-background">
            {line.payments.map((p) => (
              <li key={p.key} className="flex flex-wrap items-baseline justify-between gap-x-3 px-2 py-1">
                <span>
                  {p.date}
                  {p.account ? <span className="text-muted-foreground"> · {p.account}</span> : null}
                  {p.tag ? <span className="block text-muted-foreground">{p.tag}</span> : null}
                </span>
                <span className="tabular-nums">{p.amount}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <ToggleList
        title={CHECK_TITLE}
        help="Tags on McCarthy rows are not reliable, so these look like they may not be heating oil (a repair, a service call, a charge for another property). They are counted until you mark them. Marking a charge only leaves it out of this oil history; the transaction is not changed."
        rows={line.check}
        entityId={entityId}
        notOil
      />
      <ToggleList
        title={EXCLUDED_TITLE}
        help="These are left out of every oil figure. Count one again if it was marked by mistake."
        rows={line.excluded}
        entityId={entityId}
        notOil={false}
      />
    </section>
  );
}

export function SeasonalCard({ sites }: { sites: UiSeasonalSite[] }) {
  if (sites.length === 0) return null;
  return (
    <>
      {sites.map((site) => (
        <Card key={site.entityId} data-testid="seasonal-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Seasonal bills — {site.entityName}</CardTitle>
            <p className="text-xs text-muted-foreground">
              Electric, oil and firewood swing with the seasons. These figures are estimates built from your own payments
              (never invented), shown only once there is enough history; otherwise the budget figure stays in use and the
              reason is given. Not a guarantee, and not advice.
            </p>
            {site.notes.map((note) => (
              <p key={note} className="text-xs text-muted-foreground">
                {note}
              </p>
            ))}
          </CardHeader>
          <CardContent className="space-y-5">
            {site.lines.map((line) => (
              <div key={line.kind} className="space-y-3">
                <LineBlock line={line} entityId={site.entityId} />
                {line.kind === "oil" && site.oilPrices && <OilPriceForm prices={site.oilPrices} />}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </>
  );
}
