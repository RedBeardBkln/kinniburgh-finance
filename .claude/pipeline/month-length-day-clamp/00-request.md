# Request: month-length-day-clamp

Fix `allMonthDays` in `lib/forecast.ts` so a listed day that does not exist in a month (29/30/31 in short months) means the LAST day of that month (clamp) instead of being skipped. A rule such as `[30, 31]` in a short month must not produce duplicate dates. Days like 15 are unaffected.

Why: found by the upcoming-ledger Tester (`.claude/pipeline/upcoming-ledger/03-test-report.md` observation 1) and Reviewer (`04-review.md` required change 3). Eric's `[15, 31]` paycheck loses Nov 30 ($9,000); Toyota (day 30) loses February; same for every monthly bill, monthly/semi-monthly transfer, income source and Budget schedule. The owner approved fixing it.

Asked of the Planner: investigate all callers, decide single-source vs per-caller fix, blast radius, tests pinning old behavior, live-data effect (read-only), test list, risks, and an owner-facing description of what visibly changes.
