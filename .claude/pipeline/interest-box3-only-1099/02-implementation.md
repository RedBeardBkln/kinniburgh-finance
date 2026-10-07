# 02 Implementation: 1099-INT with box 1 blank and only box 3 (engine ty2025-1b.11)

## Summary of changes
- `lib/tax2025/resolve-facts.ts` (1099 loop): a 1099-INT (formVariant "1099-INT" or variantsPresent includes "1099-INT") with `int_box1Cents` null, no legacy headline, and at least one of int box 2/3/4/5/6/8/9 non-null now becomes an InterestFact with `box1Cents = 0`, `usedLegacyHeadline = false`, other boxes via the unchanged `boxValue` semantics, same basis/refs/payer. A 1099-INT with NO interest box and no headline raises the blocking open item `interest-1099-unreadable:<docId>` ("no readable interest amount", action: open the document's review screen). No existing equivalent item existed; no existing test pinned "empty 1099 is ignored" (none failed).
- `lib/tax-review/l1/source-tieout.ts`: the L1 raw-document interest tie-out mirrors the same rule (box 1 = 0 when other interest boxes exist), otherwise it would have skipped the doc and reported a false 1040.2b mismatch.
- `lib/tax-form-plan.ts` (`interestEvidence`): a 1099-INT with only another interest box filled now counts as interest data on the form-readiness plan (was shown as missing).
- `lib/tax-review/links.ts`: added `interest-1099-unreadable` to the "problem with one document" link rule (a coverage-guard test requires every open-item id family to have a link rule).
- `lib/tax2025/return.ts`: `TY2025_ENGINE_VERSION` = `ty2025-1b.11`. Pins moved in 6 existing tests (business-use-return, ct-schedule1-return, engine-l2-findings, form-8606-return, model-unmodeled-lines, overpayment-return); only the version string changed. Historic "engine ty2025-1b.10" comments elsewhere left as history.
- `specs/09-tax-year-2025-constants.md`: short section "1099-INT with box 1 blank".
- New `lib/__tests__/tax2025-interest-box3-only.test.ts` (15 tests): resolver (box3 only, unverified, box4 only, consolidated variantsPresent, all-null blocks, box1 present unchanged, legacy headline unchanged, DIV-only no item); whole return (2b = Schedule B 2 = 2,395 from $500.00 + $1,894.50 rounded once; Schedule B required, baseline without the doc not required; CT s1.39 = 1,895 computed when savings_bond_exclusion stated none, `needs_cpa_judgment` with null amount when unanswered); L2 runL2 zero mismatches + oracle 2b; L1 full pipeline: no significant income/pdf/tie-out finding and the Schedule B payer row (view table `schb.interest`, which the PDF read-back verifies) shows 1,895; AI payload shows box1 0 / box3 1895 with the generic payer alias.

## Behaviour for the live document (c7cb82bc, Jewett City Savings Bank)
- 1040.2b rises by $1,894.50 (from $1,138 plus this; total rounded once). Schedule B total interest then exceeds $1,500, so Schedule B is required and lists the payer at 1,895 (box 1 + box 3, whole dollars).
- CT-1040 Schedule 1 line 39 (existing rule, unchanged): if the owner's savings bond exclusion (Form 8815) none-statement is not answered, line 39 blocks as `needs_cpa_judgment` ("Series EE interest is subtractable only after the Form 8815 exclusion and the savings bond exclusion statement is not none"); answering "none" (no Form 8815 exclusion taken) subtracts the whole $1,894.50 (printed 1,895). The existing `interest-box3` advisory item still fires.

## Consumer audit (item 4)
- inputs.ts `aggregateInvestments`: sums box1 + box3 strictly; box1 = 0 handled correctly, no change.
- return.ts ~1716 books-interest conflict candidates: value = box1 (0); display only, harmless. No change.
- l1/double-count.ts (~86): books-interest info finding sums box 1 only; for a box-3-only doc the info message would omit its box 3 from the "1099-INT interest" figure (information only, no gate). Not changed (out of surgical scope); flagging.
- l1/source-tieout.ts: fixed (see above). l2/federal.ts: reads facts, so it agrees automatically (tested). llm/payload.ts: reads facts (tested; the payload sends whole dollars so box3 is 1895, not 189450).
- pdf/adapter.ts Schedule B rows: `sumCentsOrNull([box1, box3])` = box 1 + box 3, correct; verified by test.
- `lib/tax-compute-build.ts` `sum1099InterestIncome` (v1 helper, box 1 ONLY by its own documented plan Q3, used by app/tax/personal page and tax-forms-build): NOT changed; it is not the TY2025 engine. It will still ignore box 3. Flagging.
- Other 1099 loop code (dividends, withholding, broker) untouched.

## Deviations from the plan
- AI payload assertion is box1 0 / box3 1895 (the payload rounds to whole dollars), not 189450.
- The unreadable-interest item is raised for both formVariant "1099-INT" and variantsPresent including "1099-INT". No existing fixture tripped it.

## Commands run and results
- `tsc --noEmit` (node_modules/.bin from main repo): clean, no output.
- `eslint` on changed source files and all changed/new test files: no errors or warnings.
- Full `vitest run --exclude 'node_modules/**' --exclude '**/node_modules/**'` (final run): 10443 passed, 2 failed (10445 tests; 342 of 344 files passed). The 2 failures are the known worktree-only ones (donation-receipt-actions, review-queue-action). An earlier full run had 2 more failures (my new payload assertion and the link-rule coverage guard), both fixed and re-run.
- Did not run: pnpm build, any live engine run, any DB or network call.

## Open items
- After deploy, document c7cb82bc raises 1040.2b and may raise CT line 39 as needs_cpa_judgment until the Form 8815 / savings bond exclusion statement is answered; a Schedule B packet row will appear. The payer name on the doc may be wrong; the owner can correct it in document review (out of scope).
- In the AI payload test, the serialized JSON still contains the payer name somewhere outside `income` (most likely the printed packet text of Schedule B, an existing section not governed by the `generic` payer mode). Not investigated; the structured `income.interest` uses the alias only. Worth a look by the Reviewer if privacy of printed packet text under `generic` matters.
- double-count.ts info finding and the v1 tax-compute-build helper ignore box 3 (see audit).
