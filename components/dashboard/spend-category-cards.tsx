"use client";

interface CategoryCard {
  tagId: string;
  tagShortName: string;
  budgeted: number;
  spent: number;
  percentUsed: number;
  isOverspent: boolean;
}

interface Props {
  cards: CategoryCard[];
  onSelect: (tagId: string) => void;
}

function statusColor(card: CategoryCard) {
  if (card.isOverspent) return { bar: "bg-destructive", text: "text-destructive" };
  if (card.percentUsed >= 80) return { bar: "bg-amber-500", text: "text-amber-600" };
  return { bar: "bg-primary", text: "text-green-600" };
}

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

export function SpendCategoryCards({ cards, onSelect }: Props) {
  if (cards.length === 0) return null;

  return (
    <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c) => {
        const { bar, text } = statusColor(c);
        return (
          <button
            key={c.tagId}
            type="button"
            onClick={() => onSelect(c.tagId)}
            className="rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent/50 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <p className="text-xs font-medium text-muted-foreground truncate mb-1">{c.tagShortName}</p>
            <p className={`text-lg font-bold tabular-nums ${text}`}>{fmt(c.spent)}</p>
            {c.budgeted > 0 && (
              <>
                <p className="text-xs text-muted-foreground mt-0.5">of {fmt(c.budgeted)}</p>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${bar}`}
                    style={{ width: `${Math.min(c.percentUsed, 100)}%` }}
                  />
                </div>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
