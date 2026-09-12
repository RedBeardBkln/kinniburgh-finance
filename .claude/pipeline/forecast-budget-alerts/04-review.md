# Review: forecast-budget-alerts

## Verdict: APPROVED

## What I checked

Read `00-request.md`, `01-plan.md`, `02-implementation.md`, `03-test-report.md`
(PASS) in full, then independently:

- Read `lib/budget-pace.ts`, the `git diff` for `lib/notifications.ts` and
  `app/api/cron/notifications/route.ts`, and `lib/__tests__/budget-pace.test.ts`
  line by line (not just the write-ups).
- Read `lib/spend-forecast.ts` to confirm `evaluateBudgetPace`'s usage of
  `projectPeriodEndSpend` matches its actual documented contract (confidence
  derivation, blended-vs-pace_only method, trailing-average exclusion of the
  current period).
- Compared the new `checkBudgetPace` structurally against
  `checkCardPaymentsDue`/`checkCcFundingShortfall` and `lib/card-due.ts` (the
  named precedent) — same shape: pure decision function with no DB/`"use
  server"` imports, thin DB-touching wrapper duplicating query patterns rather
  than sharing helpers, same `getAllUserIds`/`alreadyNotifiedToday`/
  `createNotification` plumbing.
- Re-ran `pnpm typecheck` (clean), `pnpm lint` (0 errors, 45 pre-existing
  warnings, none in touched files), and `pnpm test` (**317/317 passed, 29
  files** — matches the Tester's reported numbers exactly) myself rather than
  trusting the reports.
- Diffed `git status --porcelain -uall` against the session-start snapshot:
  the only files this task touches are `lib/budget-pace.ts` (new),
  `lib/__tests__/budget-pace.test.ts` (new), `lib/notifications.ts`
  (modified — `checkBudgetOverspend` body is byte-for-byte untouched, confirmed
  by reading it directly), and `app/api/cron/notifications/route.ts`
  (modified). Everything else in the dirty tree predates this task. Scope is
  clean.
- Hand-verified the arithmetic in test 1 and test 6 (materiality-margin
  boundary) independently rather than trusting the Coder's/Tester's numbers —
  both check out exactly.

## Correctness of the four-guard composition

Guards in `evaluateBudgetPace`: (1) `effectiveBudget <= 0` → (2) `percentUsed
>= 80` → (3) `confidence === "low"` → (4) `projectedTotal.abs() >
effectiveBudget.abs() * 1.05` (strict `>` required to fire).

- **No redundant same-day double-fire is possible by construction.**
  `checkBudgetPace` and `checkBudgetOverspend` are mutually exclusive on
  `percentUsed`: pace only fires below 80%, overspend only fires at/above 80%.
  Both checks run inside the same `Promise.all` in the cron route reading the
  same underlying `Transaction`/`TransactionTag` rows at essentially the same
  instant, so there's no meaningful window for the two to disagree on which
  side of 80% a tag is on. A household *can* legitimately get a `budget_pace`
  alert on day N and an `overspend` alert on day N+k once real spend later
  crosses 80% — that's two different signals at two different times, which is
  the entire point of the roadmap item, not spam.
- **Guards don't suppress a genuinely useful early warning.** The "low"
  confidence guard only trips when `trailingMonthsUsed === 0` (verified
  against `spend-forecast.ts`'s `confidence` derivation) — i.e., a brand-new
  tag with no baseline at all. Any tag with at least one qualifying prior
  month reaches "medium" and is not suppressed (test 2 explicitly pins this).
  The 5% materiality margin is tight enough not to swallow real signal —
  verified by hand: 2% over doesn't fire, exactly 105% doesn't fire (strict
  `>`), 6% over fires (test 6).
- **Guards don't fire on noise.** Zero/negative-budget tags can't produce a
  meaningful "over budget" concept and are correctly excluded (tests 7/8, no
  NaN/Infinity). The 5% margin absorbs blended-forecast noise near the
  boundary rather than alarming on a $1-over projection.
- `percentUsed` is a plain JS `number` derived from a single `Decimal`
  division in `computeBudgetSummary` (`lib/budget.ts:26-30`) — no repeated
  float arithmetic on it, so the `>= 80` comparison is stable and consistent
  between the two checks. Confirmed no Decimal-vs-float precision bug in the
  new module (per my own standing practice of checking this in
  financial-math-adjacent code) — the only Decimal math in `budget-pace.ts` is
  `.times(1.05)`, which the Coder correctly noted is exact for this `Decimal`
  build (1.05 isn't a repeating binary fraction, unlike the `daysElapsed /
  daysInPeriod` case `spend-forecast.ts` had to guard against with a
  single-final-division rearrangement).

## Ground rule 8 compliance (read the actual shipped copy)

Read the literal template in `lib/notifications.ts`:

> "{tag} is on pace to reach {formatUSD(projectedTotal)} by month end, above
> the {formatUSD(effectiveBudget)} budget — projected from {formatUSD(actualSpend)}
> spent so far plus the last {N} month(s) of history."

Title: `Trending over budget: {tag}`.

- Purely observational — no imperative verbs ("should," "cut back,"
  "consider"), matches the existing `checkBudgetOverspend`/`checkAnomalies`
  copy register.
- "On pace to reach" and "projected from" both explicitly frame this as an
  extrapolation, not a certainty — appropriately hedged given this is a trend
  projection that can be wrong (front/back-loaded spend, as
  `spend-forecast.ts`'s own doc comment warns). This satisfies the request's
  specific concern about communicating projection-vs-certainty.
- The payload does carry `confidence: "medium"|"high"` and `method` for
  anyone inspecting raw notification data, but the human-readable body text
  doesn't verbally distinguish medium vs. high confidence. I don't consider
  this a defect — by construction, only confidence levels that already
  cleared the "low" guard can reach the copy, and the body already states its
  basis ("the last N months of history"), which is a sufficiently honest
  disclosure of the input size. A nit at most, not blocking.

## Code quality vs. established precedent

`lib/budget-pace.ts` matches `lib/card-due.ts`'s shape exactly: pure function,
no DB import, no `"use server"`, exported constants for thresholds, a single
well-documented decision function. `checkBudgetPace` in `lib/notifications.ts`
mirrors `checkBudgetOverspend`'s and `checkCardPaymentsDue`'s structure
(query → map → loop → guard → scopeKey → `alreadyNotifiedToday` →
`createNotification`) with no deviation in style, naming, or error handling
conventions. The `evaluation.projectedOverageAbs!` non-null assertion at the
`createNotification` call site is safe by construction (only reached after
`evaluation.fire` is checked true, and `fire: true` always pairs with a
non-null `projectedOverageAbs` per `budget-pace.ts`'s own return contract) —
not a code smell in this case, just a slightly terse way of expressing an
invariant the type system can't otherwise capture without restructuring the
return type into a discriminated union (which would be a reasonable but
non-required refinement, not worth blocking on).

## Scope discipline

Clean. `checkBudgetOverspend` untouched (confirmed by reading the diff, not
just the line-count claim). `lib/__tests__/notifications.test.ts` untouched.
No Prisma schema changes, no new dependencies, no unrelated files pulled in.

## Test quality

The 10 tests in `lib/__tests__/budget-pace.test.ts` actually exercise the
acceptance criteria, not just happy-path smoke tests: both `>=`/`>` boundaries
(80% used, 105%-of-budget margin) are pinned with exact-boundary assertions,
medium-vs-low confidence is distinguished, zero/negative budget is covered
defensively, and the `trailingMonths` override is verified to actually change
the outcome (not just accepted as a parameter). I independently recomputed
the blended-forecast arithmetic for tests 1 and 6 and it matches the
assertions exactly. This is a real regression net, not a superficial pass.

## Roadmap closure / gaps worth naming now (non-blocking)

1. **No per-user opt-out or configurable threshold for `budget_pace`.** Spec
   05 calls out "thresholds configurable" as a target; this task (correctly,
   per its own explicit scope decision) doesn't add that, matching
   `checkBudgetOverspend`'s pre-existing lack of a per-user opt-out. This is
   an acceptable scope boundary for this task — it doesn't regress anything,
   and bolting on preference plumbing here would have been scope creep — but
   it's a real gap the plan already flagged rather than something I'm
   surfacing for the first time. Worth a future backlog item covering both
   budget notification types together, not just this new one.
2. **New `"budget_pace"` type isn't added to the client-side
   `TYPE_META`/`TYPE_ICONS` maps** in `app/notifications/page.tsx` and
   `components/notifications/notification-bell.tsx`. I checked this myself
   (not just trusting the plan's claim) — it renders via the existing generic
   fallback (`Bell` icon, muted color, raw type string `"budget_pace"` as the
   visible label) rather than a friendly label like "Budget pace" with a
   distinct icon/color. This is **not a regression introduced by this task**:
   `cc_payment_due`, `cc_payment_overdue`, `policy_expiry`, `large_spend`, and
   `cc_funding_shortfall` are all pre-existing notification types that are
   *also* missing from both maps today, so `budget_pace` joining that list is
   consistent with the codebase's actual (imperfect) precedent, not a new
   inconsistency. Flagging so it's a known, named gap rather than something
   discovered later when a household member sees a bare "budget_pace" label
   in the notification list — a good candidate for a small follow-up task
   that fixes all the unmapped types at once, not something to block this PR
   on.
3. **Duplicated `80` threshold literal** between `checkBudgetOverspend`
   (inline) and `PACE_SUPPRESS_AT_PERCENT_USED` in `budget-pace.ts` — already
   explicitly flagged as an accepted risk in the plan, with a code comment in
   `budget-pace.ts` noting it must stay in sync. Acceptable as-is.

None of the above are blocking — they're either pre-existing, already-flagged
deliberate scope boundaries, or genuinely cosmetic. This is a same-tier
observation, not a new defect.

## What's good

- The plan's four design questions were actually resolved with justification
  rather than left as implicit assumptions, and the Coder followed them
  exactly — I found zero deviations between plan and shipped code beyond the
  one documented, correct Decimal-precision note.
- The mutual-exclusion design between `checkBudgetPace` and
  `checkBudgetOverspend` (stand down at `percentUsed >= 80`) is the right call
  and is what makes this an actual early-warning system rather than a
  duplicate alert — this was the single most important correctness property
  to get right and it's correct.
- Notification copy is honest about being a projection, in ground-rule-8
  register, and reuses the existing `formatUSD` helper rather than
  reinventing formatting.
- Test coverage targets the exact boundaries a naive implementation would get
  wrong (`>=` vs `>` in two different places) rather than just asserting
  fire/no-fire in the middle of each range.
- Clean independent verification: typecheck/lint/test all reproduce exactly
  as reported, and the scope/diff claims hold up against the actual `git
  diff`.

## Route-back target

N/A — approved, no route-back needed.
