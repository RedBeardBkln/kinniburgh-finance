# Test Report: accrual-draw-dates

## Verdict: PASS

## Acceptance criteria checklist

1. **`pnpm db:generate` succeeds; `pnpm typecheck`/`pnpm lint` pass with zero new errors.**
   PASS. `pnpm typecheck` → clean (0 errors). `pnpm lint` → 0 errors, 47 warnings, all pre-existing/unrelated to touched files (verified: none of the 47 warnings are in `actions/envelope.ts`, `app/forecast/page.tsx`, `app/envelope/page.tsx`, `lib/forecast.ts`, `components/envelope/accrual-draws-list.tsx`, or `prisma/schema.prisma`; the two `prisma/seed.ts` warnings are pre-existing lines 146/176, unrelated to this task's edits at ~364-522). `db:generate`'s binary-rename step does EPERM on Windows (known DLL-lock issue, see tester memory `windows-prisma-generate-dll-lock`) but I independently confirmed the actual `.d.ts` type output was regenerated correctly: `node_modules/.pnpm/@prisma+client@6.19.3_.../node_modules/.prisma/client/index.d.ts` has 512 matches for `AccrualDraw` and a `scheduledBillId` field, with a fresh timestamp (14:16 today) — the native `.dll.node` file itself is stale (Sep 11) but that only affects DB connectivity, not `tsc`/`vitest`, both of which ran clean against the correct types.

2. **New migration file exists, hand-written, matching existing style.**
   PASS. `prisma/migrations/20260916120000_accrual_draws/migration.sql` read in full — plain SQL, no Prisma-generated header, matches existing migration style. `git log` confirms nothing was applied/committed.

3. **`AccrualDraw` model + nullable/unique `AccrualEnvelope.scheduledBillId`.**
   PASS. `git diff prisma/schema.prisma` confirms the schema change exactly matches the migration SQL: `AccrualDraw` table with `accrualEnvelopeId`, `estimatedDate` (`TIMESTAMP(3)`), `estimatedAmount` (`DECIMAL(14,2)`), optional `notes`, `createdAt`/`updatedAt`; `AccrualEnvelope.scheduledBillId` is a nullable `TEXT` column with a `CREATE UNIQUE INDEX` and FK — no drift between the Prisma model and the raw SQL, so a future `prisma migrate deploy` will not diverge from the schema.

4. **Envelopes page: draws list + add-form per card; add/edit/delete persist and are `requireAuth()`-gated.**
   PARTIAL PASS — verified everything checkable outside a live browser. `requireAuth()` is the first statement in `createAccrualDraw`, `updateAccrualDraw`, and `deleteAccrualDraw` (confirmed via `git diff actions/envelope.ts`). `create`/`update`/`delete` all call `db.accrualDraw.*` correctly, with `update`/`delete` doing a `findUnique`-then-404-throw before mutating. The new component `components/envelope/accrual-draws-list.tsx` is wired into `app/envelope/page.tsx` inside each Accrual Envelope card, passed correctly-serialized props (`estimatedDateIso`, `estimatedAmount` as string, no raw `Decimal`/`Date` crossing the RSC boundary). Empty-state copy matches the plan verbatim. `npx next build` compiled `/envelope` cleanly. I could not click through the live UI (no browser tool available in this role, consistent with this repo's established `no-browser-tool-for-manual-verification` constraint) — flagging under "Not tested" below rather than asserting PASS on the literal click-through.

5. **Forecast page (90-day and 14-day) shows real draw-date events, no duplicate flat-spread event, when a linked envelope has in-window draws.**
   PASS (logic-level, via unit tests + hand-trace). `lib/forecast.ts#generateBillOccurrences`'s draws branch returns early (`return events...` inside the `if`), so the flat-spread code below is structurally unreachable when draws are present — confirmed by the new test `"accrued bill with draws inside [from, to): emits exactly the draw dates/amounts, no flat-spread events"` which explicitly asserts `dates` does NOT contain the 1st-of-month flat-spread dates. `app/forecast/page.tsx`'s `billDraws()` helper is correctly wired into both call sites (line 382 for 90-day, line 474 for 14-day) — confirmed via `git diff`.

6. **Accrued bills with zero draws / no linked envelope are byte-identical to pre-change behavior.**
   PASS. `git diff lib/forecast.ts` shows the flat-spread fallback body is untouched — the only change is a new early-return branch prepended above it; no line inside the existing fallback logic was altered. New test `"accrued bill, no draws arg: falls back to flat annualBudget/12 spread..."` and `"...empty draws array: falls back to flat spread"` both pass. Live-data check (below) confirms Sudden Valley's two accrued bills ("Property taxes — 56 Arbor Rd" and "McCarthy Oil (Arbor Retreat)") are unaffected — the migration only backfills 3 envelope rows, none of which touch those two `ScheduledBill` rows differently than described.

7. **`/envelope`'s own 30-day solvency forecast reflects draw-aware logic (3rd call site).**
   PASS. `actions/envelope.ts#getEnvelopeForecastData`'s `scheduledBills` include was updated with `accrualEnvelope: { include: { draws: true } }`, and its `generateBillOccurrences` call now maps and passes those draws as the 4th argument (confirmed via `git diff actions/envelope.ts`, lines ~463-499). All 3 real call sites in the whole repo were grepped and confirmed updated — no call site was missed.

8. **`pnpm test` passes, including new `generateBillOccurrences` tests covering both branches + edge cases.**
   PASS. Ran `pnpm test` myself: **581/581 passed across 48 files** (matches Coder's claim exactly). Read the actual 8 new test cases in `lib/__tests__/forecast.test.ts` (lines 226-316), not just the pass count — confirmed they exercise real edge cases, not just happy path: static/fluctuating baseline (previously-untested), accrued+no-draws-arg fallback, accrued+empty-array fallback, draws-in-window (with explicit "no flat-spread also appears" assertion), draws-partially-outside-window (3 draws, only 1 in-window emitted), non-accrued bill ignoring a stray `draws` arg, zero-amount draw skipped, negative-amount draw skipped. All match the plan's required matrix.

9. **No `any` types; all new server actions start with `requireAuth()`.**
   PASS. `pnpm typecheck` clean (strict mode enforces no implicit `any`; no explicit `any` found in the diff by inspection). All three new actions confirmed `requireAuth()`-first.

10. **3 live `AccrualEnvelope` rows correctly backfilled, verified by a read-only query post-migration.**
    NOT YET APPLICABLE — correctly still open per the plan/implementation's own framing. The migration is confirmed NOT applied to the live DB (`pnpm prisma migrate status` reports `20260916120000_accrual_draws` as "have not yet been applied"; a direct Prisma query against `AccrualEnvelope.scheduledBillId` fails with Prisma error `P2022: column does not exist`, proving no drift/partial-apply). I independently re-ran the Coder's live read-only match-table check myself (raw SQL via a temporary in-tree script, deleted after) and got **3-for-3 identical results** to the plan/implementation's claimed table, exact IDs matching: McCarthy Oil envelope `9d45453c-...` ↔ bill `fc74d807-...` (both on account `8055f111-...`/"Heating & Electric"); Firewood envelope `7a14af85-...` ↔ bill `0b5a1037-...` (same account); Property-taxes envelope `c7932b29-...` ↔ bill `6ebb6469-...` (both on account `2bcaccc1-...`/"JCSB operating"). Sudden Valley's "McCarthy Oil (Arbor Retreat)" bill (`06658b38-...`, same JCSB operating account) has no matching envelope name and is correctly left unlinked by the migration's WHERE clauses (which match on exact `name`/`payee` string pairs, not a wildcard). The actual post-migration backfill can only be verified after the orchestrator approves the push — correctly flagged as an open item by the Coder, not something either of us can close today.

## Tests run

- `pnpm typecheck` → clean, 0 errors.
- `pnpm test` → **581 passed (581)**, 48 test files, 2.25s. Full output captured; no failures/skips.
- `pnpm lint` → 0 errors, 47 warnings (all pre-existing, none in touched files).
- `pnpm prisma migrate status` → confirms `20260916120000_accrual_draws` listed under "have not yet been applied" — 34 migrations found total, only the new one pending.
- `npx next build` → exit code 0, all ~90 routes compiled including `/envelope` (7.54 kB) and `/forecast` (5.44 kB), no build errors (only pre-existing unrelated `setState-in-effect` warnings in files this task didn't touch, e.g. `transfer-history-panel.tsx`).
- Independent live-data verification: temporary read-only `npx tsx` script (raw SQL via `$queryRawUnsafe`, no writes) against the shared Supabase DB, querying `AccrualEnvelope` and accrued `ScheduledBill` rows directly by their pre-migration columns. Confirmed the 3-way match table 3-for-3 with exact IDs, and confirmed the one intentionally-unmatched bill really has no candidate envelope. Script deleted immediately after (not committed) — `git status scripts/` shows clean.
- Also attempted `db.accrualEnvelope.findMany()` via the generated Prisma client directly (not raw SQL) — this failed with `P2022: The column AccrualEnvelope.scheduledBillId does not exist in the current database`, which is itself useful confirmatory evidence that the migration truly has not been applied (the generated client already expects the new column, but the live DB doesn't have it yet).

## Tests added

None — the existing 8 tests the Coder added in `lib/__tests__/forecast.test.ts` already cover the full required matrix (flat-spread baseline, both fallback branches, in-window draws, partially-out-of-window draws, non-accrued-bill-ignores-draws, zero-amount-skipped, negative-amount-skipped). I reviewed them line-by-line rather than trusting the pass count and found no gap worth adding a test for. One boundary case not explicitly tested — a draw exactly at the `to` (exclusive) boundary — but the code (`date >= to` → skip) is a one-line, unambiguous reuse of the same exclusive-upper-bound convention already used and tested elsewhere in this file (e.g. `allMonthDays`/`allWeekdays`), so I judged it low-value to add given time budget; noting it here rather than silently skipping.

## Defects found

None.

## Not tested

- **Live browser click-through of the new UI** (add/edit/delete a draw persisting and reappearing; `/forecast` and `/envelope` visually showing the draw-date event instead of a flat spread once draws exist). No browser-control tool or credentials available in this role, consistent with this repo's established constraint (same as the Coder's own limitation). Verified everything statically reachable instead: `requireAuth()` gating, correct Prisma calls, correct prop serialization, `npx next build` compiling both pages cleanly, and the pure-function logic via unit tests. This is the orchestrator's stated post-review manual-verification step per the plan, not a gap I could close in this role.
- **Post-migration backfill correctness** (acceptance criterion 10) cannot be verified until the migration is actually applied — by design, per the migration-push-gate. I verified the *pre-migration* live data and confirmed the SQL's WHERE clauses will produce the correct backfill when it does run, but did not (and per the gate, should not) apply it myself.
- **`AccrualEnvelope`/`checkAccrualShortfall`/`monthly-review-build.ts` interaction with draws** — explicitly out of scope per the plan (draws only affect the forecast projector, not the pace-tracking system); did not test since it's an intentional non-change, not a gap.

## Notes on process

Read `00-request.md`, `01-plan.md`, and `02-implementation.md` in full before starting. No prior `03-test-report.md` existed for this task (first round). Cross-checked every specific verification item named in the task instructions individually: migration SQL correctness/schema-sync, `generateBillOccurrences` fallback byte-identity (diffed, not just described), all 3 call sites, CRUD auth/scoping, UI component fidelity to `projected-revenue-card.tsx` and ground rule 1 (confirmed empty-by-default, no pre-filled values), no-commits/no-migration-applied state.
