# Review: Quarterly Business Forecast

## Verdict: APPROVED

Independently re-verified the fix, the forecasting math, scope boundaries, ground-rule discipline, and UI copy by reading the actual diff (not just the write-ups), and re-ran `pnpm typecheck`, `pnpm test` (full suite), and `pnpm lint` myself rather than trusting the test report's numbers.

- `pnpm typecheck` — clean, exit 0.
- `pnpm test` — 362/362 passed across 32 files (matches the test report exactly).
- `pnpm lint` — 0 errors, 44 pre-existing warnings, none in this task's files.

## 1. The income/revenue fix — re-verified independently, correct

`app/business/[slug]/pl/page.tsx` line 65: `db.glCode.count({ where: { entityId: entity.id, type: "revenue" } })`. The comment directly above it is accurate and now correctly attributes the convention ("`GlCode.type` is `'revenue'` for business income — `'income'` is reserved for personal-finance concepts... confirmed against the live database and fixed in `lib/reports.ts`'s `computePL` and `prisma/seed.ts`").

Cross-checked against `lib/reports.ts#computePL` (line 64): `if (gl.type === "revenue")` — matches exactly. Grepped every file in this task's scope (`lib/business-quarter-forecast.ts`, `actions/business-forecast.ts`, `components/business/tax-reserve-pct-form.tsx`, `lib/settings.ts`, `app/business/[slug]/pl/page.tsx`, the test file) for `"income"` — the only hit is the corrected explanatory comment. No residual bug string anywhere in scope.

I also grepped the whole repo (not just this task's files, per standing memory practice) for `type === "income"` / `type: "income"` — the only source-code hit outside pipeline docs/memory is `lib/forecast.ts`'s `ScheduleEventType` (a personal-finance schedule-event union, unrelated to `GlCode`) and its test file. `components/business/gl-page-client.tsx`'s `GL_TYPES` array is `["revenue", "expense", "asset", "liability", "equity"]` — already correct, contrary to the Coder's stale `02-implementation.md` claim that it was a latent bug (see note under "What's good / minor" below). No other file has the mistake.

## 2. Scope-boundary integrity — confirmed, the forecast math never touched the GL type string

Read `lib/business-quarter-forecast.ts` end to end. Its only import is `Decimal` from `@prisma/client/runtime/library`; it never imports from `lib/reports.ts`, never references `GlCode`, and never contains the literal `"income"` or `"revenue"` anywhere. It operates exclusively on `QuarterlyPLPoint`/`actualToDate: { totalIncome, totalExpenses }` — plain `Decimal` totals handed to it by the caller, already aggregated by `computePL`. The field names `totalIncome`/`incomeLines` on `PLReport` (in `lib/reports.ts`) are pre-existing, legitimate English labels for the aggregated revenue bucket — not a reference to the `GlCode.type` enum value — so their presence in this module's types is not the same bug recurring, it's consistent naming inherited from a stable dependency.

This confirms the meaningful distinction stated in the task: the bug could only ever have leaked in at the page-level gating query (`db.glCode.count({ where: { type: ... } })`), which is exactly where it did leak in and exactly where it's now fixed. The forecasting math itself was never at risk and needed no changes.

## 3. Ground rule 1 — no tax-bracket/SE-tax computation introduced

Read `computeTaxReserveEstimate` in full: `reserveBasis = max(projectedNetIncome, 0)`, `reserveAmount = reserveBasis × reservePct / 100`. That's the entire function. Grepped the task's files for bracket/self-employment/social-security/1040/safe-harbor terms — every hit is a disclaiming comment or caveat sentence, no computation. Confirmed no IRS-specific figures are fabricated or hardcoded anywhere in this module.

## 4. Ground rule 8 — read the actual rendered copy, it is properly hedged

Read the JSX in `app/business/[slug]/pl/page.tsx` directly:

- Section subtitle: "Projections blend this quarter's pace against recent trailing quarters — estimates, not a guarantee, and not tax or financial advice."
- Reserve caveat (verbatim, matches plan): "Rough cash-reserve estimate based on a flat percentage of projected net income — not a computed tax liability. Doesn't account for tax brackets, self-employment tax, deductions, or your household's full return. Confirm the right rate and any required estimated payments with your CPA."
- Sudden Valley gets an additional placeholder-GL caveat, conditioned correctly on `slug === "sudden-valley"`.
- Low-confidence visual distinction is real, not just textual: a `~` prefix is applied to income/expense/net projected figures and the reserve amount only when `confidence === "low"`, plus a separate `ConfidenceBadge` component rendering "Not enough history yet" / "Partial history" / "Full history" for low/medium/high respectively. This is a genuine visual distinction, not false precision dressed up as a caveat.

No advice-grade certainty language ("you will owe/net") found anywhere.

## 5. Code quality and completeness against plan scope

- All planned exports present with matching signatures: `getQuarterForDate`, `getQuarterBounds`, `getPriorQuarters`, `projectQuarterEndPL`, `computeTrailingQuarterlyAverages`, `computeTaxReserveEstimate`, `DEFAULT_TAX_RESERVE_PCT`.
- Quarter-math correctness hand-verified: leap-year Q1 (91 days) vs. non-leap (90 days), `daysElapsed` floored at 1 / capped at `daysInQuarter`, year-boundary rollover in `getPriorQuarters`, invalid-format throws in both `projectQuarterEndPL` and `getQuarterBounds`. All traced by reading the actual implementation, not just trusting green tests.
- Worked test cases (steady state, front-loaded income lump, back-loaded expenses + zero-revenue, no-history first quarter, already-complete quarter) reproduce the plan's hand-derived expected values exactly — re-derived case 2's blend arithmetic by hand: `(84640×10 + 9200×82)/92 = 17400` ✓.
- `AppSetting`-based settings reuse in `lib/settings.ts` is a thin, correctly-scoped wrapper (`business_tax_reserve_pct:{entityId}` key), no schema change — confirmed `prisma/schema.prisma` does not appear in `git status --porcelain` at all.
- `actions/business-forecast.ts` calls `requireAuth()` first (byte-for-byte matching `actions/reports.ts`'s pattern), validates via zod (`pct: 0..100`), persists through the settings wrapper.
- Mezzo correctly excluded: `hasIncomeGl` gates the entire forecast block including all `computePL` calls, so no forecast queries even run for an entity with zero `revenue`-type GL codes, and no error path exists.
- Test suite (24 tests in the forecast file, including 4 Tester-added edge cases for the exact-zero reserve boundary, fractional percentage precision, medium-confidence tier, and the `trailingQuarters` override) is substantive, not superficial — it exercises real edge cases (zero-revenue entity, first-quarter-no-history, already-complete quarter, invalid formats) rather than just happy-path assertions.
- Scope discipline: `git status --porcelain` confirms only `lib/settings.ts` and `app/business/[slug]/pl/page.tsx` were modified among files relevant to this task (plus the 4 new files). The other modified files showing in git status (`actions/reports.ts`, balance-sheet page, `app/business/page.tsx`, `app-sidebar.tsx`, `prisma/schema.prisma`) are pre-existing uncommitted changes from a separate, concurrent bank-statements/period-balance-sheet task — confirmed present in the git status snapshot from before this task's work began, not touched by this diff.

## 6. CLAUDE.md convention note — accurate and well-placed

Read the added note directly:

> **"income" vs "revenue"** — `GlCode.type` (business entities) uses `revenue` (the enum is `asset|liability|equity|revenue|expense`, defined in `actions/gl-codes.ts`'s `GL_TYPES` — never `income`, confirmed against live production data). `"income"` is reserved for personal-finance concepts (e.g. `lib/forecast.ts`'s `ScheduleEventType`, `lib/tax-guidance.ts`'s question categories). This exact mix-up recurred across three separate tasks before being fixed for good in the `gl-code-tag-mapping` change...

Verified every factual claim directly:
- `actions/gl-codes.ts` line 14: `const GL_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;` — matches.
- `lib/reports.ts#computePL` checks `gl.type === "revenue"` — matches.
- `lib/forecast.ts`'s `ScheduleEventType` includes `"income"` as a literal — matches, and is legitimately unrelated to `GlCode`.
- `lib/tax-guidance.ts` line 21: `category: "filing_status" | "income" | "deductions" | ...` — matches.

The note is placed correctly under the "Money" section, next to the other money-handling convention, where a future Coder/Planner reading CLAUDE.md top-to-bottom would encounter it before writing any GL-adjacent code. No inaccuracies found.

## What's good

- The Tester's independent re-verification and 4 added edge-case tests were genuinely useful, not rubber-stamping — they caught real gaps (exact-zero boundary, fractional percentage, medium-confidence tier, `trailingQuarters` override) that the original 20 tests missed.
- The core projection module's isolation from `lib/reports.ts`/GL type strings is a real, structurally-enforced design win — it made this bug impossible to reintroduce in the forecasting math itself, only at the single page-level query that gates rendering, which is exactly what happened and exactly what got fixed.
- UI copy is genuinely careful about ground rule 8 — hedged language, visual (not just textual) low-confidence treatment, and an honest additional caveat for Sudden Valley's placeholder GL data rather than presenting all entities with equal confidence.
- Decimal precision handled correctly throughout (single final division instead of materializing a JS float weight — noted and cross-referenced to existing coder memory on this exact pitfall).

## Minor, non-blocking note

`02-implementation.md`'s "SPECIAL ITEM" section (written before the human's correction) argues at length, with specific line citations, that `"income"` was correct and flags `gl-page-client.tsx`'s `GL_TYPES` enum as a separate latent bug for lacking `"income"`. Both of those claims are now known-incorrect (the live code confirms `GL_TYPES` already correctly contains `"revenue"`, not `"income"`, and was never actually broken). This doesn't affect the shipped code — it's a stale narrative in an implementation write-up a future reader could be misled by if they read it in isolation without the pipeline's later correction. Not worth a round-trip to fix; noting it here for the record, consistent with what the Tester already flagged.

## Outstanding, not a blocker

Per this repo's established pattern for UI-touching tasks, no pipeline agent (including this review) has browser access. The rendered `/business/ek-consulting/pl` and `/business/sudden-valley/pl` pages have not been visually verified in a running dev server — layout, real numeric sanity, and the percentage-edit form's persistence through a real page refresh all remain unconfirmed by any agent. This does not block approval (the plan, implementation, and test report all explicitly flag it as a separate follow-up rather than silently assuming it's covered), but a human must still do this before treating the feature as fully done end to end.

Once that visual check passes, this delivers real (if currently likely low-confidence/near-zero for Sudden Valley given its short operating history, per the plan's own Risk 1) value: a genuine, GL-data-driven quarter-end forecast and cash-reserve estimate for both in-scope entities, gated correctly to exclude Mezzo, with no fabricated tax figures and properly hedged UI language.
