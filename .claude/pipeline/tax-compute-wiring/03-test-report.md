# 03 — Test Report: DB-wiring layer for the tax computation engine (TY2025)

## Verdict: PASS

## Summary

Independently re-ran every check the Coder claimed, read the full diff of all touched files, read
`lib/tax-compute-build.ts` end-to-end (not just the tests), and cross-checked the Prisma schema's
unique constraint directly. Every self-reported number matched what I observed. No defects found.

## Acceptance criteria checklist

1. **`lib/tax-compute-build.ts` exists; every function matches the plan's stated signatures; strict
   TS, no `any`.** PASS — read the full file (681 lines). Every exported function/interface name and
   signature (`classifyTaxBreakdownLabel`, `classifyAdditionalWithholdingLabel`,
   `sumPaystubWithholding`, `findUnparseableExtractions`, `sumW2Documents`, `sum1099InterestIncome`,
   `sumItemizedDocInputs`, `parseDollarAnswerToCents`, `parseSqftAnswer`, `resolveHomeOfficeSqft`,
   `resolvePersonalTaxComputeInput`, `buildPersonalTaxComputeInput`) matches the plan's "Design"
   section verbatim. `pnpm typecheck` clean (0 errors).

2. **Only `buildPersonalTaxComputeInput` imports/uses `db`.** PASS — `grep -n "import { db }"
   lib/tax-compute-build.ts` returns exactly one hit, at line 2. `grep -n "\bdb\."` shows all 5 `db.*`
   call sites at lines 617–640, all inside `buildPersonalTaxComputeInput` (which starts at line 601).
   Every other exported function is pure (no `db` reference).

3. **`lib/tax-guidance.ts` diff is purely additive.** PASS — `git diff HEAD -- lib/tax-guidance.ts`
   shows zero `-` (removed/changed) lines; exactly three new `TAX_QUESTION_BANK` entries
   (`home_office_sqft`, `retirement_contribution_amount`, `estimated_tax_payments_amount`), each with
   `options: undefined`, inserted immediately after their narrative counterparts. No existing entry's
   text was touched.

4. **`ensurePersonalWorkspace`'s guard-removal is genuinely idempotent/answer-preserving.** PASS,
   verified directly against the schema, not just the Coder's claim:
   - `prisma/schema.prisma`'s `TaxQuestion` model has `@@unique([workspaceId, key])` (confirmed by
     reading the model directly, lines 581–597).
   - The `createMany` call's `data:` mapping only ever sets `workspaceId`, `key`, `category`,
     `question`, `options` — it never includes `id`, `answer`, `answeredAt`, or `skippedReason`.
   - `skipDuplicates: true` against a Postgres unique constraint compiles to `ON CONFLICT DO NOTHING`
     — on a `(workspaceId, key)` collision, Prisma does **not** fall back to an update; the existing
     row (whatever its `answer`/`answeredAt`/`skippedReason` currently hold) is left completely
     untouched.
   - Net effect: repeated calls against a workspace whose 9 original questions are already fully
     answered can only ever insert the 3 new bank keys the workspace doesn't have yet (once); every
     subsequent call is a no-op for those keys too, once they exist (answered or not). There is no
     code path by which this change can create a duplicate row, overwrite an answer, or reset an
     answered question back to unanswered.

5. **`scheduleCDataMissing` and its high-priority message fire correctly when EK Consulting has zero
   GL totals.** PASS. Traced the logic directly (`lib/tax-compute-build.ts:565–570`):
   `scheduleCDataMissing = ekConsultingGlIncomeTotal.isZero() && ekConsultingGlExpenseTotal.isZero()`,
   and the exact high-priority message (matching the plan's wording verbatim) is pushed into
   `buildGaps` whenever that's true. Confirmed via the test file's end-to-end fixture (lines 499–544),
   built from the real live wage/withholding figures cited in the plan
   (Eric Rippling PEO $186,160.26/$40,958.31 fed/$11,123.90 CT; Eva Seacoast Mushrooms
   $43,309.00/$4,202.03 fed/$1,945.13 CT) with both EKC GL totals at `Decimal(0)` →
   `scheduleCDataMissing === true` and the message is present in `buildGaps`. A second fixture with
   nonzero GL totals asserts `scheduleCDataMissing === false` and the message's absence.

6. **Paystub label-matching tested against the real label variance and handles unrecognized labels
   defensively.** PASS. `classifyTaxBreakdownLabel` is tested against all 5 real live label strings
   from the plan's live-data investigation (`"Federal Income Tax"`, `"Connecticut State Income Tax"`,
   `"CT Income Tax"` — the confirmed variance — `"Connecticut Paid Family"`, `"CT PFML"`) plus
   `"Social Security"`/`"Medicare"` and one made-up unrecognized label (`"Local Tax"` →
   `"unrecognized"`, not silently dropped or included). `sumPaystubWithholding` has a dedicated test
   (`"an unrecognized label is excluded from both sums and appears in unrecognizedLabels"`) proving an
   unrecognized label is excluded from both totals *and* surfaced in a diagnostic array, not silently
   summed or dropped. `classifyAdditionalWithholdingLabel` is separately tested with its own
   unrecognized case.

7. **Zero importers of `tax-compute-build.ts` anywhere else in the app.** PASS —
   `grep -rn "tax-compute-build" --include="*.ts" --include="*.tsx" .` (excluding the module and its
   own test file) returns no hits.

8. **No `prisma/schema.prisma` changes.** PASS — `git diff HEAD -- prisma/schema.prisma` is empty (0
   lines), and `git status --porcelain` confirms `prisma/` isn't in the modified-files list at all.

9. **No `components/tax/*`, no new route/page, no new `actions/*.ts` file.** PASS — `git status
   --porcelain` shows only `actions/tax-planning.ts` (M) and `lib/tax-guidance.ts` (M) modified, plus
   `lib/tax-compute-build.ts` and `lib/__tests__/tax-compute-build.test.ts` as new (??). No
   `components/`, no new action files.

## Tests run (exact commands, real output)

```
$ pnpm typecheck
$ tsc --noEmit
(clean, 0 errors)
```

```
$ pnpm lint
✖ 47 problems (0 errors, 47 warnings)
```
All 47 warnings are in files this task did not touch (`components/offline-indicator.tsx`,
`components/retirement/retirement-balance-form.tsx`, `components/settings/entities-client.tsx`,
`components/tag-rules/retroactive-rule-modal.tsx`, `components/vault/*`, `lib/__tests__/doc-extract.test.ts`,
`lib/__tests__/forecast.test.ts`, `lib/encrypt.ts`, `lib/plaid-sync.ts`, `lib/transfer-match-runner.ts`,
`prisma/seed.ts`) — pre-existing baseline, matches the Coder's claim exactly.

```
$ pnpm vitest run lib/__tests__/tax-compute-build.test.ts
 ✓ lib/__tests__/tax-compute-build.test.ts (38 tests) 10ms
 Test Files  1 passed (1)
      Tests  38 passed (38)
```

```
$ pnpm test
 Test Files  51 passed (51)
      Tests  719 passed (719)
```
Matches the Coder's self-reported 719/719 across 51 files exactly — no regressions.

## Tests added

None needed. The existing 38 tests in `lib/__tests__/tax-compute-build.test.ts` already cover every
case the plan's "Test expectations" section specified, including the exact edge cases I would have
otherwise added myself:
- Real CT-withholding label variance (`"Connecticut State Income Tax"` vs `"CT Income Tax"`).
- Unrecognized-label defensive handling (both paystub classifiers).
- The exact mistagged-1098-as-W2 shape (unparseable extraction, `unusableDocs`, never counted as $0).
- 1099-DIV correctly excluded from interest income.
- The real "skipped"/`skippedReason` shape vs. genuinely-unparseable prose (`"Yes"`).
- `scheduleCDataMissing` true/false in both directions, with real live dollar figures.

I independently verified the `resolvePersonalTaxComputeInput` end-to-end fixture's numbers hand-trace
correctly against the source (wages, federal/CT withholding sums, `scheduleCDataMissing`) rather than
just trusting the assertions — see items 5 and 6 above.

## Defects found

None.

## Not tested / out of scope for this round

- **`buildPersonalTaxComputeInput` itself (the DB-aware orchestrator)** — not unit-tested, by design,
  matching this repo's established "DB-touching wrapper isn't directly tested" convention (same as
  `lib/dedupe-runner.ts`, `checkCardPaymentsDue`). I did not attempt to exercise it against the live
  Supabase DB (no live-DB test harness exists in this repo's test suite, and the plan explicitly scopes
  this out). I did read it line-by-line (lines 601–680) and confirmed its query shapes match the plan's
  stated `app/tax/personal/[year]/page.tsx`-mirroring design, and that it correctly maps Prisma model
  fields into the pure resolver's input shape with no fabricated defaults (year lookups, `[]`/`Decimal(0)`
  fallbacks are always paired with an `orchestratorGaps` note).
- **`pnpm build` / `next build`** — not run, matching the Coder's own documented reasoning (module has
  zero importers, so a production build can't exercise any new code path; the two touched files
  introduced no new imports of the kind that previously broke `next build` without breaking
  `typecheck`). I did not independently re-verify this reasoning by actually running a build, since the
  plan's acceptance criteria only list `typecheck`/`lint`/the two vitest commands and doing so would
  have risked hitting this repo's known Windows Prisma-generate DLL-lock issue for no informational
  gain given zero importers.
- **Whether the 3 new `TAX_QUESTION_BANK` entries actually render correctly in the `/tax` UI** — no
  component/page files changed in this task (confirmed via `git status`), so there's no UI surface to
  verify yet; this is explicitly out of scope per the plan ("no `components/tax/*` changes").

## Notes

- All of the Coder's self-reported command outputs (typecheck, lint, 38/38, 719/719) were independently
  reproduced exactly.
- The Coder's completion report's "Real gaps — final enumeration" section (9 numbered items) was
  cross-checked against the plan's own "Real gaps" section and matches point-for-point.
