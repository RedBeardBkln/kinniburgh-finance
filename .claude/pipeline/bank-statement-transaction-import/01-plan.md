# Plan: Extract transaction line items from bank statements + import as real Transactions

## Restated goal

EK Consulting LLC's bookkeeping now depends on this app instead of QuickBooks, but its bank
statements — already uploaded, already balance-extracted — have never produced a single real
`Transaction` row, because the only extraction path wired to the bank-statements upload flow
pulls account-level opening/closing balances, not line items. Give Eric a way to extract
transaction line items from statements that are already sitting in storage and import them as
real, deduped `Transaction` rows, without touching the shipped balance-reconciliation feature or
the tax-compute engine.

## Live-data grounding (confirmed today, 2026-09-17, via read-only queries against production)

- EK Consulting LLC (`ek-consulting`): **12 `BankStatement` rows**, all `archivedAt: null`, all
  `extractStatus: "complete"` (balance extraction already ran), **all 12 already have `accountId`
  set** (single account: "QuickBooks Checking" ···2043) — so the "N statements missing an
  account" gap flagged as a risk in the request does **not** exist for EKC today. Every linked
  `Document.extractionStatus` is `null` (transaction-row extraction has genuinely never run, on
  any of the 12).
- `db.transaction.count({ entityId: <ek-consulting> })` = **0**, confirming the root cause fully.
- Spot-checked one real statement's stored PDF end-to-end: downloaded via
  `downloadTaxFile("statements/<entityId>/<statementId>.pdf")` — 178,525 bytes, genuine
  `%PDF-1.4` header, readable.
- **Live-ran the actual reuse candidate** (`lib/doc-extract.ts#extractDocument(buffer,
  "application/pdf", "bank_statement")`) against that same real PDF, no mocking: it correctly
  returned `transactionRows` — a 2-row December 2025 statement (`Interest Earned Credit`, $0.01;
  `XFINITY MOBILE Purchase`, -$123.20) plus `data.openingBalanceCents`/`closingBalanceCents`
  matching the statement period. **This is the strongest possible confirmation that the plan
  below works end-to-end against real data, not just in theory.**
- Sudden Valley PM LLC (`sudden-valley`): **0 `BankStatement` rows** (already has 139 real
  `Transaction` rows from another source) — this feature currently has no live data to act on for
  that entity, but the infra being built is generic to any entity with bank-statement uploads, not
  EKC-specific.
- `lib/reports.ts#computePL` filters `glCodeId: { not: null }` — confirmed by reading the file.
  Newly imported transactions will have `glCodeId: null` by default, so **they will not appear in
  computePL/Schedule C until GL-coded** at `/business/ek-consulting/gl` (existing, unchanged
  feature). This is the single biggest "still needs Eric's action" item — flagged below, not
  silently worked around.

## Scope

**Will change:**
1. `actions/bank-statements.ts` — add `documentId` to `BankStatementRow`/`listBankStatements`
   (needed so the UI can link to the per-statement review/extract flow); add a new bulk-trigger
   action `extractAllStatementTransactions(entityId)`.
2. `actions/documents.ts` — extend `getDocumentWithExtraction`'s query to also select the linked
   `BankStatement.accountId` (for pre-filling the account picker); fix the stale
   `revalidatePath("/personal/transactions")` call in `importStatementTransactions` (that route
   doesn't exist — the real transactions page is `/transactions`).
3. `app/documents/[id]/review/page.tsx` — accept an optional `?bucket=<entity-slug>` query param
   (matching the existing convention from `/accounts?bucket=`) to change the breadcrumb/back-link
   to the originating business statements page instead of the generic `/documents` vault; fetch
   and pass the entity's accounts + the statement's already-assigned `accountId` down to
   `DocumentReviewClient` when the document is a bank statement.
4. `components/documents/document-review-client.tsx` — replace the raw "paste an account UUID"
   text input with a real `<select>` of the entity's accounts when the page supplies one
   (backward compatible: falls back to the existing text input when no `accounts` prop is passed,
   so every other doc-type review flow through this same component is untouched).
5. `components/bank-statements/statements-table.tsx` + `app/business/[slug]/statements/page.tsx`
   — add a per-statement "Extract & import transactions →" link to the review page, and a bulk
   "Extract transactions for all statements" button (mirrors the existing "Parse All Pending"
   button/pattern exactly).

**Will NOT change (explicit, per request's ground rules):**
- `lib/bank-statement-extract.ts` (the shipped balance-reconciliation extraction) — zero edits.
  This is the key risk-avoidance decision of this plan; see "Key decision" below.
- `lib/tax-compute.ts`, `lib/tax-compute-build.ts` — not touched.
- The GL-code tagging/mapping feature — newly imported transactions land un-coded, same as any
  manually-entered transaction; GL-coding them is Eric's existing workflow, not rebuilt here.
- No Prisma migration — every field this plan writes to already exists
  (`Document.extractionData`/`extractionStatus`/`extractionModel`/`extractedAt`,
  `BankStatement.documentId`/`accountId`). Confirmed by reading `prisma/schema.prisma` in full for
  both models.
- `finalizeStatementUpload` (the upload flow) is not changed to auto-run transaction-row
  extraction at upload time — see Risks/Unknowns for why this is a deliberate scope line, not an
  oversight.

## Key decision: reuse existing infrastructure, don't extend `bank-statement-extract.ts`

The request asks to weigh extending `lib/bank-statement-extract.ts`'s prompt/shape vs. a new,
separate extraction pass. Reading `lib/doc-extract.ts` in full turned up something better than
either option literally proposed: **the "new, separate" extraction path already exists, is
already wired to real code (`actions/documents.ts#triggerExtraction` →
`classifyDocType("bank_statement", ...)` → `extractDocument(buffer, mimeType, "bank_statement")`),
already has real Vitest coverage (`lib/__tests__/doc-extract.test.ts`'s
`"extractDocument — bank_statement"` block), and — confirmed live above — already produces correct
`transactionRows` against a real EKC statement PDF.** The only reason it's never fired for a
`BankStatement`-sourced `Document` is that nothing ever navigates to `/documents/{id}/review` for
one (the bank-statements UI never links there, and `finalizeStatementUpload` never sets
`Document.extractionStatus`, so the review page's own "auto-trigger extraction if untried"
condition — `!doc.extractionStatus || doc.extractionStatus === "pending"` — has simply never been
reached for these documents).

So this plan's core move is **zero new prompts, zero new extraction functions, zero changes to
`lib/bank-statement-extract.ts`** — it wires the existing `triggerExtraction` /
`importStatementTransactions` / review-page machinery (built for the generic `/documents` vault)
to be reachable from the business bank-statements UI, and improves its account-picker UX for the
bank-statement case specifically. This is the lowest-risk option available: the shipped
balance-reconciliation feature (`BankStatement.extractionData`/`extractStatus`, everything
`lib/period-balance-sheet.ts` and the balance-sheet page depend on) is never touched by any file in
this plan.

Also confirmed: `downloadDocumentFile` (used by `triggerExtraction`) already special-cases the
`"statements/"` fileKey prefix and routes it to `downloadTaxFile`/the `taxes` bucket — so the
bucket-mismatch risk that would otherwise be the obvious failure mode here (documents.ts's default
bucket is `receipts`, but bank statements live in `taxes`) is already handled by existing code.
Confirmed live in the smoke test above, not just by reading the routing logic.

## Approach (ordered steps)

1. **`actions/bank-statements.ts`: expose `documentId` on `BankStatementRow`.**
   Add `documentId: string | null` to the interface and to `listBankStatements`'s map (`s.documentId`
   is already selected implicitly via the full-row query — no new Prisma query needed, just include
   it in the returned shape). This is what lets the UI build a link to
   `/documents/{documentId}/review`.

2. **`actions/bank-statements.ts`: add `extractAllStatementTransactions(entityId)`.**
   `requireAuth()` first line. Query `db.bankStatement.findMany({ where: { entityId, archivedAt:
   null, documentId: { not: null } }, include: { document: { select: { id: true, extractionStatus:
   true } } } })`, filter to rows where `!s.document || !s.document.extractionStatus ||
   s.document.extractionStatus === "failed"` (skip anything already `"complete"`/`"processing"`/
   `"skipped"` to avoid redundant Claude calls), then run `triggerExtraction(s.documentId!)`
   (imported from `@/actions/documents`) through the existing `runWithConcurrencyLimit(list, 4,
   ...)` helper — the exact same concurrency bound `retryAllPendingStatementExtractions` already
   uses. Return `{ attempted, succeeded, failed }` (same shape as `RetryAllPendingResult`).
   `revalidatePath("/business")` at the end. **Deliberately extraction-only — never auto-imports.**
   Each statement's rows still require the per-statement review/select/import step (step 6) before
   any `Transaction` row is created, preserving the "never silently include or drop a row" ground
   rule.

3. **`actions/documents.ts`: extend `getDocumentWithExtraction`.**
   Add `bankStatement: { select: { accountId: true } }` to its `include` (alongside the existing
   `entity: true`). Purely additive — no existing caller inspects the shape strictly enough to
   break.

4. **`actions/documents.ts`: fix the stale `revalidatePath` in `importStatementTransactions`.**
   Change `revalidatePath("/personal/transactions")` → `revalidatePath("/transactions")`
   (confirmed: `app/personal/transactions` doesn't exist anywhere in the `app/` tree; the real,
   only transactions list is `app/transactions/page.tsx`). Without this fix, a newly-imported
   EKC transaction wouldn't show up on `/transactions` without a manual hard refresh — a real,
   in-scope bug for this task's own success criteria ("Eric can see the result").

5. **`app/documents/[id]/review/page.tsx`: `?bucket=` support + account picker wiring.**
   - Add `searchParams: Promise<{ bucket?: string }>` to `PageProps` (matches the existing
     `app/transactions/page.tsx` / `/accounts?bucket=` convention).
   - If `bucket` is present, resolve it via `getEntityBySlug(bucket)` for a business-context
     breadcrumb/back-link (`Business / {entityLabel} / Bank Statements` →
     `/business/{bucket}/statements`) instead of the generic `Documents` breadcrumb/`/documents`
     link. Falls back to today's behavior when `bucket` is absent (every non-bank-statement review
     flow is unaffected).
   - When `doc.docType === "bank_statement"`, additionally call `listEntityAccounts(doc.entityId)`
     (already exported from `@/actions/bank-statements`, already used by the statements page) and
     pass the result as a new `accounts` prop to `DocumentReviewClient`, plus
     `defaultAccountId={doc.bankStatement?.accountId ?? null}`.

6. **`components/documents/document-review-client.tsx`: real account picker.**
   Add optional props `accounts?: { id: string; nickname: string; mask: string | null }[]` and
   `defaultAccountId?: string | null`. Initialize the existing `accountId` state from
   `defaultAccountId ?? ""`. When `accounts` is provided and non-empty, render a `<select>`
   (`nickname (···mask)`, matching the exact option-label pattern already used in
   `statements-table.tsx`'s account `<select>`) instead of the current raw text input; keep the
   text-input fallback when `accounts` isn't supplied, so every other document type reviewed
   through this same shared component (W2, 1099, insurance, utility bills — none of which have
   `transactionRows`, so this section doesn't even render for them) is unaffected.

7. **`components/bank-statements/statements-table.tsx` + `app/business/[slug]/statements/page.tsx`:
   surface the new flow.**
   - Thread `entitySlug` (the page already has `slug`) into `<StatementsTable>` as a new prop.
   - Per statement row (when `statement.documentId` is truthy — should be every row post the
     two-phase-upload rewrite, but guard anyway): add a link
     `/documents/{documentId}/review?bucket={entitySlug}` labeled "Extract & import transactions →".
     Not gated on `extractStatus` — transaction-row extraction is orthogonal to balance extraction.
   - Add a header-level "Extract transactions for all statements" button (visible whenever any
     statement has a `documentId`), calling the new `extractAllStatementTransactions(entityId)` and
     showing a result summary — exact UI pattern already established by "Parse All Pending"/
     `handleParseAll` in the same file; copy that pattern, don't invent a new one.

## Trigger mechanism (explicit answer to request point 4)

A **new, explicit action** — not an overload of `retryStatementExtraction`/
`retryAllPendingStatementExtractions`, which the request itself correctly identifies as having a
different, narrower meaning ("the balance extraction failed, try again"). The new mechanism is
two affordances, both extraction-only (never auto-import, per the ground rules):
- Per-statement: a link into the existing, already-correct `/documents/{id}/review` flow, which
  auto-triggers extraction on first load.
- Bulk: `extractAllStatementTransactions(entityId)`, a new sibling action mirroring
  `retryAllPendingStatementExtractions`'s exact shape/concurrency pattern, scoped to "documents
  that have never had transaction-row extraction attempted."

## Findings (what this unblocks vs. what still needs Eric's action)

**Unblocked by this change, once shipped:**
- All 12 EK Consulting bank statements are immediately ready to extract — no account-assignment
  gap exists for this entity (confirmed live, see grounding section above).
- Real `Transaction` rows can now be created for EK Consulting, sourced from statements already in
  storage, with the same dedup discipline (`accountId` + `postedAt` + `amount` + `payeeNormalized`)
  `importStatementTransactions` already applies to every other import path in the app.
- Once real transactions exist, `lib/tax-compute-build.ts`'s `scheduleCDataMissing` flag and
  `computePL` become able to see real activity for the first time (subject to the GL-coding caveat
  immediately below) — this task does not touch either file, per the ground rules, but its output
  is exactly the input they were missing.

**Still needs Eric's action after this ships (explicitly, not silently deferred):**
1. **Run extraction on all 12 EKC statements** (bulk button, one click, but each is a real Claude
   call — not instant).
2. **Review and select rows to import, per statement**, at `/documents/{id}/review?bucket=ek-consulting`
   — extraction quality wasn't spot-checked beyond the one statement in the grounding section above;
   some rows across 12 statements may be ambiguous or misparsed and should be visually checked
   against the PDF before import, not blindly bulk-imported.
3. **GL-code the newly-imported transactions** at `/business/ek-consulting/gl` — confirmed via
   reading `lib/reports.ts#computePL`, un-coded transactions (`glCodeId: null`, which is what every
   freshly-imported row will have) are invisible to `computePL`/Schedule C until coded. This is the
   single most important "not actually done yet" caveat to communicate — importing transactions
   alone does not make Schedule C real.
4. **Decide whether to extend this to future statements automatically.** This plan intentionally
   leaves `finalizeStatementUpload` unchanged — new statement uploads still only get balance
   extraction automatically; transaction-row extraction for anything uploaded after this ships
   still requires clicking "Extract & import transactions" (or the bulk button). Flagged as a
   deliberate, not-yet-decided scope line under Risks below, not something this plan resolved.
5. Sudden Valley PM LLC has zero `BankStatement` rows today, so this feature has nothing to act on
   for that entity yet — not a gap in this plan, just a fact about current data.

## Risks / unknowns

- **Extraction quality across the other 11 statements is unverified.** Only one statement (Dec
  2025) was live-smoke-tested end-to-end. The `bank_statement` prompt caps at 200 rows and is a
  general-purpose prompt (shared with every other bank-statement-shaped document in the generic
  vault) — it has not been tuned specifically for whatever this particular Green Dot Bank/QuickBooks
  Checking statement format looks like across all 12 months. Some rows may come back malformed or
  with an ambiguous date/amount; the existing review UI (checkbox-per-row, all rows pre-selected)
  is the safety net, but Eric should actually look at each row before importing, especially for the
  first few statements.
- **`payeeNormalized` in `importStatementTransactions` is set from `row.description.slice(0, 100)`
  directly, not run through `lib/tags.ts#normalizePayee()`.** This is pre-existing behavior in a
  function this task deliberately doesn't touch (out of the request's explicit scope — "this
  task's job stops at real Transaction rows exist"), but it means tag-rule auto-matching
  (`matchTagRule`, keyed off normalized payee) may not fire as expected on these imported rows.
  Flagging, not fixing — a natural follow-up for whoever next touches tag auto-assignment for
  imported transactions.
- **The existing dedup check in `importStatementTransactions` doesn't filter `archivedAt: null`
  on the candidate duplicate `Transaction`.** Pre-existing behavior, unrelated to this task's
  changes, left as-is per the ground rule against unrequested scope expansion — flagging in case a
  future archived-and-reimported transaction produces a surprising "skipped as duplicate" result.
- **Whether transaction-row extraction should eventually run automatically at upload time** (i.e.
  extend `finalizeStatementUpload` to also call `extractDocument(..., "bank_statement")` alongside
  the existing `extractBankStatement` call) is a real product decision this plan doesn't make. Doing
  so would double the Claude API calls per statement upload and touch the shipped upload flow —
  deliberately deferred rather than silently bundled in. Recommend revisiting after Eric has used
  the manual/bulk trigger on the 12 existing EKC statements and has a feel for extraction quality
  and cost.
- **No per-statement "already has extracted/imported transactions" indicator on the statements
  table.** After this ships, the table will show the same "Extracted" (balance) badge regardless of
  whether transaction-row extraction/import has happened — Eric has to click through to
  `/documents/{id}/review` to find out. A small, deferrable UX gap, not a data-integrity issue
  (skipped duplicates prevent double-import even without this indicator).
- **Multi-account statements**: `lib/doc-extract.ts`'s `bank_statement` prompt shape has a single
  flat `data.accountMask`/`institutionName`/balance fields (no per-account array, unlike
  `lib/bank-statement-extract.ts`'s `ExtractedStatement.accounts[]`). EKC's real statements are
  single-account (confirmed), so this doesn't block this task, but a future business entity with a
  genuinely multi-account statement PDF would get a muddled single-account extraction from this
  path. Not fixed here — flagging for awareness.

## Acceptance criteria

1. `pnpm typecheck` and `pnpm lint` pass with no new errors.
2. `pnpm test` passes; existing `lib/__tests__/doc-extract.test.ts` coverage of
   `extractDocument("bank_statement")`/`classifyDocType` continues to pass unmodified (this plan
   doesn't touch `lib/doc-extract.ts`'s logic, only wires existing exports into new call sites).
3. `lib/__tests__/bank-statement-extract.test.ts` and `lib/__tests__/bank-statement-upload.test.ts`
   pass unmodified — confirms `lib/bank-statement-extract.ts` was genuinely untouched.
4. Navigating to `/business/ek-consulting/statements` shows an "Extract & import transactions"
   link per statement row and a bulk "Extract transactions for all statements" button.
5. Clicking the bulk button runs extraction (via `triggerExtraction`) for every EKC statement whose
   linked `Document.extractionStatus` is `null`/`"failed"`, and does NOT create any `Transaction`
   rows by itself (extraction-only, confirmed by inspecting `Transaction` count before/after — it
   must not change).
6. Clicking a per-statement link navigates to `/documents/{documentId}/review?bucket=ek-consulting`,
   shows a breadcrumb back to Bank Statements (not the generic `/documents` vault), and — for a
   document whose extraction already ran — shows the extracted `transactionRows` in a table with
   all rows pre-selected, and a `<select>` of EK Consulting's real accounts pre-filled to
   "QuickBooks Checking (···2043)" (the statement's already-assigned account).
7. Clicking "Import N transactions" creates real `Transaction` rows (`entityId` = EK Consulting,
   `accountId` = the selected account, `source: "import"`, `amount` as a signed `Decimal` in
   dollars, `postedAt` at UTC noon of the row's date) for every selected row not already matching
   an existing transaction on `(accountId, postedAt, amount, payeeNormalized)`, and reports
   `{ imported, skipped }` matching the number of new vs. duplicate rows.
8. Re-running the same import (same statement, same selected rows) a second time imports 0 new
   rows and reports all as skipped (dedup works).
9. After a successful import, `/transactions` (not `/personal/transactions`) reflects the new rows
   without a manual hard refresh (confirms the `revalidatePath` fix).
10. Newly imported transactions have `glCodeId: null` and are correctly absent from
    `computePL`/the EK Consulting P&L page until GL-coded — this is expected, documented behavior,
    not a bug to fix in this task.
11. No `prisma/migrations/` changes are present in the diff — no new column was needed for any of
    this.

## Test expectations

This task is primarily wiring existing, already-tested pure logic
(`lib/doc-extract.ts#extractDocument`/`classifyDocType`/`parseExtractionResponse`, already covered
by `lib/__tests__/doc-extract.test.ts`) into new call sites in `actions/*.ts` (server actions,
mutation-only) and `.tsx` UI. Per this repo's established, confirmed-live convention (`actions/`
has zero dedicated Vitest files anywhere in the codebase; `components/` has zero DOM/component test
infrastructure — no jsdom/RTL, `vitest.config.ts` uses `environment: "node"`), **no new test files
are expected** for `extractAllStatementTransactions`, the `getDocumentWithExtraction`/
`importStatementTransactions` edits, or any of the `.tsx` changes. Verification is:
- `pnpm typecheck` (forces every new/changed prop-signature and query-shape to type-check against
  real callers).
- `pnpm test` (regression-only — confirms the untouched extraction/classification logic this plan
  depends on still passes).
- Manual click-through against real EKC data per the acceptance criteria above (this is genuinely
  the only way to validate LLM-extraction-quality-dependent behavior in this repo; there is no
  precedent anywhere for mocking Claude extraction output in an integration-style test).

If the Coder introduces any new non-trivial pure function (e.g. if the account-picker wiring ends
up needing real branching logic beyond a prop-presence check), add it as a small `lib/` module with
its own `lib/__tests__/*.test.ts` file, matching the repo's "pure-decision-module" convention — but
nothing currently planned here rises to that bar.

## Edge cases to cover in manual verification

- A statement with 0 extracted `transactionRows` (e.g. extraction returns an empty array, or the
  `"other"`-shape fallback fires because the PDF didn't classify cleanly) — the review page's
  `transactionRows && transactionRows.length > 0` guard already handles this by simply not
  rendering the import section; confirm this doesn't error.
- A statement whose extraction previously failed (`extractionStatus: "failed"`) — confirm the bulk
  action retries it (matches the filter `=== "failed"` in step 2) and the review page's existing
  "Try again" affordance still works.
- Importing a row whose amount is `0` cents (e.g. a $0.00 fee-waived line) — confirm it's neither
  silently dropped nor duplicated oddly; `Decimal(0)` is a valid signed amount.
- A statement with no `accountId` assigned (none exist for EKC today, but the UI must not break if
  one appears later, e.g. from a future entity) — confirm the account `<select>` falls back to an
  empty/placeholder selection rather than crashing on `defaultAccountId: null`.
