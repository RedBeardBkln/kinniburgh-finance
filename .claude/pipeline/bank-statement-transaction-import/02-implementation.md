# Implementation: Extract transaction line items from bank statements + import as real Transactions

## Summary of changes

Implemented the plan exactly as scoped — wiring the existing, already-tested
`lib/doc-extract.ts#extractDocument("bank_statement")` / `actions/documents.ts#triggerExtraction`
/ `importStatementTransactions` machinery to be reachable from the business bank-statements UI.
No new prompts, no new extraction functions, `lib/bank-statement-extract.ts` untouched.

1. **`actions/bank-statements.ts`**
   - Added `documentId: string | null` to `BankStatementRow` and to `listBankStatements`'s
     returned shape (`s.documentId`) — lets the UI build a link to `/documents/{documentId}/review`.
   - Added `extractAllStatementTransactions(entityId)`: `requireAuth()` first line, queries
     `bankStatement.findMany({ where: { entityId, archivedAt: null, documentId: { not: null } },
     include: { document: { select: { id, extractionStatus } } } })`, filters to statements
     whose linked Document has never been extracted or last failed
     (`!s.document || !s.document.extractionStatus || s.document.extractionStatus === "failed"`),
     runs `triggerExtraction(s.documentId!)` (imported from `@/actions/documents`) through
     `runWithConcurrencyLimit(list, 4, ...)` — same bound `retryAllPendingStatementExtractions`
     uses. Returns `{ attempted, succeeded, failed }`. `revalidatePath("/business")`.
     Deliberately extraction-only — creates zero `Transaction` rows.

2. **`actions/documents.ts`**
   - `getDocumentWithExtraction` now also selects `bankStatement: { select: { accountId: true } }`
     alongside the existing `entity: true` include — purely additive.
   - Fixed the stale `revalidatePath("/personal/transactions")` → `revalidatePath("/transactions")`
     in `importStatementTransactions` (that route doesn't exist anywhere in `app/`; the real
     transactions list is `app/transactions/page.tsx`).

3. **`app/documents/[id]/review/page.tsx`**
   - Added `searchParams: Promise<{ bucket?: string }>` (matches the `/accounts?bucket=` /
     `/transactions?bucket=` convention already used elsewhere in the repo).
   - When `bucket` resolves via `getEntityBySlug`, the breadcrumb changes to
     `Business / {entityLabel} / Bank Statements / Review extraction` (linking back to
     `/business/{bucket}/statements`) instead of the generic `Documents` breadcrumb/link. Falls
     back to today's behavior when `bucket` is absent. (Note: the middle `{entityLabel}` segment
     is a plain `<span>`, not a link — there is no `app/business/[slug]/page.tsx` index route to
     link to; confirmed by listing the directory. This matches the exact same non-linked-label
     convention the statements page itself already uses for its own breadcrumb.)
   - For `doc.docType === "bank_statement"`, fetches `listEntityAccounts(doc.entityId)` (already
     exported from `@/actions/bank-statements`) and passes it as a new `accounts` prop to
     `DocumentReviewClient`, plus `defaultAccountId={doc.bankStatement?.accountId ?? null}`.
   - The "Skip"/"Back" links and the skip-form's post-skip `redirect()` now also route back to
     the resolved `backHref` (statements page when arriving with `?bucket=`, `/documents`
     otherwise) instead of always hardcoding `/documents`.

4. **`components/documents/document-review-client.tsx`**
   - Added optional props `accounts?: { id; nickname; mask }[]` and `defaultAccountId?: string
     | null`. `accountId` state now initializes from `defaultAccountId ?? ""`.
   - When `accounts` is provided and non-empty, renders a real `<select>` (`nickname (···mask)`,
     matching `statements-table.tsx`'s existing account-select option format) instead of the raw
     "paste an account UUID" text input. Falls back to the original text input when `accounts`
     isn't supplied, so every other document-type review flow through this shared component
     (W2, 1099, insurance, utility bills — none of which have `transactionRows`, so this section
     doesn't render for them) is unaffected.

5. **`components/bank-statements/statements-table.tsx`**
   - New `entitySlug: string` prop, threaded down to `StatementRowItem`.
   - New `hasDocuments` check (`statements.some((s) => s.documentId)`) gates a new header button,
     "Extract transactions for all statements", calling `extractAllStatementTransactions(entityId)`
     and showing a result summary — copies the existing `handleParseAll`/"Parse All Pending"
     pattern exactly (separate `useTransition`, separate result-message state, `router.refresh()`
     on completion).
   - Per statement row, when `statement.documentId` is truthy, added a link
     `/documents/{documentId}/review?bucket={entitySlug}` labeled "Extract & import transactions →".
     Not gated on `extractStatus` (transaction-row extraction is orthogonal to balance extraction).

6. **`app/business/[slug]/statements/page.tsx`**
   - Passes the new `entitySlug={slug}` prop to `<StatementsTable>`.

## Deviations from the plan

One small, justified deviation from the plan's literal breadcrumb wording: the plan said "change
the breadcrumb/back-link to the originating business statements page" with an implied
`Business / {entityLabel} / Bank Statements` chain. I built that chain, but made the middle
`{entityLabel}` segment plain text rather than a link to `/business/{bucket}`, because that route
doesn't exist (`app/business/[slug]/` has no `page.tsx` — only `balance-sheet`, `cash-flow`, `gl`,
`mileage`, `pl`, `revenue`, `statements`, `vendors` subroutes; confirmed by listing the directory).
Linking to it would have been a real 404. The statements page's own existing breadcrumb
(`app/business/[slug]/statements/page.tsx`) already treats its `{entityLabel}` segment as
non-linked plain text for the exact same reason — I matched that established convention rather
than inventing a new one or introducing a broken link.

No other deviations. Every other file/behavior matches the plan's ordered steps exactly.

## Commands run and their results

- `pnpm typecheck` (`tsc --noEmit`) — clean, no errors.
- `pnpm lint` — **0 errors, 47 warnings**, same pre-existing baseline as the last several sessions
  in this repo (per agent memory). The two warnings that land inside my touched
  `components/documents/document-review-client.tsx` (`'entityId' is defined but never used` at
  what is now line 38; a ternary-as-statement `no-unused-expressions` warning inside the
  pre-existing, untouched `toggleRow` function) are both **pre-existing** — confirmed by
  re-reading the original file before editing: `entityId` was already destructured and unused in
  the original `Props`, and `toggleRow`'s `next.has(i) ? next.delete(i) : next.add(i);` body is
  code I never touched, just shifted a few lines down by my additions above it. No new warnings
  introduced anywhere, including in the other 5 touched files (none of which appear in the lint
  warning list at all).
- `pnpm test` (`vitest run`) — **736/736 passed across 52 files**, no regressions, no new test
  files (correct per the plan's own "Test expectations" section: this is a wiring task with no new
  pure-logic module — `actions/` has zero dedicated Vitest files anywhere in this repo, and
  `components/` has no DOM/component test infra). Explicitly confirmed the three files the
  acceptance criteria named as "must pass unmodified": `lib/__tests__/doc-extract.test.ts` (6
  tests, includes the `extractDocument — bank_statement` coverage), `lib/__tests__/
  bank-statement-extract.test.ts` (6 tests), `lib/__tests__/bank-statement-upload.test.ts` (12
  tests) — all passed, confirming `lib/bank-statement-extract.ts` was genuinely untouched.
- `git status --short` before and after the live verification step below — confirmed only the 6
  planned files show as modified, no `prisma/migrations/` changes, and no stray temp files were
  left behind after cleanup.

### Live re-verification (real EKC data, read-only, no DB mutation)

Per the task's instruction to personally re-confirm the Planner's live smoke test still works
after my wiring changes, I wrote a temporary, read-only script
(`scripts/_tmp-verify-bank-statement-wiring.ts`, deleted immediately after running — confirmed via
`git status` both before and after) that re-runs the **exact same code path**
`triggerExtraction()` now wires up (`downloadDocumentFile` → `classifyDocType` →
`extractDocument`) against a real EK Consulting `BankStatement`/`Document`, without ever calling
`db.document.update` (i.e., without actually triggering the real extraction-write side effect —
that's still Eric's action to take via the new UI, not mine to do to production data).

Result — same statement (`90b56615-...`, Nov 28–Dec 27 2025 period) and same output as the
Planner's grounding smoke test:
- Downloaded 178,525 bytes, genuine `%PDF-` header, via `downloadDocumentFile`'s
  `"statements/"` → taxes-bucket routing (confirms that pre-existing routing logic this plan
  depends on is still intact).
- `classifyDocType("bank_statement", fileKey)` → `"bank_statement"`.
- `extractDocument(...)` returned 2 `transactionRows`: `Interest Earned Credit`, +$0.01 (2025-11-28);
  `XFINITY MOBILE Purchase`, -$123.20 (2025-12-22) — matches the plan's grounding section exactly.

A second temporary read-only script confirmed, after the verification run above, that
`db.transaction.count({ entityId: <ek-consulting> })` is still **0** and zero EKC `bank_statement`
`Document` rows have a non-null `extractionStatus` — i.e., my verification made no real writes to
production, and the "still needs Eric's action" items below remain genuinely outstanding, not
silently done as a side effect of my testing.

## Open items

None outside the plan's own explicitly-flagged, deliberately-deferred items (see Findings below,
restated from the plan). Nothing I found during implementation contradicts or extends the plan —
it was accurate and complete as written.

## Findings (restated from the plan — what's unblocked vs. what still needs Eric's action)

**Unblocked by this change, once shipped/deployed:**
- All 12 EK Consulting bank statements are immediately ready to extract — no account-assignment
  gap exists for this entity (all 12 already have `accountId` set to the single "QuickBooks
  Checking" ···2043 account).
- Real `Transaction` rows can now be created for EK Consulting, sourced from statements already in
  storage, with the same dedup discipline (`accountId` + `postedAt` + `amount` + `payeeNormalized`)
  `importStatementTransactions` already applies to every other import path in the app.
- Once real transactions exist, `lib/tax-compute-build.ts`'s `scheduleCDataMissing` flag and
  `computePL` become able to see real activity for the first time (subject to the GL-coding caveat
  immediately below) — neither of those files was touched by this task, but this task's output is
  exactly the input they were missing.

**Still needs Eric's action after this ships (explicitly, not silently deferred):**
1. **Run extraction on all 12 EKC statements** — via the new bulk "Extract transactions for all
   statements" button on `/business/ek-consulting/statements`, one click, but each statement is a
   real Claude API call, not instant.
2. **Review and select rows to import, per statement**, at
   `/documents/{id}/review?bucket=ek-consulting` — extraction quality was only spot-checked on one
   statement (both by the Planner's original grounding test and my own re-verification above);
   some rows across the other 11 statements may be ambiguous or misparsed and should be visually
   checked against the PDF before import, not blindly bulk-imported.
3. **GL-code the newly-imported transactions** at `/business/ek-consulting/gl` — confirmed by
   reading `lib/reports.ts#computePL`: it filters `glCodeId: { not: null }`, and every
   freshly-imported transaction lands with `glCodeId: null` (same as any manually-entered
   transaction). **Importing transactions alone does not make Schedule C/the P&L page real** —
   they stay invisible to `computePL` and the P&L page until GL-coded. This is the single most
   important "not actually done yet" caveat.
4. **Whether to extend this to future statements automatically** is still an open, undecided
   product question — `finalizeStatementUpload` was deliberately left unchanged, so any statement
   uploaded after this ships still only gets balance extraction automatically; transaction-row
   extraction requires clicking "Extract & import transactions" (or the bulk button) same as for
   the 12 existing ones.
5. Sudden Valley PM LLC has zero `BankStatement` rows today, so this feature has nothing to act on
   for that entity yet — not a gap in this implementation, just a fact about current data (it
   already has 139 real `Transaction` rows from another source).

**Known, pre-existing gaps this task deliberately did not fix (per the plan's explicit scope
lines, flagged not silently worked around):**
- `payeeNormalized` in `importStatementTransactions` is set from `row.description.slice(0, 100)`
  directly, not run through `lib/tags.ts#normalizePayee()` — tag-rule auto-matching may not fire
  as expected on these imported rows.
- The dedup check in `importStatementTransactions` doesn't filter `archivedAt: null` on the
  candidate duplicate `Transaction` — a future archived-and-reimported transaction could produce a
  surprising "skipped as duplicate" result.
- No per-statement "already has extracted/imported transactions" indicator on the statements
  table — Eric has to click through to the review page to find out (not a data-integrity issue;
  the dedup check prevents double-import either way).
- `lib/doc-extract.ts`'s `bank_statement` extraction shape is single-account only (no per-account
  array like `lib/bank-statement-extract.ts`'s balance-extraction path has) — fine for EKC's
  real, single-account statements, but a future multi-account statement PDF from another entity
  would get a muddled single-account extraction from this path.

## Files touched

- `D:\Repos\Personal\kinniburgh-finance\actions\bank-statements.ts`
- `D:\Repos\Personal\kinniburgh-finance\actions\documents.ts`
- `D:\Repos\Personal\kinniburgh-finance\app\documents\[id]\review\page.tsx`
- `D:\Repos\Personal\kinniburgh-finance\components\documents\document-review-client.tsx`
- `D:\Repos\Personal\kinniburgh-finance\components\bank-statements\statements-table.tsx`
- `D:\Repos\Personal\kinniburgh-finance\app\business\[slug]\statements\page.tsx`

No `prisma/migrations/` changes — confirmed via `git status`, matching the plan's confirmation
that every field this plan writes to already existed in the schema.
