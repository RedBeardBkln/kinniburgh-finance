import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Loading placeholders for the Upcoming widget (dashboard) and the Upcoming agenda + "Looks recurring" cards
// (Forecast). They are the <Suspense> fallbacks while the ledger and the recurring-pattern checks load, so the rest
// of the page can render without waiting. Plain server components: no hooks, no client JS, no data.
//
// Accessibility: the placeholder bars are decorative (aria-hidden); one polite status region with visually hidden
// text tells assistive technology what is loading, and aria-busy marks it as pending. The pulse animation only
// runs for people who have not asked for reduced motion.

function Bars({ rows }: { rows: number }) {
  return (
    <div aria-hidden="true" className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          data-testid="skeleton-bar"
          className={`h-4 rounded bg-muted motion-safe:animate-pulse ${i % 3 === 0 ? "w-full" : i % 3 === 1 ? "w-5/6" : "w-2/3"}`}
        />
      ))}
    </div>
  );
}

function LoadingStatus({ what }: { what: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading {what}</span>
    </div>
  );
}

/** Dashboard "Next N days" card while its ledger loads. */
export function UpcomingWidgetSkeleton({ days = 30 }: { days?: number }) {
  return (
    <Card data-testid="upcoming-skeleton">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Next {days} days</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <LoadingStatus what="upcoming items" />
        <Bars rows={4} />
      </CardContent>
    </Card>
  );
}

/**
 * Forecast page: the Upcoming agenda card and the "Looks recurring" card while they load. The anchors the rest of
 * the app links to (#upcoming, #looks-recurring) exist from the first paint, so those links still land here.
 */
export function UpcomingAgendaSkeleton({ horizon }: { horizon: number }) {
  return (
    <>
      <div id="upcoming" className="scroll-mt-20" data-testid="agenda-skeleton">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Upcoming - next {horizon} days</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <LoadingStatus what="upcoming items" />
            <Bars rows={5} />
          </CardContent>
        </Card>
      </div>
      <div id="looks-recurring" className="scroll-mt-20">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Looks recurring</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <LoadingStatus what="recurring patterns" />
            <Bars rows={3} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
