import Link from "next/link";
import type { Route } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CarryRowActions } from "@/components/tax/facts/carry-row-actions";
import { FACTS_CARRY_SCREEN_HONESTY, formatFactValue } from "@/lib/tax-facts/format";
import type { CarryScreen, CarryScreenItem, CarryScreenSection } from "@/lib/tax-facts/carry-screen";
import { FACT_CATEGORY_LABELS } from "@/lib/tax-facts/types";

// Presentational (server) component for /tax/facts/carry/[year]. It writes nothing: the buttons live in the client leaf
// CarryRowActions and each acts on one fact. Every row shows the tax year and version its value came from.

function Row({ item, targetYear }: { item: CarryScreenItem; targetYear: number }) {
  const isOpenItem = item.valueKind === "open_item";
  return (
    <li className="space-y-2 px-4 py-3" data-fact-key={item.factKey}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{item.label}</p>
          <p className="text-xs text-muted-foreground">{FACT_CATEGORY_LABELS[item.category]}</p>
          <p className={item.referenceOnly ? "break-words text-sm italic text-muted-foreground" : "break-words text-sm"}>
            {item.referenceOnly ? `Reference only: ${formatFactValue(item)}` : formatFactValue(item)}
          </p>
          <p className="text-xs text-muted-foreground">{isOpenItem ? `Open since TY${item.fromTaxYear} (v${item.fromVersion})` : item.carriedLabel}</p>
          <p className="text-xs text-muted-foreground">{item.provenanceLabel}</p>
          {item.isDecision && (
            <p className="text-xs text-muted-foreground">
              Recorded copy for recall; the return uses the decision recorded on the Tax Forms page.
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {isOpenItem ? (
            <>
              <span className="rounded-full border border-purple-300 bg-purple-50 px-2 py-0.5 text-xs text-purple-900">
                Question, not a fact: never confirmed here
              </span>
              {item.resolveHref && (
                <Link href={item.resolveHref as Route} className="text-xs text-blue-700 hover:underline">
                  Resolve it on the Owner-confirmed facts page
                </Link>
              )}
            </>
          ) : (
            <CarryRowActions
              fact={{
                factKey: item.factKey,
                label: item.label,
                valueKind: item.valueKind,
                valueText: item.valueText,
                valueCents: item.valueCents,
                fromTaxYear: item.fromTaxYear,
                targetYear,
                canStillTrue: item.canStillTrue,
                canChange: item.canChange,
                canAnswer: item.canAnswer,
                canSameAnswer: item.canSameAnswer,
              }}
            />
          )}
        </div>
      </div>
    </li>
  );
}

function Section({
  title,
  help,
  section,
  targetYear,
  tone,
}: {
  title: string;
  help: string;
  section: CarryScreenSection;
  targetYear: number;
  tone?: "open";
}) {
  return (
    <Card className={tone === "open" ? "border-purple-200" : undefined} data-section={section.id}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          {title} ({section.items.length})
        </CardTitle>
        <p className="text-xs text-muted-foreground">{help}</p>
      </CardHeader>
      <CardContent className="p-0">
        {section.items.length === 0 ? (
          <p className="px-4 pb-3 text-xs text-muted-foreground">Nothing here.</p>
        ) : (
          <ul className="divide-y">
            {section.items.map((i) => (
              <Row key={i.factKey} item={i} targetYear={targetYear} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function CarryForwardReview({ screen, years }: { screen: CarryScreen; years: readonly number[] }) {
  const y = screen.targetYear;
  return (
    <div className="space-y-4">
      <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">{FACTS_CARRY_SCREEN_HONESTY}</p>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Carry into:</span>
        {years.map((year) => (
          <Link
            key={year}
            href={`/tax/facts/carry/${year}` as Route}
            className={
              year === y ? "rounded-md border bg-primary px-2.5 py-1 text-primary-foreground" : "rounded-md border px-2.5 py-1 hover:bg-accent"
            }
          >
            TY{year}
          </Link>
        ))}
      </div>

      <p className="text-sm">
        <span className="font-medium">
          {screen.stillNeedYouCount} still need{screen.stillNeedYouCount === 1 ? "s" : ""} your confirmation or answer for TY{y}
        </span>
        <span className="text-muted-foreground">
          {" "}
          ({screen.needsConfirmationCount} to re-confirm, {screen.askFreshCount} to answer fresh); {screen.openItemCount} open item
          {screen.openItemCount === 1 ? "" : "s"} listed as questions.
        </span>
      </p>

      <Section
        title="Needs re-confirmation"
        help={`Carried as a suggestion. Each one needs your own "still true" for TY${y}, one fact at a time; there is no confirm-all.`}
        section={screen.needsReconfirmation}
        targetYear={y}
      />
      <Section
        title="Ask fresh"
        help={`Year-specific facts are never carried. The earlier value is shown for reference only; answer each one for TY${y}.`}
        section={screen.askFresh}
        targetYear={y}
      />
      <Section
        title="Open items"
        help="Questions still open. They are not facts, are never carried as facts and are never confirmed here; resolve them on the Owner-confirmed facts page."
        section={screen.openItems}
        targetYear={y}
        tone="open"
      />
      <Section
        title="Carried (stable)"
        help={`These carry into TY${y} until you change them. You do not need to confirm them; use "It changed" if one no longer holds.`}
        section={screen.carried}
        targetYear={y}
      />
      <Section
        title={`Already confirmed for TY${y}`}
        help={`You already recorded these for TY${y}.`}
        section={screen.alreadyConfirmed}
        targetYear={y}
      />
    </div>
  );
}
