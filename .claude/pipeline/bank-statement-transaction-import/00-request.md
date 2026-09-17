# Request: Extract transaction line items from bank statements + import as real Transactions

**This is the single biggest blocker to a real 2025 Schedule C** (confirmed by Eric directly, live,
2026-09-17): Eric Kinniburgh Consulting LLC's QuickBooks subscription was recently cancelled, so its
books are no longer tracked there — the plan going forward is for this app to derive EKC's bookkeeping
from bank statements instead. EKC's bank statements are already uploaded and "parsed" in the app, but
`lib/tax-compute-build.ts`'s `buildPersonalTaxComputeInput` found live that EK Consulting has **zero
`Transaction` rows of any kind** — because the parsing that ran only extracts account-level opening/
closing balances (`lib/bank-statement-extract.ts`'s `ExtractedStatement`, used by
`actions/bank-statements.ts`'s period-balance-sheet feature), never individual transaction line items.

## Root cause (confirmed by reading the code, not guessed)

- `actions/bank-statements.ts#finalizeStatementUpload` creates both a `BankStatement` row (period
  reconciliation) and a linked `Document` row (`docType: "bank_statement"`) for the same upload.
- `lib/bank-statement-extract.ts#extractBankStatement`'s prompt only asks for `summary`,
  `periodStart`/`periodEnd`, and per-account `openingBalanceCents`/`closingBalanceCents` — no line items.
  Its result is written to `BankStatement.extractionData`, never to the linked `Document.extractionData`.
- A *different*, older path exists — `lib/doc-extract.ts`'s `bank_statement` docType prompt *does* extract
  `transactionRows` (`{ date, description, amountCents }[]`), and `actions/documents.ts#
  importStatementTransactions(documentId, selectedIndices, accountId)` already knows how to turn selected
  rows into real `Transaction` records with dedup (checks for an existing matching
  accountId/postedAt/amount/payeeNormalized before creating). But this path is driven from the generic
  `/documents/[id]/review` flow and was never run against EK Consulting's statements — and even if it
  had been, the `BankStatement`-flow documents never got `Document.extractionData` populated at all (see
  above), so there'd be nothing for it to find.

## What to build

1. Add transaction-line-item extraction for bank statements, reusing the real PDF bytes already in
   storage (`Document.fileKey` via `downloadTaxFile`/`downloadDocumentFile` — check which helper this
   context needs) — **no re-upload required**. Decide (and justify in the plan) whether this extends
   `lib/bank-statement-extract.ts`'s existing prompt/shape (risk: touches a shipped, working
   reconciliation feature) or adds a new, separate extraction function/pass specifically for transaction
   rows (safer — doesn't touch the balance-extraction code path other business logic already depends on).
   Match the existing `{ date, description, amountCents }` row shape used elsewhere in the codebase
   (`doc-extract.ts`'s `TransactionRow`) for consistency, not a new one.
2. Store the extracted rows somewhere real (`BankStatement.extractionData` already exists as a flexible
   `Json?` — decide whether to merge transaction rows into it alongside the existing balance summary, or
   use a distinct field/shape; no Prisma migration needed for either if reusing the existing Json column,
   but flag clearly if you find a reason a new column is actually warranted, and don't push a migration
   without the owner's confirmation per this repo's established convention).
3. Build the import flow: given a statement's extracted transaction rows, create real `Transaction`
   records for the right account/entity, with the same dedup discipline `importStatementTransactions`
   already uses (never double-import). Needs an `accountId` — check how `BankStatement.accountId` is
   populated today (via `confirmBankStatement`) and whether every EK Consulting statement already has one
   assigned; if not, that's a real gap to surface, not silently guess an account.
4. Trigger mechanism for already-uploaded EKC statements: since `extractStatus: "complete"` statements
   are excluded from the existing `retryAllPendingStatementExtractions` bulk retry, decide how the user
   (or this task, safely) gets transaction rows extracted for statements that already have a balance
   summary — a new explicit action/button is likely cleaner than overloading the existing retry semantics
   (which has its own meaning: "the balance extraction itself failed"). Your call, justify it.
5. Minimal UI surface so Eric can actually trigger this and see the result — likely on the existing
   business bank-statements page/component (find it: search for where `listBankStatements`/
   `BankStatementRow` is rendered) — a "Extract & import transactions" action per statement, or a bulk
   "import all" per entity. Read the existing statements-list component before designing new UI, match
   its patterns.
6. This directly unblocks `lib/tax-compute-build.ts`'s `scheduleCDataMissing` flag — once real EKC
   transactions exist (ideally GL-coded, though GL-code tagging itself is a separate, already-existing
   workflow at `/business/[slug]/gl` this task doesn't need to rebuild), `computePL`/`buildGaps` should
   naturally pick up real numbers. This task's job is getting real `Transaction` rows to exist; it does
   NOT need to also auto-assign GL codes (that's the existing tag→GL-code mapping feature, out of scope
   here) — though flag in the plan if leaving transactions un-GL-coded means Schedule C still can't
   compute (check `computePL`'s actual behavior for un-coded transactions before assuming).

## Ground rules

- Never fabricate a transaction. If extraction can't confidently parse a row (ambiguous date/amount),
  surface it for the user to review/confirm rather than silently including or silently dropping it —
  mirror the dedup/review discipline already established in `importStatementTransactions` and
  `document-review-client.tsx`.
- `Decimal`/cents for all money math, per CLAUDE.md.
- `requireAuth()` first line of any new/changed server action.
- No Prisma migration without flagging it clearly and getting the owner's confirmation before any push.
- Don't touch `lib/tax-compute.ts`, `lib/tax-compute-build.ts`, or the GL-code mapping feature — this
  task's job stops at "real Transaction rows exist for EK Consulting, ready for the existing GL-mapping
  workflow to tag."

## Required findings section

Same pattern as prior tasks in this trail: explicitly enumerate what data now exists/what still needs
Eric's action (e.g., "assign accounts to N statements missing one," "GL-code the newly-imported
transactions at /business/ek-consulting/gl," "review M rows extraction couldn't parse confidently").
