# Test Report: Multi-horizon forecast view

## Verdict: PASS

(Scoped to everything verifiable via code reading and automated tests. See
"Not tested" — browser/visual verification is explicitly NOT covered by this
verdict, per the plan's own admission that this pipeline has no browser
access.)

## Acceptance criteria checklist

1. **`lib/forecast-rollup.ts` exists, exports `RollupHorizon`, `RollupBucket`,
   `rollupForecast()` exactly per spec; no changes to `lib/forecast.ts` or
   `lib/spend-forecast.ts`.** — PASS. Read the full file; signature, types,
   and behavior (daily passthrough, weekly relative 7-day chunks, monthly/
   quarterly calendar-aligned with `isPartial`, `endingBalance` tracked
   separately from `minBalance`/`hasBreach`/`firstBreachDate`) all match the
   plan. `git diff --stat lib/forecast.ts lib/spend-forecast.ts` and
   `git status` on both files confirm **zero** diff — genuinely untouched.

2. **`lib/__tests__/forecast-rollup.test.ts` exists, all 10 specified cases
   pass.** — PASS. All 10 cases match the plan's exact expected values
   (dates, balances, `isPartial` flags) verbatim — no deviation. I
   independently hand-verified cases 2, 3, 5, and 7 by tracing the actual
   algorithm (`groupConsecutive` grouping key, `summarizeDays`, `daysInMonth`)
   against the plan's worked numbers rather than trusting the test's own
   assertions — the logic is genuinely correct, not coincidentally
   test-passing. Example trace (case 5, monthly across a month boundary):
   7 days `2026-01-28..02-03` → group key `year-month0` splits into
   `2026-0` (Jan 28-31, 4 days) and `2026-1` (Feb 1-3, 3 days); both flagged
   `isPartial` (`periodStart.getUTCDate() !== 1` for bucket 0,
   `periodEnd.getUTCDate() !== 28` for bucket 1, since Feb 2026 has 28 days)
   — matches plan exactly.

3. **`/forecast` (Personal bucket) shows a working Daily/Weekly/Monthly/
   Quarterly granularity toggle per TD account, additive to 30/60/90; Daily
   mode behaviorally identical to pre-change.** — PARTIAL PASS (code-level
   only). `git diff components/forecast/forecast-account-card.tsx` confirms:
   when `granularity === "daily"`, `sliced = chartData90.slice(0, days)` and
   `hasBreaches = minimumBalance !== null && sliced.some(d => d.balance <
   minimumBalance)` are byte-for-byte unchanged from the pre-task code, and
   the 30/60/90 row still renders only in daily mode as before. The second
   toggle row, `subtitleOverride` wiring, and prop threading in
   `app/forecast/page.tsx` all match the plan's exact spec. **Actual
   rendered/interactive behavior in a browser was NOT verified** (no browser
   access) — see "Not tested."

4. **A breach not on a bucket's final day is still visually flagged in
   non-daily granularities.** — PASS (logic-level). `hasBreaches` in
   non-daily mode is derived from `sliced.some(d => d.isBreachDay)` (the
   rollup's `hasBreach`, which is OR'd across every day in the bucket — see
   `summarizeDays`), not from `endingBalance < minimumBalance`. Confirmed via
   `lib/forecast-rollup.ts` and test case 3 (mid-week breach on day 3 of a
   7-day bucket ending on day 7 at a healthy balance still produces
   `hasBreach: true`). The resulting card border style
   (`hasBreaches ? "border-destructive/50" : ""`) is unchanged code and reads
   `hasBreaches` correctly for both modes. Visual confirmation not possible
   without a browser.

5. **`/forecast?bucket=personal` shows "Category Spend Pace" listing every
   Personal-entity tag with a current-period budget > 0**, spent-to-date /
   budget / projected total / status badge per exact thresholds, plus the
   disclaimer. — PASS. `app/forecast/page.tsx`'s loop iterates
   `paceBudgets` (all `Budget` rows for `entity.id` + current `period`, not
   filtered further by whether they have spend) and only `continue`s when
   `summary.effectiveBudget.lessThanOrEqualTo(0)` — exactly the plan's
   "every tag with an active Budget row ... and effectiveBudget > 0" spec,
   and critically it calls `projectPeriodEndSpend` **directly**, not
   `evaluateBudgetPace`. I read `lib/budget-pace.ts` in full and confirmed
   `evaluateBudgetPace` applies three additional suppression rules
   (`PACE_SUPPRESS_AT_PERCENT_USED >= 80`, `confidence === "low"`, and a 5%
   materiality margin) that the page's inline logic does **not** replicate —
   so it shows every qualifying tag as the plan requires, not just
   notification-worthy ones. `components/forecast/spend-pace-section.tsx`'s
   badge logic (low-confidence → "Not enough history yet" + `~` prefix;
   ≥100% → "Trending over"; ≥80% → "On pace"; else → "Under pace"), table
   columns, and disclaimer text all match the plan's exact copy.

6. **Section does not render on business buckets.** — PASS (code-level).
   `paceRows` is only populated inside `if (entity?.slug === "personal")`;
   the component is only rendered when `entity?.slug === "personal" &&
   paceRows.length > 0`. For any other bucket, `paceRows` stays `[]` and the
   component isn't rendered at all. Not independently verified in a running
   app (no browser/DB access to load a business bucket page).

7. **No advice/certainty copy anywhere new.** — PASS. Grepped
   `spend-pace-section.tsx` for advice-adjacent language; the only match is
   the required disclaimer itself ("...not a guarantee, and not tax or
   financial advice"), which is the compliance line ground rule 8 calls for,
   not a violation. Status badges ("Trending over", "On pace", "Under pace",
   "Not enough history yet") are observational, not prescriptive.

8. **`pnpm typecheck`, `pnpm lint`, `pnpm test` all pass, zero regressions,
   total ≥ 317 + 10.** — PASS, independently run (see "Tests run" below).
   `pnpm typecheck` clean. `pnpm lint`: 0 errors, 45 warnings, and I grepped
   the lint output specifically for the task's files
   (`forecast-rollup|forecast/page|balance-chart|forecast-account-card|
   spend-pace-section`) — zero matches, confirming all 45 warnings are
   pre-existing and unrelated. `pnpm test`: 327/327 passed across 30 files
   before my additions (matches the Coder's reported figure exactly, and I
   ran it myself rather than trusting the claim); 331/331 after I added 4
   more edge-case tests to `forecast-rollup.test.ts` (see "Tests added").

9. **No Prisma schema changes, no new dependencies, no `actions/*.ts`
   changes, no new server action.** — PASS for this task's scope.
   `prisma/schema.prisma` does show a diff in `git status`, but
   `git diff prisma/schema.prisma` shows it's an unrelated, pre-existing
   change (adds a field to `model Entity`, part of other in-progress work in
   this multi-task working tree — matches the session-start git snapshot
   exactly, i.e. it predates and is untouched by this task). No new
   `package.json` dependency; grepped and confirmed no `actions/*.ts` file
   was touched by this task (the modified `actions/reports.ts` and new
   `actions/bank-statements.ts` in the tree are likewise pre-existing/
   unrelated other-task changes, not part of this diff).

10. **Human visual verification performed before done.** — NOT DONE, and
    correctly flagged as not done by the Coder. This is expected: neither
    the Coder nor I (Tester) have browser access. This criterion is
    explicitly called out below under "Not tested" and must be completed by
    a human before this feature is considered fully shippable — it does not
    block my PASS verdict on the code/test-level work, per the plan's own
    framing of it as a separate, hard-required manual step.

## Tests run

```
pnpm typecheck                        → clean, no output/errors
pnpm lint                             → 0 errors, 45 warnings (all pre-existing,
                                         none in this task's files — verified by grep)
pnpm test  (before my additions)      → Test Files 30 passed (30); Tests 327 passed (327)
pnpm vitest run lib/__tests__/forecast-rollup.test.ts (after additions) → 14 passed (14)
pnpm test  (after my additions)       → Test Files 30 passed (30); Tests 331 passed (331)
```

Full `pnpm test` output (excerpt, after my test additions):
```
 ✓ lib/__tests__/forecast-rollup.test.ts (14 tests) 8ms
 ...
 Test Files  30 passed (30)
      Tests  331 passed (331)
```

## Tests added

Added 4 cases to `lib/__tests__/forecast-rollup.test.ts` (renumbered 11-14),
targeting gaps the plan's own 10 cases didn't cover:

- **#11 — monthly rollup across a year boundary (Dec 30 → Jan 2).** The
  plan's case 5 only tests a month boundary within the same year; a
  `year-month0` grouping key bug (e.g. off-by-one on year rollover) wouldn't
  have been caught otherwise. Passed — confirms `groupConsecutive`'s
  `${year}-${month0}` key correctly distinguishes Dec 2026 from Jan 2027.
- **#12 — quarterly rollup across a year boundary (Q4 2026 → Q1 2027).**
  Same rationale as #11 but for the quarter key
  (`${year}-${Math.floor(month/3)}`). Passed.
- **#13 — quarterly rollup, exact full quarter starting mid-year (Q3:
  Jul/Aug/Sep, 92 days).** The plan's case 8 only exercises Q2 (Apr-Jun, 91
  days); a hardcoded "91" or an off-by-one in `daysInMonth` for a
  different quarter's month set could have slipped through. Passed.
- **#14 — `rollupForecast` does not mutate its input array.** Verifies the
  function is a pure read-only transform (snapshots the input, calls
  `rollupForecast`, asserts the input is unchanged) — matters because the
  same `forecast` array is reused three times in `page.tsx`
  (`rollupForecast(forecast, "weekly")`, `"monthly"`, `"quarterly"`) and a
  mutation bug in one call would silently corrupt the next. Passed.

All 4 new tests pass against the existing implementation with no code
changes needed — no defects found by this additional coverage.

## Defects found

None. No implementation bugs found in `lib/forecast-rollup.ts`,
`app/forecast/page.tsx`, `components/forecast/forecast-account-card.tsx`,
`components/forecast/balance-chart.tsx`, or
`components/forecast/spend-pace-section.tsx`.

## Deviation review (the two "trivial deviations" claimed by the Coder)

Read the actual diff for both, not just the claim:

1. **`forecast` → `spendForecast` rename** in the per-tag loop in
   `app/forecast/page.tsx` (line ~349, `const spendForecast =
   projectPeriodEndSpend({...})`). Confirmed this is purely a rename to
   avoid shadowing the outer-scope `forecast` (the `DayForecast[]` computed
   per account earlier in the same file, still in scope via closure in the
   `.map()` — actually by the time this code runs, `forecast` refers to
   nothing in the pace loop's own scope since it's inside a separate
   top-level `if` block, but the rename is still a reasonable readability
   choice and genuinely changes nothing else — same object shape passed to
   `paceRows.push()`, same fields read off it (`.projectedTotal`,
   `.confidence`, `.method`, `.trailingMonthsUsed`). No behavior change.
2. **`const paceRows` instead of `let`** — confirmed `paceRows` is declared
   once and only ever mutated via `.push()` and `.sort()` (which mutates
   in place and returns the same reference), never reassigned with `=`.
   `prefer-const` correctly flags `let` here; switching to `const` is
   behaviorally inert. Confirmed by reading the full block in
   `app/forecast/page.tsx`.

Both deviations are genuinely trivial as claimed.

## Scope check

`git status` at the end of this session matches the session-start snapshot
exactly (same modified/untracked file list) — confirming no file outside
this task's own diff was touched during Coder or Tester work. The extra
modified/untracked files visible in `git status` (`actions/reports.ts`,
`app/business/[slug]/balance-sheet/page.tsx`, `app/business/page.tsx`,
`components/app-sidebar.tsx`, `prisma/schema.prisma`,
`actions/bank-statements.ts`, `lib/bank-statement-extract.ts`,
`lib/period-balance-sheet.ts`, etc.) are pre-existing, unrelated
in-progress work already present in this multi-task working tree before
this task began — not part of this task's diff. This task's own diff is
exactly the 3 modified + 3 new files the plan and implementation doc both
list: `lib/forecast-rollup.ts`, `lib/__tests__/forecast-rollup.test.ts`,
`components/forecast/spend-pace-section.tsx` (new); `app/forecast/page.tsx`,
`components/forecast/forecast-account-card.tsx`,
`components/forecast/balance-chart.tsx` (modified).

## Not tested

- **All browser/visual/interaction verification** (plan's Approach step 8
  and acceptance criterion 10): does the granularity toggle actually swap
  rendered chart content client-side; do the weekly/monthly/quarterly labels
  render legibly; does a mid-bucket breach actually show destructive border
  styling in the rendered DOM; does the Category Spend Pace section render
  with real numbers against seeded data; does layout hold at mobile width.
  Neither the Coder nor I have browser access in this pipeline. This is
  explicitly flagged by both the plan and the implementation doc as a
  required manual/human step that has **not yet been performed** — it must
  happen before this feature ships, independent of this PASS verdict, which
  covers only what's checkable via static code reading and automated tests.
- **Live DB query correctness** (the two `$queryRaw` calls added to
  `app/forecast/page.tsx` for tag spend / trailing history) — no test file
  exists for this page's inline DB logic (consistent with the plan's own
  "no unit tests required" call for this, matching `app/budgets/page.tsx`'s
  precedent of also having no test file for equivalent inline queries), and
  I have no DB/seed access in this environment to exercise them against real
  data. I did verify the SQL shape (entity-scoped via
  `t."entityId" = ${entity.id}`, `archivedAt IS NULL`, `transferPairId IS
  NULL` exclusion) matches the plan's Design decision 4 spec and the
  `app/budgets/page.tsx` precedent by reading both side by side.
- **`ForecastAccountCard`'s new `granularity` `useState` and toggle
  behavior** — no test file exists for this client component (before or
  after this task), consistent with the plan's own "no unit tests required"
  call and this component's pre-existing untested `days` state.
