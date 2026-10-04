import { HONESTY_CAN, HONESTY_CANNOT, HONESTY_INTRO, HONESTY_TITLE } from "@/lib/tax-review/honesty";

// "What this review can and cannot do" (specs/11, plan 5.12). A server component that renders the words in lib/tax-review/honesty.ts.
// The Final review page puts it DIRECTLY ABOVE the approval card, so it is on screen when the owner approves.

export function HonestyPanel() {
  return (
    <section aria-labelledby="honesty-heading" className="space-y-3 rounded-lg border border-slate-300 bg-slate-50 p-4" data-testid="review-honesty">
      <h2 id="honesty-heading" className="text-base font-semibold">
        {HONESTY_TITLE}
      </h2>
      <p className="text-sm">{HONESTY_INTRO}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold">What it does</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {HONESTY_CAN.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-semibold">What it cannot do</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {HONESTY_CANNOT.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
