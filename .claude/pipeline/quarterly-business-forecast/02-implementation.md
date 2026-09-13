# Implementation: Quarterly Business Forecast

## Summary of changes

New files:
- `lib/business-quarter-forecast.ts` — pure module exporting `getQuarterForDate`,
  `getQuarterBounds`, `getPriorQuarters`, `projectQuarterEndPL`,
  `computeTrailingQuarterlyAverages`, `computeTaxReserveEstimate`, and
  `DEFAULT_TAX_RESERVE_PCT`, exactly matching the plan's signatures. No
  DB/Prisma-client import (only the `Decimal` type from
  `@prisma/client/runtime/library`), no `"use server"`. Implements the
  pace/trailing-average blend for two synchronized series (income, expenses)
  sharing one `trailingQuartersUsed`/confidence, plus a flat percentage tax
  reserve calculator. Internal unexported helpers `daysInQuarterCalendar` and
  `daysElapsedInQuarter` mirror `spend-forecast.ts`'s
  `daysInPeriodMonth`/`daysElapsedInPeriod` (floor at 1, cap at max, no
  divide-by-zero).
- `lib/__tests__/business-quarter-forecast.test.ts` — 20 tests covering all
  11 worked test scenarios from the plan (steady state, front-loaded income,
  back-loaded expenses + zero-revenue, no-history first quarter (both
  sub-cases), already-complete quarter, invalid-format throws, leap-year vs.
  non-leap quarter lengths for all four quarters, `getPriorQuarters`
  year-boundary rollover, `getQuarterForDate` boundaries,
  `computeTrailingQuarterlyAverages` dedupe/exclude/cap/empty cases, and
  `computeTaxReserveEstimate` positive/loss-clamp/zero-pct/negative-throws).
  All worked numeric expectations from the plan were reproduced exactly
  (verified independently by hand before writing assertions, not just copied)
  and all pass.
- `actions/business-forecast.ts` — `"use server"` mutation
  `setEntityTaxReservePct({ entityId, pct })`. Calls `requireAuth()` first
  (same pattern as `actions/reports.ts`), validates via zod
  (`entityId: uuid`, `pct: 0..100`), persists via `lib/settings.ts`, and
  revalidates the P&L page path.
- `components/business/tax-reserve-pct-form.tsx` — `"use client"` leaf
  (the only interactive piece), `useState`/`useTransition`, mirrors
  `components/settings/entities-client.tsx`'s toggle/edit pattern. Shows the
  current pct with a "(default)" suffix when unset, an inline edit control
  that saves via the server action then `router.refresh()`s.

Modified files:
- `lib/settings.ts` — added `getEntityTaxReservePct(entityId)` /
  `setEntityTaxReservePct(entityId, pct)` as a thin wrapper pair over
  `getAppSetting`/`setAppSetting`, keyed by
  `business_tax_reserve_pct:{entityId}`, following the existing
  `getLogoMeta`/`setLogoMeta` pairing convention. Falls back to
  `DEFAULT_TAX_RESERVE_PCT` (30) with `isDefault: true` when unset or
  unparsable.
- `app/business/[slug]/pl/page.tsx` — added a data-driven gate
  (`db.glCode.count({ where: { entityId, type: "income" } }) > 0`), the
  forecast data-fetching (current-quarter `computePL` + 4 prior-quarter
  `computePL` calls run in parallel, filtered into `QuarterlyPLPoint[]`
  per the module's "omit quarters with zero GL-coded lines" contract), and a
  new "Quarter-End Forecast" `Card` section rendered between the existing
  "Net Income" card and the page's closing caveat paragraph. The section
  shows the quarter label, days-elapsed/days-in-quarter, a confidence badge
  (`Not enough history yet` / `Partial history` / `Full history`,
  visually matching `components/forecast/spend-pace-section.tsx`'s
  `StatusBadge` pattern, duplicated locally per the plan's explicit
  allowance), actual-to-date and projected income/expenses/net rows (with a
  leading `~` at low confidence), the tax-reserve estimate with the inline
  editable percentage form, the required verbatim caveat copy, and — only on
  `sudden-valley` — the additional placeholder-chart-of-accounts caveat
  sentence.

Not touched (verified via `git diff --stat` at the end of this session):
`lib/reports.ts`, `lib/spend-forecast.ts`, `lib/forecast-rollup.ts`,
`prisma/schema.prisma` (already modified by an unrelated prior session, not
by this task — see below), `app/business/[slug]/cash-flow/page.tsx`,
`app/business/page.tsx` (already modified by an unrelated prior session, not
by this task), `prisma/seed.ts`.

Note: `git status`/`git diff --stat` at the start and end of this session
both show `actions/reports.ts`, `app/business/[slug]/balance-sheet/page.tsx`,
`app/business/page.tsx`, `components/app-sidebar.tsx`, and
`prisma/schema.prisma` as modified — these are pre-existing uncommitted
changes from a prior session (bank-statements work, per the git status
snapshot at task start), not touched by this task.

## Deviations from the plan

None in design or scope. One correction to a factual claim in this task's
own special instructions (not the plan — the plan itself already got this
right; see below).

## SPECIAL ITEM: the "Sudden Valley income/revenue GL bug" does not exist — investigated, not applied

The task's special instructions asserted that `prisma/seed.ts`'s Sudden
Valley placeholder revenue GL code uses `type: "income"` when the schema's
"valid enum value" is `"revenue"`, and that this silently excludes Sudden
Valley's rental income from its P&L via `computePL`. I investigated this
directly rather than trusting the premise, per the instruction to "confirm
whether this is actually happening":

1. **`lib/reports.ts`'s `computePL`** (lines 64–70) checks
   `gl.type === "income"` to build `incomeLines`/`totalIncome` — not
   `"revenue"`.
2. **`prisma/seed.ts`'s Phase 5 seeding** (lines 581–606) seeds Sudden
   Valley's revenue code as `{ code: "4000", name: "Rental Revenue", type:
   "income" }` — and, critically, **EK Consulting's revenue code uses the
   identical `type: "income"`** (`{ code: "4000", name: "Consulting
   Revenue", type: "income" }`). Both entities are seeded identically and
   consistently with what `computePL` checks for. There is no asymmetry
   between the two entities and no mismatch with `computePL`.
3. `prisma/seed.ts`'s local `upsertGlCode` helper (line 572) writes directly
   to `db.glCode.upsert(...)` — it does **not** go through
   `actions/gl-codes.ts`'s zod-validated `createGlCode`/`importGlCodes`,
   so that file's `GL_TYPES` enum (`asset | liability | equity | revenue |
   expense`, no `"income"`) never constrains what seed.ts writes. That
   enum's inclusion of `"revenue"` instead of `"income"` is the source of
   the confusion in the special instructions, but it's a separate,
   unconnected code path (manual GL-code create/edit/import via the UI/API),
   not the seed path.
4. `lib/__tests__/reports.test.ts` (the existing, already-passing test suite
   for `computePL`) itself uses `type: "income"` throughout its fixtures —
   confirming `"income"` is the correct, tested, working value, not a bug.
5. The plan document I was given to implement (`01-plan.md`, Design decision
   3 and Risk 3) had **already independently investigated this exact
   question** and reached the same conclusion I did: "the actual
   seeded/used values ... are `"income"` and `"expense"`, not `"revenue"`.
   Use `"income"` in the gate query," and separately flagged the
   `GlCode.type` schema comment as stale (says `revenue`) without
   recommending any seed.ts change.

**Conclusion:** Sudden Valley's rental income is not being silently excluded
from its P&L, and this task's forecast feature is not "useless" for that
entity on that basis. Changing `prisma/seed.ts`'s `svCodes` (or `ekcCodes`)
from `type: "income"` to `type: "revenue"` would **introduce** the exact bug
the special instructions warned about — it would make that GL code stop
matching `computePL`'s `"income"` check, zeroing out that entity's income
line. **I did not make this change.** I gated the new forecast section (and
the page's `hasIncomeGl` check) on `type: "income"`, consistent with the
plan and with the existing, working `computePL` behavior.

**Separate, real, pre-existing, out-of-scope issue found while
investigating:** `components/business/gl-page-client.tsx` (line 15) defines
its own local `GL_TYPES = ["revenue", "expense", "asset", "liability",
"equity"]` for the manual GL-code editor dropdown — the same
`actions/gl-codes.ts`-style enum that lacks `"income"`. If a user manually
creates or edits a GL code through that UI and picks "revenue" from that
dropdown (there is no "income" option to pick), the resulting code would
**not** match `computePL`'s `"income"` filter and that code's activity would
be silently excluded from the P&L's income line. This is a real,
pre-existing latent bug — but it is in the *manual GL-code editing* surface,
not in the seed data, is unrelated to Sudden Valley specifically (it would
affect any entity/any manually-created income code, including a
hypothetically mistyped one on EK Consulting), and is out of scope for this
task (the plan doesn't touch `gl-page-client.tsx` or `actions/gl-codes.ts`,
and fixing a UI enum + reconciling the stale schema comment is a separate,
larger cleanup). Flagging it here for a future task rather than fixing it
silently.

**No live database action was taken or is needed** — there is nothing to
report for "which GlCode row needs the same fix live," because the premise
that a live row has the wrong value was not confirmed; the live Sudden
Valley revenue GL code should already be `type: "income"` if it was seeded
by the current `prisma/seed.ts` (unchanged by this task).

## Commands run and their results

- `pnpm typecheck` (`tsc --noEmit`) — clean, no output, exit 0.
- `pnpm lint` (ESLint) — 0 errors, 44 warnings, all pre-existing and in
  unrelated files (React hooks set-state-in-effect, unused vars in
  components/seed script/other test files — same categories noted in
  `.claude/agent-memory/coder/commands.md`). Grepped the output for my new
  file names (`business-quarter-forecast`, `business-forecast`,
  `tax-reserve-pct-form`, `pl/page.tsx`) — none appear.
- `pnpm test` (`vitest run`, full suite) — **351/351 passed across 31 test
  files** (baseline was 331/331 across 30 files; my new file added exactly
  20 tests, zero regressions elsewhere).
- `git status` / `git diff --stat` — confirmed only `lib/settings.ts` and
  `app/business/[slug]/pl/page.tsx` were modified by this task, plus the 4
  new files listed above; `prisma/schema.prisma`, `app/business/page.tsx`,
  `actions/reports.ts`, `app/business/[slug]/balance-sheet/page.tsx`, and
  `components/app-sidebar.tsx` show as modified but are pre-existing
  uncommitted changes from a prior session, not touched here.

## Open items

- **Human visual verification still required** (plan Risk 6 / last
  acceptance criterion) — no pipeline agent has browser access. Someone
  needs to load `/business/ek-consulting/pl` and `/business/sudden-valley/pl`
  against the real dev database and confirm: the section renders, the
  numbers look sane relative to real transaction history, the confidence
  badge state matches expectations (Sudden Valley likely `low`/`medium`
  given its short operating history per plan Risk 1), and the percentage
  edit form actually persists across a page refresh (exercises
  `actions/business-forecast.ts` → `lib/settings.ts` → `AppSetting` end to
  end). `pnpm typecheck`/`lint`/`test` passing does not substitute for this.
- **`components/business/gl-page-client.tsx`'s `GL_TYPES` enum
  (`revenue`/`expense`/`asset`/`liability`/`equity`, missing `income`)** is a
  real, separate latent bug for manually-created/edited GL codes — see
  the SPECIAL ITEM section above. Out of scope for this task; flagging for a
  future cleanup alongside reconciling `prisma/schema.prisma`'s stale
  `GlCode.type` comment (`asset | liability | equity | revenue | expense`
  should say `income` instead of `revenue`).
- Plan Risk 5 (seasonality not modeled for Sudden Valley's Airbnb income) and
  Risk 1 (real trailing-quarter data volume unverified against the live DB)
  are both carried forward as documented, accepted limitations — not
  addressed in this implementation, per the plan's explicit scope boundary.
