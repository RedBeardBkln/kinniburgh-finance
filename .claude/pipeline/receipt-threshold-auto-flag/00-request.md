# Request: Auto-flag transactions needing a receipt into Receipts > Needs Review

Eric: any imported transaction over the IRS receipt threshold should automatically show up on
Receipts > Needs Review. From there, attaching a receipt and saving should move it off that page and
tie it to the matching transaction, where the GL code gets assigned via the tag attached to the
transaction. This should apply to both bank-statement-imported and credit-card-imported transactions.

**Depends on**: `.claude/pipeline/credit-card-statement-import/` (read its full trail — request through
review — before starting; this task applies to whatever that one shipped, for both bank and credit card
imports uniformly).

## The real threshold (already researched and cited — read before doing anything else)

`specs/10-receipt-substantiation-threshold.md` — the real IRS figure is **$75** (Pub. 463 / Treas. Reg.
§1.274-5(c)(2)(iii)), not $250. An existing checklist item had the wrong number (already fixed
elsewhere tonight, unrelated to this task) by conflating it with IRC §170(f)(8)'s charitable-donation
rule. Cite that spec file for the constant; do not re-derive or hardcode $75 without citing it.

## What exists today (read before starting — most of the hard part is already built)

- `Receipt` model (`prisma/schema.prisma`) — `fileKey` is **required** (not nullable). A `Receipt` row
  can't exist without an actual uploaded file. This matters: a "flagged transaction with no receipt yet"
  is NOT the same thing as a `Receipt` row — don't try to create placeholder `Receipt` rows with no file.
- `actions/receipts.ts#listReceipts({tab: "review"})` — the existing "Needs Review" query
  (`ocrStatus: "complete", confirmedAt: null`) that already powers `/receipts?tab=review`
  (`app/receipts/page.tsx`, tab slug `"review"`, label "Needs Review" — this is literally the page Eric
  means).
- `actions/receipts.ts#confirmReceipt` — **already does exactly the tie-in Eric described**: given a
  `transactionId` and `tagIds`, it sets `Transaction.receiptId`, applies the tags via
  `updateTransactionTags`, and upserts a `TagRule` for the vendor. GL-code resolution from a tag is a
  separate, already-shipped mechanism (`lib/gl-code-resolver.ts`) that fires off the tag, not something
  this task builds. **This task's job is getting a transaction that needs a receipt to visibly show up
  on the Needs Review page and get a receipt attached to it — not rebuilding the tag/GL tie-in, which
  already exists.**
- `actions/receipts.ts#findMatchingTransactions` — existing amount/date-window matching, for the
  opposite direction (receipt-first, matching to a transaction). Read it for the matching-window pattern
  (±7 days, ±2% amount) even though this task's flow runs the other direction (transaction-first).
- `app/api/receipts/upload/route.ts` — the real upload path (plain multipart POST, not the two-phase
  signed-URL pattern the tax-document/bank-statement uploads use — receipt images are small enough).
  Creates the `Receipt` row, uploads the file, runs OCR (`lib/receipt-extract.ts`), best-effort — OCR
  failure doesn't block the receipt from existing, just leaves `ocrStatus: "failed"`.

## What to build

1. A way to identify "transactions that need a receipt" for a business entity: `entityId` in scope
   (EK Consulting today; keep it general to any business entity, not hardcoded), `Math.abs(amount) >=
   7500` cents, `archivedAt: null`, `receiptId: null`, and — decide and justify — whether an explicit
   per-transaction "no receipt needed" override/dismissal should exist (a real expense can legitimately
   never get a receipt, e.g. a bank fee) so the queue doesn't become permanently cluttered with
   unresolvable items. If you build a dismissal mechanism, it needs its own field/flag (check whether
   `Transaction` needs a small additive nullable column for this, or whether it can be modeled without
   one — prefer no-migration if a reasonable design allows it, flag clearly if not).
2. Surface these on `/receipts?tab=review` alongside the existing uploaded-but-unconfirmed `Receipt`
   rows — both belong on "Needs Review," but they're different kinds of items (one has an uploaded file
   already, one doesn't) and should look different in the UI accordingly. Decide the merge/sort order.
3. An "Attach receipt" action from that page for a flagged transaction — uploads a new file (reuse
   `/api/receipts/upload`'s pattern, or extend it with an optional `transactionId` so the receipt is
   pre-filled from the transaction's own known `payeeRaw`/`postedAt`/`amount` instead of relying solely
   on OCR guessing them — more reliable, and still runs OCR for whatever extra detail it can get, e.g.
   itemization). On save, this should end up calling (or replicating) `confirmReceipt`'s existing
   transaction-tie-in so GL-code-via-tag resolution fires the same way it already does for the
   receipt-first flow — don't build a second, divergent tie-in path.
4. Apply the same flagging logic to transactions from **both** the bank-statement import path
   (`actions/documents.ts#importStatementTransactions`) and the credit-card import path this task
   depends on — a single shared query/helper, not two copies.
5. Scope to business entities only — per CLAUDE.md, personal-finance receipts aren't an IRS
   business-deduction substantiation concern in the same way; don't flag Personal-bucket transactions.

## Ground rules

- Cite `specs/10-receipt-substantiation-threshold.md` for the $75 figure; never hardcode or restate it
  without that citation, so a future tax-year/rule change has one place to update.
- `Decimal`/cents for all money math. `requireAuth()` first line of any new/changed server/API action.
- No Prisma migration without explicit confirmation before any push.
- Don't rebuild `confirmReceipt`'s tag→GL-code tie-in — reuse it.
- Ground rule 8 (no financial/tax advice): frame this as "flagged for your review," not as a claim that
  the transaction definitely requires a receipt for IRS purposes in every case — the $75 line has the
  scope caveat documented in specs/10, and this app doesn't know the expense category well enough in
  every case to assert IRS compliance with certainty.

## Required findings section

State plainly in the plan: the exact query that identifies a "needs receipt" transaction, whether a
dismissal/override mechanism exists and how (with migration status if any), and confirm the GL-code
tie-in genuinely reuses `confirmReceipt` rather than reimplementing it.
