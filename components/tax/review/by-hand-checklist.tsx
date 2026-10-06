import { LinkList } from "@/components/tax/review/finding-links";
import { byHandLinks, EMPTY_LINK_CONTEXT, type LinkContext } from "@/lib/tax-review/links";
import { REVIEW_ANCHORS } from "@/lib/tax-anchors";
import { byHandItems } from "@/lib/tax2025/pdf/final-package";

// The "enter by hand before filing" checklist: the very list the final package index prints (byHandItems over BY_HAND in
// lib/tax2025/pdf/final-package.ts), so the page and the package never disagree. The two overpayment bullets leave the list once the
// owner records decision X7 / X8 (the decisions come from the engine on the server). Information only; it gates nothing.

export function ByHandChecklist({
  links = EMPTY_LINK_CONTEXT,
  decisions,
}: {
  links?: LinkContext;
  decisions?: readonly { id: string; status: "decided" | "default_undecided" }[];
}) {
  return (
    <section id={REVIEW_ANCHORS.byHand} aria-labelledby="byhand-heading" className="anchor-target space-y-2 rounded-lg border p-4" data-testid="review-byhand">
      <h2 id="byhand-heading" className="text-base font-semibold">
        To do by hand before you file
      </h2>
      <p className="text-sm text-muted-foreground">
        The app never stores or fills these. Complete them on the printed forms, and keep the broker&apos;s Form 1099-B detail pages with the return (the Form 8949 statement in the package is a summary only).
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {byHandItems(decisions).map((t) => (
          <li key={t}>
            {t}
            <LinkList links={byHandLinks(t, links)} />
          </li>
        ))}
        <li>The paid preparer, firm and PTIN boxes stay blank on a return you prepared yourself.</li>
      </ul>
    </section>
  );
}
