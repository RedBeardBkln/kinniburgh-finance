# Review: Spend run-rate forecast (trend-based projection)

## Verdict: APPROVED

---

## What was checked

Read, in order: `00-request.md`, `01-plan.md`, `02-implementation.md`,
`03-test-report.md`, then independently read `lib/spend-forecast.ts` and
`lib/__tests__/spend-forecast.test.ts` in full (not just the summaries), and
independently re-ran `pnpm typecheck`, `pnpm lint`, `pnpm test`, and
`pnpm vitest run lib/__tests__/spend-forecast.test.ts`. Also read
`lib/forecast.ts` (for convention comparison) and `lib/notifications.ts`
(`checkBudgetOverspend`, lines 1–140) to assess whether a future
notification-wiring caller could actually consume this module's public API
without redesign, and confirmed `git status --porcelain -uall` shows the diff
is scoped to exactly `lib/spend-forecast.ts` and
`lib/__tests__/spend-forecast.test.ts` (plus pipeline docs) — every other
modified/untracked file was already present in the working tree before this
task started, per the session's git snapshot.

Results:
- `pnpm typecheck` — clean, zero errors.
- `pnpm lint` — zero output matching "spend-forecast" in the lint report (no
  errors/warnings on either new file).
- `pnpm test` — 28 files passed, 307 tests passed, 0 failures.
- `pnpm vitest run lib/__tests__/spend-forecast.test.ts` — 18 tests passed.

All figures independently reproduced, not taken on the Tester's word.

## Correctness against ground rule 8 (observational, not advice, not a guarantee)

Satisfied, and not just claimed. The required comment block sits directly
above `projectPeriodEndSpend` (not off in a README where it could drift from
the code) and explicitly states the output must be surfaced as "on pace for
~$X," never "you will spend $X." The type name (`SpendForecast`,
`projectedTotal`) and the `confidence: "low" | "medium" | "high"` field are
themselves part of the honesty mechanism here — a future caller wiring this
into a notification has a structured signal to hedge language on
(`confidence: "low"` for a brand-new tag with one data point, matching Test
4's "-45 → -270" case, which correctly still returns a number but is clearly
flagged low-trust rather than the function refusing to project or silently
returning null). This is the right way to satisfy "never a guarantee" — as a
type-level signal a caller can branch on, not just a prose warning nobody
reads.

The known back-loaded-spend weakness (bill due day 28, under-projected until
late in the period) is disclosed in the comment as an accepted limitation,
not silently smoothed away or hidden. That's the correct call for financial
guidance code — a caller/user surprised by this later has a paper trail
showing it was a known, documented tradeoff.

## Code quality vs. this codebase's actual conventions

Matches `lib/forecast.ts`'s shape closely, which is the right bar (not
generic idiomatic TypeScript, the codebase's own idiom):
- Same `// ── Section ─────` comment-banner style.
- Same pattern of small unexported date helpers using `getUTC*` only (no
  local-time calls) ahead of the exported logic, mirroring `startOfDayUTC`
  in `forecast.ts`.
- Same `Decimal` import path (`@prisma/client/runtime/library`), same
  "signed, negative = outflow" convention stated inline on every money field
  — consistent with `ScheduleEvent.amount`'s comment in `forecast.ts` and
  the household convention in `CLAUDE.md`.
- No `any`, no floats touching money. Confirmed by reading the full file —
  the only plain-`number` arithmetic is on `daysElapsed`/`daysInPeriod`
  (day counts, not currency), and the one place a JS float previously
  touched a Decimal computation (the plan's `paceWeight` intermediate) is
  exactly what the Coder's deviation removed.

## The arithmetic deviation (Decimal-precision fix)

Independently re-checked, not just trusted from the write-ups. I confirmed
by reading the code directly that:
- The returned `paceProjection` field is the same Decimal value used
  internally in the blend (the code doesn't compute it twice with a
  different formula) — so there's no inconsistency between what's exposed
  to the caller and what's used internally.
- The reordered form (`paceProjection.times(daysElapsed).plus(trailingAverage.times(daysRemaining)).div(daysInPeriod)`)
  is algebraically equivalent to the plan's literal weighted-average form,
  deferring the single lossy division to the end instead of materializing
  a JS `number` ratio partway through a Decimal computation. This is exactly
  the class of fix a Coder should be trusted to make unilaterally: it's not
  a design decision (no signature, output shape, or method/confidence
  semantics changed), it's a numerical-stability correction needed because
  the plan's own literal arithmetic and the plan's own exact-match test
  assertion were mutually inconsistent. Well-scoped, well-documented at the
  call site with a pointer back to the implementation write-up.

## Completeness against the plan's scope

Nothing more, nothing less, verified directly rather than assumed:
- `git status --porcelain -uall` diff for this task is exactly the two new
  files (plus the pipeline docs, which aren't code). `lib/notifications.ts`
  is untouched — confirmed both by `git status` and by reading it directly;
  no `checkSpendTrend`-style function or any reference to
  `spend-forecast` exists there. No `prisma/schema.prisma` changes
  attributable to this task (that file shows as modified in `git status`,
  but that's pre-existing unrelated work per the session's starting
  snapshot, not something this task touched — `git diff` on it shows no
  spend-forecast-related content).
- No new dependency added; `Decimal` reuses the existing
  `@prisma/client/runtime/library` import path used throughout `budget.ts`
  and `forecast.ts`.
- All 6 exports named in the plan (`MonthlySpendPoint`, `ForecastMethod`,
  `ForecastConfidence`, `SpendForecast`, `computeTrailingAverage`,
  `projectPeriodEndSpend`) are present with matching field names/types.

## Test quality

Read the full test file, not just the pass count. The tests exercise real
edge cases, not superficial happy-path checks: front-loaded vs. back-loaded
spend (opposite failure modes of the day-count pace signal), the
period-already-complete degenerate case (`projectedTotal === spendToDate`
exactly), invalid-period rejection, leap/non-leap February boundary, and
`computeTrailingAverage`'s dedup/cap/exclude-current-period logic tested
directly as its own `describe` block. The Tester's 3 added cases
(`medium` confidence, `trailingMonths` threading end-to-end through
`projectPeriodEndSpend` rather than only unit-testing the helper directly,
and `trailingMonths: 0` explicitly disabling the baseline) closed real gaps
the plan's own list left unexercised — `medium` confidence in particular
would otherwise have shipped with zero test coverage on one of three
possible values of a field a future caller will branch UI/notification
language on. Good catch, correctly scoped as test-only (no implementation
changed to make them pass, confirmed by reading the diff).

## API usability for the Tier 2 notification-wiring follow-up

Checked this concretely against `checkBudgetOverspend` in
`lib/notifications.ts` rather than assuming abstractly. That function
already runs a `GROUP BY tt."tagId"` raw query over a single month that
naturally omits tags with no transactions — exactly the "omit $0/no-data
periods, don't pass a zero entry" contract this module's `history` parameter
requires. A Tier 2 caller can run that same query shape once per trailing
month and assemble `MonthlySpendPoint[]` without needing any redesign of
either module. `period` as a plain `"YYYY-MM"` string matches
`Budget.period` and `checkBudgetOverspend`'s own `period` parameter
convention, so no format-translation layer is needed. The `confidence` field
directly answers the kind of "should I even say anything" gating a
notification check will want. No changes needed here — the signature is
usable as-is.

One minor forward-looking note (not a blocker, not asking for a change now):
the plan's Risk #1 flags that this module takes no budget parameter, so
"over budget" comparison is deferred entirely to the wiring task. That's the
right scope call for this task, but the wiring task will need to fetch the
budget separately and compare `projectedTotal.abs()` against
`summary.effectiveBudget` itself — worth the Planner keeping in mind for
that follow-up, not a gap in this task.

## What's good

- The assumptions/limitations comment is genuinely useful, not boilerplate —
  it explains *why* back-loaded spend is under-projected in terms a future
  reader can act on (wait for more of the period to elapse, or don't trust
  `low`/early-period `blended` confidence numbers for spend-concentrated
  tags).
- The Coder flagged their own deviation prominently in both the
  implementation write-up and an inline code comment rather than burying it,
  and the Tester didn't just take that claim at face value — both
  independently reproduced the float-precision failure and the fix,
  including an independent algebraic derivation. That's the right amount of
  rigor for money-adjacent code.
- Scope discipline was excellent — this is a genuinely hard thing to get
  right when the working tree already has five other unrelated modified/
  untracked files sitting around from prior work; the diff for this task is
  clean and does not touch any of them.

## Findings

None blocking. None should-fix. One nit:

- **Nit** — `lib/spend-forecast.ts:26`: the inline comment on
  `paceProjection` ("naive linear extrapolation: spendToDate * daysInPeriod
  / daysElapsed") is accurate but could note in one clause that this field
  is the *pre-blend* raw signal exposed for caller transparency/debugging,
  not the number to surface to a user — right now a future reader has to
  infer that from context (the field name plus `projectedTotal` existing
  separately) rather than being told directly. Not worth a round-trip for;
  raise only if this file is touched again for the Tier 2 task.

No route-back needed.
