import { BY_HAND } from "@/lib/tax2025/pdf/final-package";

// The "enter by hand before filing" checklist: the very list the final package index prints (BY_HAND in
// lib/tax2025/pdf/final-package.ts), so the page and the package never disagree. Information only; it gates nothing.

export function ByHandChecklist() {
  return (
    <section aria-labelledby="byhand-heading" className="space-y-2 rounded-lg border p-4" data-testid="review-byhand">
      <h2 id="byhand-heading" className="text-base font-semibold">
        To do by hand before you file
      </h2>
      <p className="text-sm text-muted-foreground">
        The app never stores or fills these. Complete them on the printed forms, and keep the broker&apos;s Form 1099-B detail pages with the return (the Form 8949 statement in the package is a summary only).
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {BY_HAND.map((t) => (
          <li key={t}>{t}</li>
        ))}
        <li>The paid preparer, firm and PTIN boxes stay blank on a return you prepared yourself.</li>
      </ul>
    </section>
  );
}
