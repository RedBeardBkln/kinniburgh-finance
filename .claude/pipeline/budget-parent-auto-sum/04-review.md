# Review: budget-parent-auto-sum

## Verdict: APPROVED

## Summary

Independently re-verified this end to end rather than trusting the Coder/Tester
write-ups: read all 16 touched files plus the new migration, ran
`pnpm vitest run lib/__tests__/budget-nesting.test.ts` (17/17 pass), `pnpm test`
(598/598 pass, 49 files), `pnpm typecheck` (clean), `pnpm lint` (0 errors, 47
pre-existing/unrelated warnings), `npx next build` (succeeds, 63/63 routes, no
`UnhandledSchemeError`), and `npx prisma migrate status` (confirms
`20260916140000_budget_nullable_budgeted` is genuinely pending against the live
Supabase instance, not applied). `git status`/`git log` confirm nothing has
been committed or pushed. This matches the Test Report's claims exactly — no
discrepancies found.

## Correctness against the request

The owner's request (blank parent auto-sums recursive children; totals never
double-count) is genuinely implemented, not just superficially: bottom-up
recursion in `resolveBudgetedAmounts` (`lib/budget-nesting.ts:102-132`) handles
arbitrary depth (verified via the Coder's 3-level test and the Tester's
composed root-sum test), and all twelve real consumer sites named in the
request/plan were independently re-read by me and correctly distinguish
"sum only roots" (4 sites: `app/budgets/page.tsx`, `budget-page-client.tsx`,
`app/forecast/page.tsx` business-bucket, `app/page.tsx`, `lib/advisor-context.ts`
— that's actually 5, all root-filtered) from "resolve per-line, no filtering"
(the rest: forecast pace section, `lib/notifications.ts` ×2,
`lib/monthly-review-build.ts`, `actions/reports.ts`). I did not find a 13th
missed site.

## Specific focus areas (per the task brief)

- **Webpack client-bundle fix**: confirmed genuine. `lib/budget-nesting.ts:15`
  is `import type { Decimal } from "@prisma/client/runtime/library"` — the only
  `import type` (vs. value import) of that module anywhere in the repo (grepped
  all 32 hits). `resolveBudgetedAmounts` takes `zero: Decimal` as a caller-
  supplied parameter rather than constructing one internally, exactly as
  documented. I ran `npx next build` myself (not just re-reading the Tester's
  transcript) — succeeds cleanly, 63/63 routes, no scheme errors.
- **Precedence rule** (recurring-linked > explicit non-null > auto-sum > $0):
  reasonable to ship as-is, not something requiring pre-emptive owner sign-off.
  Reading the actual diff at `app/budgets/page.tsx:96-114` shows this isn't a
  net-new judgment call invented for this task — the pre-existing code (before
  this diff) *already* let a recurring-linked amount completely override
  `b.budgeted` for any line with recurring expenses, blank or not. This task
  extends that same, already-shipped precedence to also cover the "explicit
  budgeted vs. auto-sum" case, rather than introducing new precedent from
  scratch. It's a sound default; flagging it to the owner is worth a quick
  mention post-ship (per the plan's own Risk note) but is not blocking.
- **Inline quick-editor fix**: independently confirmed in both files (not
  taking the Tester's word). `budget-line-editor.tsx:19,26` and
  `category-drilldown-modal.tsx:63` both seed their editable state from
  `rawBudgeted`/`budgetedRaw`, not the resolved `currentBudgeted`/`budgeted` —
  an unmodified Save round-trips to blank, closing the accidental-override
  trap exactly as claimed.
- **Tester's two added tests**: read both in
  `lib/__tests__/budget-nesting.test.ts`. Both are real, not padding — the
  first proves the composed root+resolve recipe used by every real consumer
  site yields $35 not $65 (the exact double-count failure mode this task
  exists to prevent), the second is a direct, literal encoding of acceptance
  criterion 7 ("total doesn't change whether the parent is blank or explicitly
  set to the same sum"). Ran them myself — pass.
- **No live browser click-through**: accepted as a known gap, consistent with
  this session's established pattern for the two prior migration-gated tasks.
  No pipeline role has browser/DB-write access while the migration-push-gate
  is in effect; verification here is code-trace + typecheck + full test suite
  + a real `next build`, which is the ceiling of what's checkable pre-apply.
  The orchestrator's manual click-through after migration approval remains the
  real closing verification, as the plan itself anticipated.

## Migration safety assessment (factual check only — not an apply decision)

`ALTER TABLE "Budget" ALTER COLUMN "budgeted" DROP NOT NULL;` is a pure,
non-locking (Postgres `DROP NOT NULL` doesn't require a table rewrite),
backward-compatible type relaxation. No existing row has a null `budgeted`
today (nothing in this diff writes null to an existing row — every write path
that could produce `null` requires an explicit user action: leaving the
Add-modal field blank, or clearing it via the inline editor/full edit modal).
I see no reason not to apply this migration once the owner gives the
go-ahead. One thing worth double-checking live post-apply (not a reason to
block): confirm the regenerated Prisma client's native query-engine binary
(flagged by the Tester as dated Sep 11, pre-dating this session) round-trips a
real `null` write correctly — the Tester verified the JS-embedded DMMF schema
is current, but neither of us exercised an actual DB write, which is exactly
what the gate prohibits pre-approval.

## Code quality / scope discipline

- No unrelated changes snuck in — `git diff --stat` shows exactly the 16 files
  named in the plan/implementation doc.
- Consistent with the established `nestBudgetLines` pattern: the new
  `buildBudgetTree` extraction is a clean, behavior-preserving refactor (I
  confirmed `nestBudgetLines`'s own pre-existing 7 tests still pass unchanged).
- The `resolved.get(id) !== undefined` cache-check pitfall (a legitimate
  `Decimal(0)` being a truthy object) is called out in both code comments and
  handled correctly — a good, specific catch that would have been an easy
  silent bug otherwise.
- Cycle guard verified correct by tracing the recursion by hand, not just
  trusting the passing test: a self-referencing line correctly resolves to
  `zero` and gets cached at the outer call, doesn't hang.
- `updateBudget`'s `applyToFuture` path correctly excludes `budgeted` from
  bulk-propagation to future periods (unchanged behavior, not modified by this
  diff) — no ground-rule-1 fabrication risk introduced.

## No `any`, security, auth

- Grepped the diff for new `any` — none (only the English word inside a
  comment, confirmed by the Tester and independently spot-checked by me).
- All three write actions (`updateBudgetLine`, `createBudget`, `updateBudget`)
  still call `requireAuth()` as their first line — unchanged, not weakened.
- No secrets, no new external calls, no auth/authz surface changes.

## What's good

- Genuinely thorough consumer-site coverage — twelve independent call sites,
  each individually correct, is a lot of surface area to get right and it was.
- The Coder caught and fixed a real production-breaking webpack bug during
  self-review rather than shipping it, and documented the deviation clearly.
- The Tester added tests that close a real gap (the original 15 tests
  exercised the two functions in isolation, never composed the way every real
  call site actually uses them) rather than just re-running what existed.
- Migration-push-gate discipline was followed correctly and verifiably at
  every step (hand-written SQL, `db:generate` only, no `migrate dev`/`db push`,
  nothing committed).

## Findings

None blocking. Two should-fix-eventually notes (not blocking this ship):

- **should-fix (low)**: the recurring-override-wins-over-auto-sum precedence
  in `app/budgets/page.tsx` should be confirmed with the owner once he
  encounters a real example (a parent tag with both linked recurring expenses
  and child budget lines) — flagged by the plan, restated here, not something
  that needs to block this round.
- **nit**: the blank-line + `payDay` combination (`upsertBudgetBill` receiving
  a raw `null` rather than a resolved sum) is a narrow, already-documented edge
  case. Unlikely in practice (a `payDay` models one concrete bill, not a
  category aggregate) and doesn't crash — fine to leave as a known boundary.

## Route-back target

N/A — approved, nothing to route back.
