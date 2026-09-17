# Review: Extract transaction line items from bank statements + import as real Transactions

## Verdict: APPROVED

## Independent verification performed

- Read `00-request.md`, `01-plan.md`, `02-implementation.md`, `03-test-report.md` in full.
- Read the actual diff (`git diff`) for all 6 changed files, not just summaries.
- Re-ran `pnpm typecheck` (clean), `pnpm lint` (0 errors, 47 warnings — same pre-existing baseline
  cited by Coder/Tester), `pnpm test` (736/736 passed, 52 files) myself, independently of the
  Tester's numbers.
- Confirmed `git status --short` shows only the 6 planned files modified plus untracked pipeline/
  agent-memory scaffolding — no stray temp scripts (`scripts/_tmp-*`), no `prisma/migrations/`
  changes, no edits to `lib/bank-statement-extract.ts`, `lib/tax-compute.ts`,
  `lib/tax-compute-build.ts`, or `actions/gl-codes.ts`.

## Scrutinized items (per task instructions)

**1. Backward-compatibility of `document-review-client.tsx`.** Confirmed by reading the file
directly (not the Tester's paraphrase): the entire account-picker/import section is nested inside
`{extraction.transactionRows && extraction.transactionRows.length > 0 && (...)}` (line 133). Only
`lib/doc-extract.ts`'s `bank_statement` prompt ever produces `transactionRows`. The new `accounts`/
`defaultAccountId` props are optional and only ever passed from the one call site
(`app/documents/[id]/review/page.tsx`) when `doc.docType === "bank_statement"`. For every other
docType this section doesn't render at all, regardless of props. Claim confirmed independently,
not just re-stated.

**2. Extraction-vs-import two-step boundary.** Read `triggerExtraction`'s full body
(`actions/documents.ts:200-236`): only ever calls `db.document.update` with extraction-status/data
fields — no `db.transaction.create` anywhere in it or in `extractAllStatementTransactions`.
`importStatementTransactions` (`actions/documents.ts:265-321`) is the only function that calls
`db.transaction.create`, and it's invoked exclusively from `handleImport` in
`document-review-client.tsx` — a plain `onClick`, not tied to page load or the extraction
auto-trigger. Confirmed genuinely two-step: extraction (auto on page load or bulk button) never
creates a `Transaction`; only the explicit "Import N transactions" click does.

**3. UX-clarity of the new copy — one real finding.** The bulk button's label ("Extract
transactions for all statements") and its result copy ("...Review and import each statement's
rows below.") are unambiguous — they correctly describe an extraction-only action and explicitly
point the user at the still-required review/import step. However, the **per-statement link label,
"Extract & import transactions →"** (`statements-table.tsx:308`), is not accurate to what a single
click actually does — clicking it only navigates to the review page (which then auto-triggers
extraction if not yet run); it does **not** import anything. A user skimming the table could
reasonably read "Extract & import" as "clicking this imports my transactions," when actually
nothing is imported until they take a second, separate action on the destination page ("Import N
transactions"). This is a should-fix, not blocking — no `Transaction` row is ever created by this
link by itself (confirmed above), so there's no data-integrity risk, only a copy-clarity gap for a
feature that touches real bookkeeping data. Recommend renaming to something like "Review & import
transactions →" or "Extract & review transactions →" to match what actually happens. Route this
back as a should-fix; does not need to block shipping given the safety net (nothing is created
without the explicit second click, and the destination page's own copy is accurate).

**4. Scope discipline.** `git diff --stat` matches exactly the 6 files named in the plan/
implementation (167 insertions / 27 deletions). No edits to `lib/bank-statement-extract.ts` (period
reconciliation), `lib/tax-compute.ts`/`lib/tax-compute-build.ts`, or the GL-code mapping feature —
verified directly via `git diff --stat` against each of those paths (all empty). No Prisma
migration. Scope is clean.

**5. Pre-existing gaps left out of scope — assessed for whether any should actually block.**
- `payeeNormalized` bypass (`row.description.slice(0,100)` instead of `normalizePayee()`): checked
  whether this could compromise Schedule C readiness specifically — grepped `matchTagRule`/
  `payeeNormalized` usage and confirmed `actions/gl-codes.ts` has zero references to either. GL-
  coding (the actual gate for `computePL`/Schedule C visibility, via `glCodeId`) is a fully separate,
  manual workflow that doesn't depend on tag-rule auto-matching or `payeeNormalized` normalization.
  This gap affects personal-finance tag auto-assignment convenience, not tax-data correctness or
  completeness. Low risk to leave, correctly disclosed.
- Dedup not filtering `archivedAt: null` on the candidate duplicate: this is a real, if narrow, risk
  — if an imported transaction is later archived (e.g., cleanup of a bad row) and the same statement
  is re-imported, the archived row would still match and get silently skipped as "duplicate,"
  leaving a real gap in the books that looks like a successful re-import. This is pre-existing
  behavior in code this task didn't touch, correctly flagged as a known gap, and the practical
  likelihood is low (requires an archive-then-reimport sequence rather than a first-time import).
  Consistent with this repo's established, inconsistent handling of `archivedAt` guards elsewhere.
  Should-fix for whoever next touches `importStatementTransactions`, not blocking here.
- No "already extracted/imported" indicator on the statements table: genuinely low-risk — the dedup
  check (imperfect as above, but present) prevents double-import regardless of whether the user can
  see extraction status at a glance. Pure UX polish, correctly deferred.

None of the three disclosed gaps rise to a level that should block this specific change from
shipping; all three are correctly named rather than hidden, and none compromises the two-step
extraction/import safety boundary that protects real bookkeeping data.

## Code quality

- Matches existing conventions closely: `extractAllStatementTransactions` mirrors
  `retryAllPendingStatementExtractions`'s shape, concurrency bound (4), and result type
  (`RetryAllPendingResult`) almost exactly — good consistency, not a reinvented pattern.
  `document-review-client.tsx`'s new `<select>` matches `statements-table.tsx`'s existing
  `nickname (···mask)` option-label format exactly.
  - The `revalidatePath("/personal/transactions")` → `revalidatePath("/transactions")` fix is a
    genuine, real bug fix (confirmed `app/personal/transactions` doesn't exist and
    `app/transactions/page.tsx` does) — correctly in scope since it's necessary for the task's own
    "Eric can see the result" success criterion.
- Backward-compatible breadcrumb: `?bucket=` handling degrades cleanly to the pre-existing
  `Documents / Review extraction` breadcrumb when absent — verified in the diff, not just trusted.
  The non-linked `{entityLabel}` breadcrumb segment (no `/business/[slug]` index route exists) is a
  reasonable, explicitly justified deviation matching the statements page's own existing convention
  for the same reason.
- No dead code, no leftover debug statements, no fabricated data — extraction/import remain fully
  driven by real extracted rows and explicit user selection throughout.

## Test quality

- No new automated tests were added, correctly so — this repo has zero test infra for `actions/`
  or `.tsx` components (confirmed absent in this review too), and this task introduces no new
  non-trivial pure function; typecheck + full regression suite + targeted reads of the three
  acceptance-critical unchanged test files (`doc-extract`, `bank-statement-extract`,
  `bank-statement-upload`) is the right bar here and was met.
- The Tester's independent live re-verification against a second, different EKC statement (not the
  one the Planner/Coder already checked), with an arithmetic cross-check against the statement's own
  opening/closing balance delta, is genuinely strong evidence the underlying extraction path
  produces correct data — this is real verification, not just a second run of the same check.
- No actual `Transaction` row creation or dedup-on-second-import was exercised live by any agent in
  this pipeline (correctly, per this repo's no-unauthorized-writes discipline) — this remains
  verified by code read only. Acceptable given the constraint, but genuinely the last mile of
  confidence that can only come from Eric's own click-through.

## Documentation

No user-facing docs/README/changelog exist for this kind of internal workflow feature in this repo
today, and none of the sibling features (GL-code mapping, balance-sheet extraction) have one either
— consistent, no gap introduced.

## What's good

- The plan's core decision — reuse the already-tested `/documents` vault machinery instead of
  building new extraction/import logic — is the right call and was followed faithfully; this
  materially lowered risk to the shipped balance-reconciliation feature, which stayed genuinely
  untouched (verified, not just claimed).
- Every claim in the implementation/test report that mattered for this review (transactionRows
  gating, extraction-only boundary, revalidatePath fix, scope) was independently re-derived from the
  actual diff/code in this review, not taken on faith, and all held up.
- The plan's and implementation's "still needs Eric's action" sections are honest and complete —
  they don't overclaim what shipping this actually accomplishes.

## Next steps for the owner (Schedule C is still not real until all three happen)

Shipping this closes the fourth task in the build trail and makes all three of the following
possible for the first time — **none of them has happened yet**:

1. **Run extraction on the 12 EKC statements** — click "Extract transactions for all statements" on
   `/business/ek-consulting/statements` (or per-statement via "Extract & import transactions →").
   Each statement is a real Claude API call, not instant.
2. **Review and import each statement's rows** at `/documents/{id}/review?bucket=ek-consulting` —
   extraction quality has only been spot-checked on 2 of the 12 statements (both reconciled exactly
   against the statement's own balance delta, a good sign, but not a guarantee for the other 10).
   Look at each row before importing, especially for the first few statements.
3. **GL-code the newly-imported transactions** at `/business/ek-consulting/gl` — confirmed via
   `lib/reports.ts#computePL`'s `glCodeId: { not: null }` filter: freshly imported transactions are
   invisible to `computePL`/Schedule C until GL-coded. Importing alone does not make Schedule C real.

Schedule C stays $0/unreliable until all three steps are done for all 12 statements.

## Minor should-fix for a future pass (not blocking)

- Rename the per-statement link label "Extract & import transactions →" in
  `components/bank-statements/statements-table.tsx` to something that doesn't imply the click itself
  imports (e.g., "Review & import transactions →") — no data-integrity risk, pure copy clarity.
- `importStatementTransactions`'s dedup `findFirst` should eventually add `archivedAt: null` to its
  match criteria, to avoid silently treating an archived transaction as a live duplicate on
  reimport.
