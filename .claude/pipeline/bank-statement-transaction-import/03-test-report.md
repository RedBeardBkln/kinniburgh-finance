# Test Report: Extract transaction line items from bank statements + import as real Transactions

## Verdict: PASS

## Acceptance criteria checklist

1. **`pnpm typecheck` and `pnpm lint` pass with no new errors.**
   PASS — `tsc --noEmit` produced zero output (clean). `pnpm lint` → `0 errors, 47 warnings`.
   Manually diffed the two warnings that land inside the touched
   `components/documents/document-review-client.tsx` (`entityId` unused at line 38,
   `no-unused-expressions` ternary at line 58 inside `toggleRow`) against `git diff` — both are
   in code the diff shows as unchanged/pre-existing (the `entityId` destructure already existed
   verbatim before this change; `toggleRow`'s body isn't touched by the diff at all, only shifted
   down by unrelated additions above it). Confirmed genuinely pre-existing, not newly introduced.

2. **`pnpm test` passes; `doc-extract.test.ts` coverage of `extractDocument("bank_statement")`/
   `classifyDocType` continues to pass unmodified.**
   PASS — full suite: `736 tests passed (736)` across `52 files passed (52)`. Confirmed
   `lib/__tests__/doc-extract.test.ts` (6 tests) is in the passing set and the file itself has zero
   diff (`git diff --stat` shows only the 6 planned files touched).

3. **`bank-statement-extract.test.ts` and `bank-statement-upload.test.ts` pass unmodified.**
   PASS — both in the passing 52-file/736-test run; `git diff --stat lib/bank-statement-extract.ts`
   returns empty (zero changes), confirming the balance-reconciliation extraction path was
   genuinely untouched.

4. **Statements page shows an "Extract & import transactions" link per row and a bulk button.**
   Verified by code read, not browser click-through (no browser access in this environment — see
   "Not tested"). `components/bank-statements/statements-table.tsx`: per-row `Link` to
   `/documents/{documentId}/review?bucket={entitySlug}` renders whenever `statement.documentId` is
   truthy; header button "Extract transactions for all statements" renders whenever `hasDocuments`
   (`statements.some(s => s.documentId)`) is true. Both present in the diff, correctly wired to
   `entitySlug`/`entityId` props threaded from `app/business/[slug]/statements/page.tsx`.

5. **Bulk button runs extraction only (never creates Transaction rows), skips already-`"complete"`
   documents.**
   PASS, verified by reading the full call chain. `extractAllStatementTransactions` (new,
   `actions/bank-statements.ts`) filters to
   `!s.document || !s.document.extractionStatus || s.document.extractionStatus === "failed"`,
   correctly excluding `"complete"`/`"processing"`/`"skipped"`. It calls only
   `triggerExtraction(s.documentId!)` (imported from `actions/documents.ts`) via
   `runWithConcurrencyLimit(toExtract, 4, ...)` — same concurrency bound and result shape
   (`RetryAllPendingResult`) as the sibling `retryAllPendingStatementExtractions`. Read
   `triggerExtraction`'s body: it only calls `db.document.update` (extraction fields) — no
   `db.transaction.create` anywhere in its body or anywhere in `extractAllStatementTransactions`.
   Confirmed extraction-only.

6. **Per-statement link → review page → breadcrumb + pre-filled account select for a
   bank_statement doc with existing extraction.**
   Verified by code read + independent live extraction re-run (see item 5 under "Tests run"/live
   verification below), not browser click-through. `app/documents/[id]/review/page.tsx` resolves
   `bucket` via `getEntityBySlug`, sets `backHref`/breadcrumb to
   `/business/{bucket}/statements`/"Bank Statements" when present, fetches
   `listEntityAccounts(doc.entityId)` and passes `accounts`/`defaultAccountId` to
   `DocumentReviewClient` only when `doc.docType === "bank_statement"`.
   `document-review-client.tsx` renders a real `<select>` (`nickname (···mask)` format, matching
   `statements-table.tsx`'s existing option format) when `accounts` is non-empty, seeded from
   `defaultAccountId ?? ""`.

7. **"Import N transactions" creates real deduped `Transaction` rows with correct
   entityId/accountId/source/amount/postedAt, reports `{ imported, skipped }`.**
   Verified by code read only (not exercised live — would require a real DB write, which is
   out of scope for a read-only Tester verification per this repo's production-write discipline).
   `importStatementTransactions` (`actions/documents.ts`, unchanged by this diff except the
   `revalidatePath` fix): builds `postedAt` as `new Date(row.date + "T12:00:00Z")` (UTC noon,
   matches the plan), `amount` as `new Prisma.Decimal(row.amountCents).div(100)` (signed decimal
   dollars), `source: "import"`, dedups on `(accountId, postedAt, amount, payeeNormalized)` via
   `findFirst` before `create`. Logic matches the acceptance criterion exactly. This function's
   *logic* is pre-existing and out of this task's diff (only its `revalidatePath` line changed) —
   verifying it wasn't otherwise broken by this task's changes.

8. **Re-running the same import a second time imports 0 new rows (dedup works).**
   Verified by code read only — the `findFirst` dedup check in item 7 runs per-row before every
   `create`; a second run against identical rows/account will find the same existing rows and skip
   all of them. Not exercised live (would require a real write).

9. **After import, `/transactions` (not `/personal/transactions`) reflects new rows without manual
   refresh.**
   PASS. `git diff actions/documents.ts` confirms
   `revalidatePath("/personal/transactions")` → `revalidatePath("/transactions")`. Independently
   confirmed the real route exists: `app/transactions/page.tsx` is present in the `app/` tree, and
   `app/personal/transactions` does not exist anywhere (`find app -iname "*transactions*" -type d`
   → only `app/transactions`; `ls app/personal | grep -i transaction` → empty). This is a genuine
   fix, not a swap from one broken path to another.

10. **Newly imported transactions have `glCodeId: null`, absent from `computePL` until GL-coded
    (expected, not a bug).**
    Not independently re-verified against `lib/reports.ts#computePL` in this round (out of this
    task's diff, and the plan/implementation already cite the exact `glCodeId: { not: null }`
    filter) — accepted on the strength of the unchanged file plus this being explicitly documented,
    expected behavior rather than a claim requiring fresh verification.

11. **No `prisma/migrations/` changes.**
    PASS — `git status --short prisma/` and `git diff --stat prisma/schema.prisma` both return
    empty. No schema/migration changes anywhere in the diff.

## Tests run

```
pnpm typecheck          # tsc --noEmit — clean, zero output
pnpm lint                # 0 errors, 47 warnings (matches Coder's claimed baseline)
pnpm test                # vitest run
  Test Files  52 passed (52)
  Tests       736 passed (736)
  Duration    3.07s
```

Scope check:
```
git diff --stat
 actions/bank-statements.ts                      | 36 +++++++++++++++
 actions/documents.ts                            |  4 +-
 app/business/[slug]/statements/page.tsx         |  2 +-
 app/documents/[id]/review/page.tsx              | 45 ++++++++++++++++---
 components/bank-statements/statements-table.tsx | 60 +++++++++++++++++++++----
 components/documents/document-review-client.tsx | 47 +++++++++++++++----
 6 files changed, 167 insertions(+), 27 deletions(-)
```
Exactly the 6 files named in the task. `git diff --stat` / `git status --short` against
`lib/bank-statement-extract.ts`, `lib/tax-compute.ts`, `lib/tax-compute-build.ts`,
`actions/gl-codes.ts`, `prisma/schema.prisma` all return empty — none touched.

### Independent live verification (read-only, no mutation)

Wrote a temporary script (`scripts/_tmp-tester-verify.ts`, deleted immediately after running,
confirmed via `git status --short` showing no residue) that re-runs the exact
`triggerExtraction` code path (`downloadDocumentFile` → `classifyDocType` → `extractDocument`)
against a **different** real EK Consulting statement than the one the Planner/Coder already
smoke-tested (statement `6ea07146-...`, period 2024-12-28..2025-01-27, vs. their `90b56615-...`,
Dec 2025), without ever calling `db.document.update` or `db.transaction.create`.

Result:
```
Downloaded 135293 bytes, header: %PDF-1.7
classifyDocType -> bank_statement
transactionRows: 4
  2025-01-14  CAPITAL ONE-CRCARDPMT       -130846
  2025-01-21  COMCAST CABLE COMM...        -11300
  2025-01-22  XFINITY MOBILE...             -8376
  2025-01-23  COMCAST BOSTON Refund...      +2500
openingBalanceCents/closingBalanceCents: 2827507 / 2679485
EK Consulting Transaction count (should still be 0): 0
Document.extractionStatus after script (should be unchanged): null
```
Cross-checked arithmetic independently: `2679485 − 2827507 = −148022` cents = `−$1,480.22`, and
the sum of the 4 extracted rows is `−1308.46 − 113.00 − 83.76 + 25.00 = −1480.22` — extraction
output reconciles exactly against the statement's own opening/closing balance delta. This is
strong independent evidence the extraction path this task wires up produces genuinely correct
transaction rows against real EKC data, not just for the one statement already checked by prior
agents. No writes made; `git status --short` before and after confirms zero residue.

## Tests added

None. Confirmed this repo has zero test files under `actions/` or `components/`
(`find actions -iname "*test*"` / `find components -iname "*test*"` both empty) and
`vitest.config.ts` uses `environment: "node"` (no DOM/component test infra). This task introduced
no new non-trivial pure function — only server-action wiring and `.tsx` prop/UI changes — so per
this repo's established convention there is no meaningful automated test to add beyond
`pnpm typecheck`/`pnpm test` regression coverage, which I re-ran myself rather than trusting the
Coder's numbers.

## Defects found

None. All six changed files were read in full (or via targeted diff) and independently reasoned
through; no logic errors, scope violations, or backward-compatibility breaks were found.

## Specific risk areas verified in depth (per task instructions)

- **Backward compatibility of `document-review-client.tsx` for non-bank-statement docTypes**:
  confirmed `DocumentReviewClient` has exactly one call site (`app/documents/[id]/review/page.tsx`)
  and `accounts`/`defaultAccountId` are only ever supplied when `doc.docType === "bank_statement"`.
  For every other docType (w2, 1099, k1, extension, property_tax, mortgage_interest, policy,
  statement, mortgage_statement, insurance_policy, utility_bill, tax_return, other): `accounts` is
  `undefined`, `defaultAccountId` resolves to `null` (via `doc.bankStatement?.accountId ?? null` —
  `Document.bankStatement` is a `null` back-relation for any document with no linked `BankStatement`
  row, which is every non-bank-statement document), so `accountId` state initializes to `""` exactly
  as before. Further, confirmed at the source that only the `bank_statement` prompt in
  `lib/doc-extract.ts`'s `PROMPTS` produces `transactionRows` at all — the entire account-picker
  section is nested inside `extraction.transactionRows && extraction.transactionRows.length > 0`,
  so it structurally cannot render for any other docType regardless of props. Genuinely
  backward-compatible, not just "probably fine."
- **`revalidatePath` fix**: confirmed `/transactions` is real (`app/transactions/page.tsx` exists)
  and `/personal/transactions` does not exist anywhere in `app/`. Correct fix, not a swap of one
  wrong path for another.
- **Live re-run against real EKC data**: done independently (see above), on a different statement
  than previously tested, with an arithmetic cross-check against the statement's own balance delta
  — the strongest evidence available that extraction genuinely works, not just in the one case
  already checked.
- **`extractAllStatementTransactions` / per-row link are extraction-only**: read
  `triggerExtraction`'s full body (`actions/documents.ts`) — it only ever calls `db.document.update`
  with extraction-status/data fields, never `db.transaction.create`. The per-row "Extract & import
  transactions →" affordance is a plain `<Link>` to the review page, not a form/action — clicking it
  navigates and, on the review page, auto-triggers extraction only if
  `!doc.extractionStatus || doc.extractionStatus === "pending"`. Actual `Transaction` creation only
  happens via the explicit, separate `handleImport`/"Import N transactions" button in
  `document-review-client.tsx`, gated on a non-empty `accountId` and non-empty `selectedRows`.
  Confirmed genuinely two-step, matching the plan's "never silently import" ground rule.
- **`?bucket=` breadcrumb doesn't break the no-`?bucket=` entry point**: confirmed
  `searchParams: Promise<{ bucket?: string }>` — when `bucket` is absent, `entity` resolves to
  `null`, `backHref` falls back to `/documents`, `backLabel` falls back to `"Documents"`, and the
  breadcrumb renders the original two-segment (`Documents / Review extraction`) branch — identical
  to pre-change behavior. The generic Vault → `/documents/{id}/review` entry point is unaffected.

## Not tested

- **No browser/UI click-through.** This environment has no browser access. Acceptance criteria 4,
  6, 8 (dedup on a second real import), and the visual rendering of the account `<select>`/import
  button/summary text were verified by full code read and control-flow tracing, not by actually
  clicking through the app. This matches the plan's own "Test expectations" section, which
  concluded (correctly, and I independently agree after reading the code) that manual click-through
  is the only way to validate this in principle, but no agent in this pipeline has browser access to
  perform it.
- **Actual `Transaction` row creation (acceptance criteria 7, 8).** I did not run
  `importStatementTransactions` for real, per this repo's production-write discipline (no
  unauthorized DB mutations) — verified via code read only. The dedup query shape and
  `postedAt`/`amount`/`source` field construction were traced and match the acceptance criteria
  exactly, but this is not the same as observing a real `Transaction` row appear and a real
  duplicate get skipped.
- **`computePL`/GL-coding interaction (acceptance criterion 10).** Not independently re-verified in
  this round — `lib/reports.ts` is unchanged by this task's diff and the `glCodeId: { not: null }`
  filter was already confirmed by the Planner; accepted on that basis rather than re-reading the
  file myself this round.
- **Extraction quality across the other 10 EKC statements** (11 total minus the 2 now spot-checked
  — one by the Planner/Coder, one independently by me). Both spot-checked statements produced
  correct, balance-reconciling results, which is a good sign, but the plan itself flags this as
  genuinely unverified at scale; Eric should still visually check rows before bulk-importing across
  all 12, as the plan's own "Findings" section already states.

## Memory updates

No new reusable testing pattern beyond what's already captured — this task closely matched the
"live read-only DB verification technique" and "route handler"/"pipeline scope verification"
entries already in memory. No update needed this round.
