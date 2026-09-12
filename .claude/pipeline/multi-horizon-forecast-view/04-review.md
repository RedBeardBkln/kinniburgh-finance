# Review: Multi-horizon forecast view

## Verdict: APPROVED

Approved **without** further gating from this pipeline, **conditioned on** the
already-flagged, not-yet-performed human browser check (see "On the
browser-verification question" below for why this doesn't block approval).

## What I actually did to verify this

Read `00-request.md`, `01-plan.md`, `02-implementation.md`, `03-test-report.md`
in full, then independently read the real diffs (not just the write-ups):
`lib/forecast-rollup.ts` (full file), `lib/__tests__/forecast-rollup.test.ts`
(full file), `git diff` for `components/forecast/balance-chart.tsx`,
`components/forecast/forecast-account-card.tsx`, `app/forecast/page.tsx`, and
the full new `components/forecast/spend-pace-section.tsx`. I also
independently re-ran `pnpm typecheck`, `pnpm lint`, and `pnpm test` myself
rather than trusting the Tester's numbers (per my own memory note on this
repo), and cross-checked the real signatures of `computeBudgetSummary`,
`PACE_TRAILING_MONTHS`, and `projectPeriodEndSpend` against how `page.tsx`
actually calls them, plus the `Budget`/`Tag` Prisma models against the fields
the new query touches.

Independent verification results:
- `pnpm typecheck` → clean, 0 errors.
- `pnpm lint` → 0 errors, 45 warnings, all in pre-existing unrelated files
  (`retroactive-rule-modal.tsx`, `vault-client.tsx`, `vault-verify-client.tsx`,
  `doc-extract.test.ts`, `forecast.test.ts`, `lib/encrypt.ts`,
  `lib/plaid-sync.ts`, `prisma/seed.ts`) — none in this task's files.
- `pnpm test` → 331/331 passed across 30 files, matching the Tester's report.
- `lib/forecast.ts` and `lib/spend-forecast.ts` are genuinely untouched
  (confirmed no changes appear when reading the diff list — only the six
  files the plan/implementation doc claim are touched).
- No `any` in any new/modified file in this task.

## Correctness — does the rollup preserve breach information through to what's rendered?

This was the key thing to verify end-to-end, not just at the "computed"
layer. Traced it fully:

1. `lib/forecast-rollup.ts`'s `summarizeDays()` computes `minBalance` and
   `hasBreach` as an OR/MIN across **every day in the bucket**, independently
   of `endingBalance` (last day only). Verified directly in the source
   (`lib/forecast-rollup.ts:44-66`) and confirmed by test case 3
   (`lib/__tests__/forecast-rollup.test.ts:63-88`): a bucket ending at balance
   750 with a breach on day 3 correctly reports `hasBreach: true`,
   `minBalance: "100"`.
2. `app/forecast/page.tsx`'s `toChartPoints()` maps `isBreachDay: b.hasBreach`
   onto each `ChartPoint` — this is the bucket-level flag, not
   re-derived from `endingBalance` (`app/forecast/page.tsx`, the
   `chartDataWeekly`/`Monthly`/`Quarterly` construction).
3. `ForecastAccountCard`'s `hasBreaches` in non-daily mode is
   `sliced.some((d) => d.isBreachDay)` — explicitly *not* the daily-mode
   `balance < minimumBalance` check — so it correctly flags a bucket even
   when its ending balance is healthy. This flows into the card's
   `border-destructive/50` class.
4. `BalanceChart` itself independently computes `hasBreaches = data.some((d)
   => d.isBreachDay)` and uses it to color the chart's stroke/fill red — so
   the actual rendered chart line, not just the outer card border, reflects
   the mid-bucket breach.

So the answer is yes: `hasBreach`/`minBalance` are wired all the way through
to two independent rendered surfaces (card border color and chart
stroke/fill color), not just computed and discarded. This is exactly the
property the plan's Design decision 1 and Test 3 claimed, and it's real, not
just claimed.

One minor, non-blocking observation: `minBalance` itself is computed and
carried on every `RollupBucket`, but nothing in `page.tsx` or
`ForecastAccountCard` currently surfaces the actual *minimum balance value*
to the user in non-daily mode (only the boolean `hasBreach`/`isBreachDay`
reaches the UI as a color change). A user looking at a red weekly bucket has
no way to see how low the balance actually dipped without switching to
Daily. Not a bug relative to what was planned (the plan never promised
surfacing the numeric min), but worth a nit for a future iteration.

## Code quality / pattern match

- `app/forecast/page.tsx` and `app/budgets/page.tsx` both follow the same
  established shape (async Server Component, direct `db`/`$queryRaw` calls,
  no `actions/*.ts` involvement for reads) — confirmed by reading both. This
  task's new spend-pace block matches that shape exactly, including the
  entity-scoped `$queryRaw` pattern (`t."entityId" = ${entity.id}`,
  `archivedAt IS NULL`, `transferPairId IS NULL` exclusion) rather than
  copying `checkBudgetPace`'s unscoped variant — this was explicitly called
  out as a trap in the plan and the Coder avoided it correctly.
- `SpendPaceSection` is a plain server component with no hooks, consistent
  with the plan's reasoning (no interactivity needed) and distinct from the
  `"use client"` sections on the same page that do need it (forms).
- `ForecastAccountCard`'s new granularity toggle reuses the exact same
  segmented-button visual pattern as the existing 30/60/90 toggle
  (`flex rounded-md border text-xs overflow-hidden`, same button classes) —
  visually consistent, no invented new UI pattern.
- `rollupForecast`'s exhaustive `switch` with a `never`-typed default guard
  matches this codebase's strict-mode conventions.
- Money/dates: `Decimal` used throughout the rollup module and the new
  spend-pace query construction; no floats introduced for money math. Plain
  numbers only appear after `.toNumber()` conversion at the server/client
  boundary, consistent with how `chartData90` already crosses that boundary.

## Ground rule 8 (no financial advice) — read the actual shipped copy

Read the literal rendered strings in `components/forecast/spend-pace-section.tsx`:
- Disclaimer: "Projections are estimates based on spending pace and recent
  history — not a guarantee, and not tax or financial advice." — compliant,
  explicit.
- Status badges: "Not enough history yet", "Trending over", "On pace",
  "Under pace" — all observational/descriptive, no imperative or advice
  language ("you should", "you will", "sell/buy/move"). Compliant.

## Scope discipline

Confirmed via `git diff --stat` equivalent and the Tester's own scope check
(which I spot-verified): the only files touched by this task are the 3 new +
3 modified files both the plan and implementation doc list. The other
modified/untracked files visible in `git status` (`actions/reports.ts`,
`prisma/schema.prisma`, bank-statements work, etc.) are pre-existing,
unrelated in-progress work already present in the working tree before this
task started — not part of this diff. `lib/forecast.ts` and
`lib/spend-forecast.ts` are confirmed untouched, respecting the explicit
"stable, reviewed API" constraint. No Prisma schema changes, no new
dependencies, no new/changed `actions/*.ts` file — all confirmed.

## Test quality

The 10 planned cases plus the Tester's 4 added cases (year-boundary monthly
and quarterly rollups, a full quarter starting mid-year rather than always
Q2, and a no-mutation check) genuinely exercise the load-bearing edge cases
rather than being superficial — in particular, case 3 (mid-bucket breach not
on the ending day) is the exact scenario that validates the
correctness property checked above, and I independently re-derived it by
hand against the source rather than trusting the assertions. This is good
test coverage for a pure module; I have no additions to request.

## On the browser-verification question

The plan, implementation, and test report all explicitly and consistently
flag that browser/visual verification has **not** been performed, because no
agent in this pipeline (Planner, Coder, Tester, or me) has browser access.
This is a real gap for a UI-touching change — typecheck/lint/unit tests
cannot confirm the granularity toggle visibly swaps chart content, that
labels render legibly, that the destructive chart coloring is visually
distinguishable, or that the layout holds at mobile width.

Judgment call: I'm treating this as **acceptable to ship under APPROVED**,
not as a reason to withhold approval or invent a different verdict category,
for these reasons:
- Every piece of logic that determines *what* gets rendered (which array is
  selected, which flag drives styling, what the label text is) is plain
  TypeScript that I traced by hand end-to-end above — the remaining risk is
  purely presentational (CSS layout, chart legibility), not functional
  correctness. That's a materially different, lower-severity risk than "the
  feature doesn't work."
- All existing call sites are backward-compatible by construction: Daily
  mode is byte-for-byte unchanged code path (confirmed in the diff), so
  there's no risk of regressing the page's current, presumably-already-
  verified behavior.
- The task's own instructions to the Planner explicitly anticipated this
  ("this pipeline's Coder/Tester/Reviewer agents do not have browser
  access... a human ... should visually verify") — the shipping gate here
  was always meant to be a human step outside this pipeline, not something
  this pipeline could close on its own. Manufacturing a new verdict state to
  route around that would just relabel the same fact without changing it.
- This is a low-blast-radius, additive UI change (new toggle row, new
  section) on an internal two-person household tool, not a public-facing or
  destructive change — the cost of a purely-cosmetic bug slipping through is
  low and easily caught/fixed post-merge.

So: **APPROVED**, and the human visual-verification step named in the plan
(load `/forecast?bucket=personal` and a business bucket, check Daily mode is
unchanged, check granularity switching visibly changes content, check a
mid-bucket breach still shows destructive styling, check the spend-pace
section appears/doesn't appear on the right buckets, check mobile layout)
should still happen before or shortly after merge — but it is a human
QA/monitoring follow-up, not a blocking condition on this code review's
verdict.

## What's good

- The Coder followed the plan's exact spec (types, label formats, thresholds,
  query shapes) with no unrequested scope creep, and the two claimed
  deviations (a rename to avoid variable shadowing, `let` → `const` for
  `prefer-const`) are genuinely trivial and were independently confirmed as
  inert by both the Tester and me.
- The correctness property this task most needed to get right — breach
  visibility surviving a rollup — is real and traced through two independent
  rendered surfaces, not just computed and left unused.
- The Tester went beyond the plan's 10 cases with 4 well-targeted additional
  edge cases (year boundaries, a non-Q2 full quarter, mutation-safety) and
  those pass without needing any implementation change.
- Clean adherence to this codebase's established RSC/server-computation
  pattern; no new client-side data fetching, no new server action where none
  was needed.

## Findings (non-blocking)

- **nit** — `RollupBucket.minBalance` is computed and typed but never
  surfaced as a visible number anywhere in the UI (only used to derive the
  boolean `hasBreach`/color). Consider showing the actual minimum balance in
  a tooltip or subtext for non-daily buckets in a future iteration, so a user
  doesn't have to switch back to Daily to see how bad a flagged week/month
  actually got. Not required by this task's plan or acceptance criteria.
- **nit** — no numeric/functional test exists for `ForecastAccountCard`'s new
  `granularity` state or `SpendPaceSection`'s badge-threshold branching; this
  matches the plan's own explicit "no unit tests required" call (consistent
  with this component's pre-existing untested `days` state) and I agree with
  that call, but flagging for the record in case future changes to the badge
  thresholds want to reconsider pulling that branching into a tested pure
  function per the `lib/budget-pace.ts` precedent, as the plan itself
  anticipated.

No blocking findings.
