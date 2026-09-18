# Request: Credit card statement upload, parse, and transaction import

Eric: "All expenses for EK Consulting were either paid through the QuickBooks checking account (bank
statements, already built) or were charged to the Capital One credit card." He wants the same
upload-individually-or-as-a-folder → parse → import-transactions capability the bank statement feature
already has, applied to credit card statements.

## The real complication (confirmed directly with Eric before writing this request)

**The only "Capital One card" `Account` in the app today is assigned to the Personal entity**
(`prisma/seed.ts`, "Credit cards — all autopay from x2631"). Eric confirmed live: this is the *same*
personal Capital One card, used for **mixed personal and EK Consulting business spending** — not a
separate business-only card. This is a real, structural difference from the bank statement feature,
where every statement's account already belongs cleanly to one entity.

**Implication: importing a credit card statement's transactions can't just inherit the account's entity
(Personal) the way `importStatementTransactions` does for bank statements today** — some of those
charges are genuinely EK Consulting business expenses and need `entityId` = EK Consulting, not Personal.
The import/review flow needs a per-transaction way to mark "this charge is an EK Consulting business
expense" (defaulting to Personal, the account's own entity, for everything else) — not a bulk
all-or-nothing entity assignment. Read `actions/transactions.ts` yourself to confirm there's no existing
generic "reassign an already-created transaction's entity" action — if you find you need one, decide
whether to build it as a general tool or scope it narrowly to this import flow's own review step
(prefer narrow — no evidence a general reassignment tool is needed elsewhere yet).

## Second real complication: charges vs. payments, and double-counting

A credit card statement's line items are a mix of **charges** (purchases — real, unique expenses that
belong on Schedule C once tagged/GL-coded) and **payments** (money paid to Capital One from the checking
account — which is *already* captured as its own outflow transaction when that checking account's bank
statement gets imported). If a credit-card-statement "payment received" line item gets imported as its
own transaction too, that's the same real-world cash movement recorded twice under two different
transactions. Read `lib/doc-extract.ts`'s existing `bank_statement` extraction prompt (and its
`TransactionRow`/sign-convention doc comments) before designing this — decide, and clearly justify,
whether credit-card statements need their own extraction prompt variant that distinguishes charges from
payments (so payments can be excluded from import, or clearly flagged rather than silently imported as a
second real expense), or whether the existing generic prompt already produces distinguishable enough
data. Do not guess a sign convention or silently import payment line items as expenses — get this
provably right or stub/flag it for manual review, matching this repo's established stub-vs-guess
discipline for anything touching real financial data.

## What to build

1. Credit card statement upload — single and folder/multiple, mirroring the bank statement upload UI/UX
   exactly (`components/bank-statements/*`, `actions/bank-statements.ts`'s
   `requestStatementUploadSlot`/`finalizeStatementUpload` two-phase direct-to-storage pattern). Decide
   whether this reuses the existing `BankStatement` model (it's already generic — periodStart/End,
   accountId, opening/closing balance, extractionData — nothing about it is checking-account-specific)
   or needs its own distinct model/table; justify whichever you choose. If reusing `BankStatement`, no
   new Prisma migration should be needed; if a genuinely new field/model is warranted, flag it clearly
   and do not push any resulting migration without Eric's explicit confirmation (established convention
   in this repo — push = deploy = migrate).
2. Extraction — parse the statement into period/balance summary (existing balance-confirmation pattern)
   plus transaction line items (existing `lib/doc-extract.ts` transaction-row pattern), correctly
   distinguishing charges from payments per the complication above.
3. Review/import flow — reuse the just-shipped merged "Confirm extraction & import N transactions"
   single-button flow from `components/documents/document-review-client.tsx` (don't rebuild a parallel
   one) but extend it with the per-transaction entity-assignment control this task's first complication
   requires. Selected/flagged "business expense" rows import with `entityId` = EK Consulting; everything
   else imports with the account's own entity (Personal). Payment line items excluded/flagged per
   complication two.
4. The existing "Next statement →" / "Back to statements" navigation, Archive, Edit, etc. from the
   bank-statement flow should work the same way for credit card statements — reuse, don't duplicate.

## Ground rules

- `Decimal`/cents for all money math. `requireAuth()` first line of any new/changed server action.
- Never silently guess which entity a charge belongs to, and never silently double-count a payment as an
  expense — both are real-money correctness risks, not cosmetic ones.
- No Prisma migration without explicit confirmation before any push.
- Don't touch the IRS-receipt-threshold auto-flagging feature — that's a separate, follow-on task
  (`.claude/pipeline/receipt-threshold-auto-flag`, or wherever it lands) that will apply to whatever this
  task ships, but this task's own scope stops at "transactions imported correctly, into the right
  entity, without double-counting."

## Required findings section

State plainly in the plan: which entity/account a newly-uploaded credit card statement's transactions
land in by default, exactly how a transaction gets marked "EK Consulting business expense" instead, and
exactly how payment line items are prevented from becoming duplicate expense transactions. If any of the
three isn't fully resolved, say so explicitly rather than leaving it implicit.
