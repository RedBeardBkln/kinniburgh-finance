import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { computeBalanceSheet } from "@/lib/reports";
import { exportBalanceSheetCsv, exportPeriodBalanceSheetCsv } from "@/actions/reports";
import { ExportCsvButton } from "@/components/export-csv-button";
import {
  parsePeriodSelector,
  buildPeriodBalanceSheet,
  type PeriodRange,
} from "@/lib/period-balance-sheet";
import { getPeriodBalanceSheet } from "@/actions/bank-statements";
import type { Route } from "next";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ period?: string }>;
}

function fmtUSD(cents: number): string {
  const abs = Math.abs(cents);
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(abs / 100);
  return cents < 0 ? `(${formatted})` : formatted;
}

function fmtDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Month/quarter/year selector chips for a given year. */
function PeriodPicker({ slug, active, year }: { slug: string; active: string; year: number }) {
  const items: { value: string; label: string }[] = [];
  for (let q = 1; q <= 4; q++) items.push({ value: `${year}-Q${q}`, label: `Q${q}` });
  for (let m = 1; m <= 12; m++) {
    items.push({ value: `${year}-${String(m).padStart(2, "0")}`, label: new Date(Date.UTC(year, m - 1, 1)).toLocaleDateString("en-US", { month: "short" }) });
  }
  items.push({ value: String(year), label: `FY ${year}` });

  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Link
          key={item.value}
          href={`/business/${slug}/balance-sheet?period=${item.value}` as Route}
          className={`rounded-md px-2.5 py-1 text-xs border ${
            active === item.value
              ? "bg-primary text-primary-foreground border-primary"
              : "border-input bg-background hover:bg-accent"
          }`}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}

export default async function BalanceSheetPage({ params, searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { slug } = await params;
  const sp = await searchParams;
  const entity = await getEntityBySlug(slug);
  const entityLabel = entity?.navLabel ?? entity?.name ?? slug;

  if (!entity) redirect("/business" as Route);

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const selector = sp.period ?? "current";
  const period: PeriodRange | null =
    selector === "current" ? null : parsePeriodSelector(selector);

  // Base (live) balance sheet — used for "current" view and as fallback
  const live = await computeBalanceSheet(entity.id);

  let view: {
    label: string;
    asOfLabel: string;
    assets: { id: string; label: string; mask: string | null; amountCents: number }[];
    liabilities: { id: string; label: string; mask: string | null; amountCents: number }[];
    totalAssetsCents: number;
    totalLiabilitiesCents: number;
    equityCents: number;
    source: "live" | "statements" | "statements+live";
    statementCount: number;
  };

  if (!period) {
    const asOfLabel = live.asOfDate.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    view = {
      label: "Current",
      asOfLabel,
      assets: live.assets,
      liabilities: live.liabilities,
      totalAssetsCents: live.totalAssetsCents,
      totalLiabilitiesCents: live.totalLiabilitiesCents,
      equityCents: live.equityCents,
      source: "live",
      statementCount: 0,
    };
  } else {
    // Statement-driven period balance sheet
    const { snapshots, accounts } = await getPeriodBalanceSheet(
      entity.id,
      period.start,
      period.end
    );
    const fromStatements = buildPeriodBalanceSheet(snapshots, accounts, period);

    // Statement accounts that already provide balances — exclude them from the live fallback
    const coveredAccountIds = new Set(fromStatements.assets.map((a) => a.key).concat(fromStatements.liabilities.map((l) => l.key)));

    // Live fallback for accounts with no statement in the period. Derived
    // from `live` (already fetched above via computeBalanceSheet) rather
    // than a separate db.account query — liveAssets/liveLiabilities below
    // already tell us whether any live-fallback accounts exist.
    const liveAssets = live
      .assets.filter((a) => !coveredAccountIds.has(a.id))
      .map((a) => ({ ...a, source: "live" as const }));
    const liveLiabilities = live
      .liabilities.filter((l) => !coveredAccountIds.has(l.id))
      .map((l) => ({ ...l, source: "live" as const }));

    const assets = [
      ...fromStatements.assets.map((a) => ({ id: a.key, label: a.label, mask: a.mask, amountCents: a.balanceCents })),
      ...liveAssets.map((a) => ({ id: a.id, label: `${a.label} (live)`, mask: a.mask, amountCents: a.amountCents })),
    ];
    const liabilities = [
      ...fromStatements.liabilities.map((l) => ({ id: l.key, label: l.label, mask: l.mask, amountCents: l.balanceCents })),
      ...liveLiabilities.map((l) => ({ id: l.id, label: `${l.label} (live)`, mask: l.mask, amountCents: l.amountCents })),
    ];

    const totalAssetsCents = assets.reduce((s, a) => s + a.amountCents, 0);
    const totalLiabilitiesCents = liabilities.reduce((s, l) => s + l.amountCents, 0);

    view = {
      label: period.label,
      asOfLabel: `${fmtDate(period.start)} – ${fmtDate(period.end)}`,
      assets,
      liabilities,
      totalAssetsCents,
      totalLiabilitiesCents,
      equityCents: totalAssetsCents - totalLiabilitiesCents,
      source: fromStatements.hasData
        ? liveAssets.length + liveLiabilities.length > 0
          ? "statements+live"
          : "statements"
        : "live",
      statementCount: fromStatements.assets.length + fromStatements.liabilities.length,
    };
  }

  const csvAction =
    !period
      ? exportBalanceSheetCsv.bind(null, entity.id)
      : exportPeriodBalanceSheetCsv.bind(null, entity.id, selector);

  const years = [currentYear - 1, currentYear, currentYear + 1];

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6 max-w-2xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Link href={"/business" as Route} className="hover:underline">Business</Link>
              <span>/</span>
              <span>{entityLabel}</span>
            </div>
            <h1 className="text-2xl font-semibold">Balance Sheet</h1>
            <p className="text-sm text-muted-foreground">
              {view.label} · {view.asOfLabel}
            </p>
          </div>
          <ExportCsvButton
            filename={`balance-sheet-${slug}-${selector === "current" ? view.asOfLabel.replace(/[^A-Za-z0-9]+/g, "-") : selector}.csv`}
            action={csvAction}
          />
        </div>

        {/* Period selectors */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/business/${slug}/balance-sheet` as Route}
              className={`rounded-md px-3 py-1.5 text-sm border ${
                selector === "current"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-input bg-background hover:bg-accent"
              }`}
            >
              Current
            </Link>
            {years.map((y) => (
              <PeriodPickerGroup key={y} slug={slug} year={y} active={selector} currentYear={currentYear} />
            ))}
          </div>
          <PeriodPicker slug={slug} active={selector} year={Number(selector.slice(0, 4)) || currentYear} />
          <Link
            href={`/business/${slug}/statements` as Route}
            className="inline-block text-xs text-primary hover:underline"
          >
            Upload bank statements for this entity →
          </Link>
        </div>

        {/* Data-source note */}
        {period && view.source === "live" && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            No bank statements cover this period — showing live account balances instead.
            Upload statements to lock in period-accurate figures.
          </div>
        )}
        {period && view.source === "statements+live" && (
          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
            Statement balances cover {view.statementCount} account
            {view.statementCount === 1 ? "" : "s"}; other accounts fall back to live balances.
          </div>
        )}

        {/* Assets */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-green-700">Assets</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {view.assets.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-6 text-center text-muted-foreground">
                      No asset accounts linked to this entity
                    </td>
                  </tr>
                ) : (
                  view.assets.map((a) => (
                    <tr key={a.id} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        {a.label}
                        {a.mask && <span className="ml-1.5 text-xs text-muted-foreground">···{a.mask}</span>}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-green-600">
                        {fmtUSD(a.amountCents)}
                      </td>
                    </tr>
                  ))
                )}
                <tr className="border-t bg-muted/30 font-semibold">
                  <td className="px-4 py-2">Total Assets</td>
                  <td className="px-4 py-2 text-right tabular-nums text-green-600">
                    {fmtUSD(view.totalAssetsCents)}
                  </td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Liabilities */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-destructive">Liabilities</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {view.liabilities.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-6 text-center text-muted-foreground">
                      No liability accounts linked to this entity
                    </td>
                  </tr>
                ) : (
                  view.liabilities.map((l) => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        {l.label}
                        {l.mask && <span className="ml-1.5 text-xs text-muted-foreground">···{l.mask}</span>}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-destructive">
                        {fmtUSD(l.amountCents)}
                      </td>
                    </tr>
                  ))
                )}
                <tr className="border-t bg-muted/30 font-semibold">
                  <td className="px-4 py-2">Total Liabilities</td>
                  <td className="px-4 py-2 text-right tabular-nums text-destructive">
                    {fmtUSD(view.totalLiabilitiesCents)}
                  </td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Equity */}
        <Card className={view.equityCents >= 0 ? "border-green-200 bg-green-50/50" : "border-destructive/30 bg-destructive/5"}>
          <CardContent className="flex items-center justify-between py-4 px-4">
            <p className="font-semibold text-base">Equity (Assets − Liabilities)</p>
            <p className={`text-xl font-bold ${view.equityCents >= 0 ? "text-green-600" : "text-destructive"}`}>
              {fmtUSD(view.equityCents)}
            </p>
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          {period
            ? "Period figures use closing balances from uploaded bank statements; accounts without a statement in the period fall back to the most recent synced balance. Business-owned fixed assets not linked to accounts are excluded."
            : "Balances reflect the most recent account sync. Business-owned fixed assets not yet linked to accounts are excluded."}{" "}
          Confirm all figures with your CPA — this is not financial advice.
        </p>
      </div>
    </AppShell>
  );
}

function PeriodPickerGroup({
  slug,
  year,
  active,
  currentYear,
}: {
  slug: string;
  year: number;
  active: string;
  currentYear: number;
}) {
  // Year-level toggle: highlights when a period of that year is selected
  const isActive =
    active === String(year) ||
    active.startsWith(`${year}-`);
  return (
    <Link
      href={`/business/${slug}/balance-sheet?period=${year}` as Route}
      className={`rounded-md px-3 py-1.5 text-sm border ${
        isActive
          ? "bg-primary text-primary-foreground border-primary"
          : "border-input bg-background hover:bg-accent"
      } ${year === currentYear ? "font-medium" : ""}`}
    >
      {year}
    </Link>
  );
}
