import type { VerifiedCard } from "@/lib/tax-review/info-cards";

// The "by hand" information cards (filing logistics, records and corrections). Server component. Every statement shown here carries its
// source (the title, the page and the link) and a verbatim quote that was checked against the pinned source pack when the page was
// built; a statement whose quote does not verify is not passed to this component at all (lib/tax-review/info-cards.ts verifyCards).

export function InfoCards({ cards }: { cards: readonly VerifiedCard[] }) {
  if (cards.length === 0) return null;
  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="review-info-cards">
      {cards.map((card) => (
        <section key={card.id} aria-labelledby={`info-${card.id}`} className="space-y-2 rounded-lg border p-4" data-testid={`info-card-${card.id}`}>
          <h2 id={`info-${card.id}`} className="text-base font-semibold">
            {card.title}
          </h2>
          <p className="text-xs font-medium text-amber-900">{card.label}</p>
          <ul className="space-y-2 text-sm">
            {card.statements.map((s) => (
              <li key={s.id} data-source={s.sourceId}>
                <p>{s.text}</p>
                <p className="text-xs text-muted-foreground">
                  <a href={s.url} target="_blank" rel="noreferrer" className="underline">
                    {s.sourceTitle}
                  </a>
                  , page {s.page}: <span className="italic">&ldquo;{s.quote}&rdquo;</span>
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
