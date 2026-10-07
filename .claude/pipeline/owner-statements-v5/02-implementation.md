# owner-statements-v5: implementation

No 01-plan.md exists for this slug; the spec was the caller's task message (urgent, surgical).

## Summary of changes
- `lib/tax-review/llm/owner-statements.ts`: `OWNER_STATEMENTS_VERSION` 4 -> 5; header comment explains v5 and lists the retired false statements. The estate list is still 9 statements (indexes 0-8), deed at index 7:
  0. died Aug 2024; executor and sole beneficiary; inherited the OTHER ASSETS (the house is no longer said to come from the estate); probate completed Dec 2025, final distribution letter received then, all distributions done in 2025, estate closed.
  1. estate's own number; 2024 Form 1041 filed, covers calendar 2024, reported no bond interest because the bonds were not cashed yet; no Schedule K-1 ever issued or received; the bank-interest-under-$2 / no 1099-INT, -DIV, -B recollection is now scoped "for 2024".
  2. bonds cashed in 2025 (redemption date not on the form); 2025 Form 1099-INT from the bank to the estate under its own number: box 3 $1,894.50, boxes 1, 2, 4 blank; owner reports it on the 2025 joint return as interest passing from the estate; the estate's 2025 Form 1041 not filed yet; to be matched with the final K-1.
  3. inheritance not income / ~$90,000 renovations (unchanged). 4. no energy/solar improvements (unchanged).
  5. no final 2024 Form 1040 for the mother, only the estate's 1041, so no bond interest reported before 2025; nothing from the estate held in Taxpayer F's own name in 2025 earning interest or dividends.
  6. OPEN (first of exactly two): the amount on the estate's final Schedule K-1 (2025 1041 not prepared); a different amount would mean amending the 2025 return; do not assume anything other than $1,894.50.
  7. deed: warranty deed filed with the town in March 2019, 90% joint tenancy with her mother, after mother's death Taxpayer F became the sole beneficiary of the property; not a gift (owner's statement); OPEN gift tax return unchanged and last.
  8. basis of other property A (unchanged).
- `lib/__tests__/ai-payload-fixes.test.ts`: version 5; new needles for the estate statements; deed regexes (no "undated", no "survivorship", no "sole surviving owner"); new OPEN regex; payload-wide assertions ($1,894.50 and the warranty deed phrase present; deed-word counts unchanged: "joint tenan" 1, gift phrases 2, "deed" 2); new lines pinning that the retired false statements (late 2024 redemption, 2024-estate-matter, undated deed, "no Schedule K-1 / no Form 1099 for 2025 from the estate", "amount unknown ... does not change the 2025 return", "inherited the house") never come back. No redaction/privacy assertion loosened.
- No other test pinned version 4 or these statements (grepped lib/ for OWNER_STATEMENTS*, owner-statements, late 2024, undated, estate wording).

## Reuse keys (PROMPT_VERSION / content hashes)
Read `lib/tax-review/llm/reuse.ts` and `tasks.ts`. `taskContentHash` = sha256 of schema version + SYSTEM_PROMPT + task id + instruction + categories + output schema: owner statements are NOT part of it, so no bump. The statements travel in every task's payload slice (`ownerStatements` in `tasks.ts`), and `planReuse` rebuilds the full prompt text from the earlier stored payload and the new payload and compares `system`/`user` text exactly (`input_differs`), so an earlier review run made under the v4 text will correctly NOT be reused and its tasks are re-sent. Nothing to bump; PROMPT_VERSION untouched (the system prompt and task instructions did not change).

## Deviations from the plan
- Statement 1 keeps the earlier "saw no Form 1099-INT, 1099-DIV or 1099-B under the estate's number" recollection but now scopes it "for 2024" (and "bank interest for 2024"), since a 2025 1099-INT now exists under the estate's number. This scoping is my edit, not a quoted owner word.
- The dropped clause "...or from the estate of her mother's late husband" (part of the retired no-K-1/no-1099 statement) is gone with it; the owner's v5 facts say nothing about that estate.

## Commands run
- `tsc --noEmit` (worktree, root node_modules/.bin): no output, clean.
- `eslint lib/tax-review/llm/owner-statements.ts lib/__tests__/ai-payload-fixes.test.ts`: no output, clean.
- `vitest run lib/__tests__/ai-payload-fixes.test.ts --exclude ...`: 38/38 passed.
- Full `vitest run --exclude 'node_modules/**' --exclude '**/node_modules/**'`: 343 files passed, 2 failed; 10462 tests passed, 2 failed. The two failures are the known worktree-only ones: `review-queue-action.test.ts` (has no export that skips the token gate) and the donation-receipt-actions test. Not touched by this change.
- No pnpm install/exec, prisma, DB or Anthropic calls.

## Open items
- Owner to confirm the "for 2024" scoping in statement 1 and the dropped late-husband-estate clause.
- Committed on the worktree branch only; not merged or pushed.
