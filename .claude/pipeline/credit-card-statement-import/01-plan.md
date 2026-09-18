# Plan: Credit card statement upload, parse, and transaction import

## Restated goal

Give the Capital One credit card (and, generically, any other credit-card-type account) the same
upload → parse → review → import-transactions capability the bank-statement feature already has for
checking accounts, while correctly handling two real complications: the card is a Personal-entity
account used for a mix of personal and EK Consulting LLC business spending, and a card statement's
"payment" line items are the same real cash movement already captured on the checking account's own
statement, not a second real expense.

## Required findings (per the request's mandate — stated plainly, not left implicit)

1. **Which entity/account does a newly-uploaded credit card statement's transactions land in by
   default?** The account's own entity — i.e. `Account.entityId` (Personal, for the Capital One card),
   exactly like today's `importStatementTransactions` behavior for bank statements. No change to the
   default; only an *optional* per-row override (below).
2. **Exactly how does a transaction get marked "EK Consulting business expense" instead?** A new,
   second per-row checkbox in `document-review-client.tsx` (rendered only when the reviewed document's
   `entity.type === "personal"`), collected into a `businessExpenseIndices: number[]` array passed to an
   extended `importStatementTransactions(documentId, selectedIndices, accountId, businessExpenseIndices)`.
   The server resolves EK Consulting's entity id itself via `getEntityBySlug("ek-consulting")` — **the
   client never supplies an entityId directly**, and the server rejects (throws) any non-empty
   `businessExpenseIndices` when the target account's entity isn't Personal. This is a narrow extension
   of the existing narrow action, not a new generic "reassign a transaction's entity" tool — confirmed by
   reading `actions/transactions.ts` in full: no such action exists today (every entityId is fixed at
   `Transaction` creation time; `updateTransactionTags`/`updateTransactionNotes`/`updateTransactionProject`
   never touch `entityId`).
3. **Exactly how are payment line items prevented from becoming duplicate expense transactions?** A new
   `credit_card_statement` extraction prompt/shape in `lib/doc-extract.ts` (parallel to the existing
   `bank_statement` shape) that tags each row `lineType: "charge" | "payment"`. Rows tagged `"payment"`
   are **excluded from the default import selection** (unchecked, not deleted) and visibly labeled in the
   review UI — the human always has final say per row, matching this repo's existing
   select-before-confirm UX. This is an AI-classification heuristic, not a mathematical proof, so it is
   deliberately fail-closed (default excluded) rather than fail-open.

**A fourth, unrequested-but-load-bearing finding, from a live read-only DB query run while planning this
task (see below):** the real Capital One card `Account` (`id 505a29eb-f6b8-42d0-b40d-87046fdf36ad`,
entityId = Personal `6f55fa50-9d94-47a8-92d6-2cc5abeac714`, `accountType: "credit_card"`) is **already
Plaid-connected** (`integrationMode: "plaid"`) with 76 real, live-synced `Transaction` rows, `source:
"plaid"` on every one, covering **2026-04-02 through 2026-09-15 only** (today is 2026-09-18). This
materially changes the risk profile and the practical purpose of this feature:

- The PDF-statement-upload feature is **not redundant** with Plaid — its real value is backfilling
  **pre-2026-04 history** (critically, all of calendar year 2025, the tax year currently being built out
  per `specs/09-tax-year-2025-constants.md`), which Plaid's sync window doesn't reach. This mirrors
  exactly what already happened for EK Consulting's own QuickBooks Checking account: its 22 real
  `Transaction` rows (all `source: "import"`, Jan–Sep 2025, including several real
  `"CAPITAL ONE-CRCARDPMT"` outflow rows, e.g. **-$1,308.46 on 2025-01-14**, **-$2,941.60 on
  2025-02-13**, **-$1,593.50 on 2025-03-13**) came entirely from the already-shipped bank-statement
  import feature, not Plaid.
- Those same three dollar amounts are the *concrete, real* version of the "payment double-counting" risk
  the request describes: if a Capital One statement covering the same periods is uploaded and its
  matching "payment received" line items are imported too, the household's ledger gets two untied
  `Transaction` rows (one on EK Consulting's checking account, one on the Personal-owned Capital One
  account) for the same real cash movement, with no `transferPairId` linking them (unlike the app's own
  internal `createTransferPair` transfers) and no `glCodeId` filter protecting downstream figures that
  read raw `Transaction.amount` (e.g. `checkLargeSpend`, `checkAnomalies`, `checkBudgetOverspend` in
  `lib/notifications.ts`, all of which ignore GL-coding status).
- A **second, distinct** real duplicate-risk: if a credit card statement covering **April 2026 or later**
  is ever uploaded (overlapping the live Plaid sync window), its *charge* rows risk being genuine
  duplicates of already-synced Plaid transactions too — not just payment rows. The existing dedupe check
  in `importStatementTransactions` (`accountId` + `postedAt` + `amount` + `payeeNormalized` exact match)
  is unreliable here: real Plaid merchant strings (`"Ueni"`, `"Google Workspace"`, `"Ollama"`) will not
  text-match a PDF statement's own printed description, so this dedupe would likely **fail to catch**
  such a duplicate. This plan adds a narrowly-scoped mitigation (a warning + default-exclusion, not a
  hard block) for exactly this case — see Approach step 5.

## Scope

**In scope:**
- Credit-card statement upload (single + folder/batch), reusing `BankStatement`/`Document` and the
  existing two-phase direct-to-storage upload flow unchanged.
- A new `credit_card_statement` extraction prompt/shape in `lib/doc-extract.ts` that classifies each
  transaction row as `charge` or `payment`.
- Per-row "EK Consulting business expense" import-time override, scoped to documents belonging to the
  Personal entity (general to any Personal-entity account, not hardcoded to the Capital One card
  specifically — see Risks for why).
- Default-exclude + visible-flag treatment for (a) rows tagged `payment` and (b) rows whose date falls
  within an account's already-synced Plaid coverage window.
- A reachable entry point for Personal to use this feature at all (today the Bank Statements page/nav
  item only exists for business-bucket entities — Personal has none).
- Small, targeted copy/breadcrumb fixes needed because Personal will now use a page that was written
  assuming a business entity.

**Out of scope (explicitly not doing):**
- Not touching the IRS-receipt-threshold auto-flagging feature (per the request's ground rules).
- Not building a generic "reassign any transaction's entity after the fact" tool. The business-expense
  override only applies at first-import time via `importStatementTransactions`; there is no way in this
  plan to retroactively change an already-imported transaction's `entityId` (would require deleting and
  re-importing with the flag set correctly, or a future dedicated edit action — flagged, not built).
- Not adding a way to flag an already-Plaid-synced Capital One transaction (the 76 rows from
  2026-04-02 onward) as an EK Consulting business expense. That's a real, closely-related, genuinely
  anticipated follow-on need (Eric will very likely want the same capability for ongoing Plaid-synced
  card activity, not just historical PDF backfills) but it's a different mechanism (an edit path on
  already-existing `Transaction` rows, not an import-time flag) and no evidence it's needed *now* beyond
  this reasonable inference — flagged as a recommendation, not built.
- No Prisma schema change / migration. `BankStatement`, `Document`, `Account`, and `Transaction` are all
  already generic enough (confirmed by reading `prisma/schema.prisma` in full — `Transaction.entityId`
  is already independent of `Transaction.account.entityId` at the schema level; nothing enforces they
  match, and `actions/income-sources.ts`/`actions/paystubs.ts` are the only places that *choose* to
  enforce that invariant for their own models, not `Transaction`).
- Not fixing the pre-existing, unrelated bugs found in passing: `importStatementTransactions`'s
  `payeeNormalized` doesn't route through `lib/tags.ts#normalizePayee()` (flagged, not fixed — a
  pre-existing inconsistency across the whole bank-statement-import feature, not something introduced or
  worsened here); the "Linked account — auto-match by last 4 digits" upload-form label has never had any
  backing auto-match logic (confirmed by grep — flagged, not fixed); GL-coding imported transactions is
  still a separate manual step after import (pre-existing, unchanged).

## Affected files/modules

New:
- `lib/statement-review.ts` — new pure module (`defaultImportSelection`, `isWithinPlaidCoverage`,
  `needsCreditCardReclassification`), no DB, no `"use server"`.
- `lib/__tests__/statement-review.test.ts` — unit tests for the above.

Modified:
- `lib/doc-extract.ts` — add `"credit_card_statement"` to `DocType`, add its prompt to `PROMPTS`, add
  `lineType?: "charge" | "payment"` to `TransactionRow`.
- `lib/__tests__/doc-extract.test.ts` — new `describe("extractDocument — credit_card_statement")` block.
- `actions/documents.ts` — `triggerExtraction` (dynamic docType override based on linked account type),
  `importStatementTransactions` (new `businessExpenseIndices` param), `getDocumentWithExtraction`
  (extend the `bankStatement` include to reach `account.accountType`).
- `actions/bank-statements.ts` — `listEntityAccounts` (add `plaidCoverageStart` per account),
  `extractAllStatementTransactions` (widen its re-extraction filter using
  `needsCreditCardReclassification`).
- `app/documents/[id]/review/page.tsx` — widen the auto-trigger-extraction condition (same signal as
  above); compute `canFlagBusinessExpense`; entity-type-conditional breadcrumb; pass new props down.
- `components/documents/document-review-client.tsx` — new props (`canFlagBusinessExpense`,
  per-account `plaidCoverageStart` via the existing `accounts` prop), default-selection logic moved to
  `defaultImportSelection`, new "EK Consulting business expense" checkbox column, payment/Plaid-overlap
  row badges, updated `handleConfirm` call.
- `app/business/[slug]/statements/page.tsx` — entity-type-conditional breadcrumb; generalize
  "Bank Statements" copy to "Statements" (the page now serves credit-card statements too, for Personal).
- `components/bank-statements/statement-upload-form.tsx` / `statements-table.tsx` — same copy
  generalization; add a short hint near "Linked account" recommending selecting the account up front for
  credit-card statements (this is what makes the charge/payment split and the entity-override control
  available at all — see Risks).
- `components/app-sidebar.tsx` — add a "Statements" entry to `personalItems`, pointing at
  `/business/personal/statements` (the existing generic route already resolves any entity by slug,
  confirmed by reading `app/business/[slug]/statements/page.tsx` — no new route file needed).

Not modified (confirmed compatible as-is): `prisma/schema.prisma`, `lib/bank-statement-extract.ts`
(balance-only pipeline already handles credit-card negative balances — confirmed via its own prompt text
and `lib/__tests__/period-balance-sheet.test.ts`'s existing `accountType: "credit_card"` fixtures),
`lib/bank-statement-upload.ts`, `actions/bank-statements.ts`'s upload/finalize/confirm/archive functions.

## Approach

1. **Extend `lib/doc-extract.ts`.** Add `"credit_card_statement"` to the `DocType` union and add
   `lineType?: "charge" | "payment"` to `TransactionRow` (optional — every other extraction shape leaves
   it `undefined`, treated as `"charge"` everywhere it's read). Add a new prompt entry mirroring
   `bank_statement`'s shape but with credit-card-specific `data` fields
   (`statementBalanceCents`/`minimumPaymentCents`/`paymentDueDate` alongside the existing
   `accountMask`/`institutionName`/`openingBalanceCents`/`closingBalanceCents`/`periodStart`/`periodEnd`)
   and explicit charge-vs-payment classification rules:
   - Negative `amountCents` = charge/purchase (reduces available credit); positive = payment or
     merchant refund/credit (increases available credit).
   - `lineType: "payment"` **only** for a payment made *to the card issuer* that pays down the balance
     (description patterns like "PAYMENT", "AUTOPAY", "THANK YOU", "ONLINE PYMT").
   - `lineType: "charge"` for every purchase, fee, interest charge, **and merchant refund/credit** (a
     refund is not a payment to the issuer — don't conflate the two just because both can be positive).
   - "If not confident whether a row is a payment-to-issuer vs. a charge, default to `charge`" — a human
     reviews every row before import either way, so a false-negative "payment" (i.e. a real payment that
     gets imported) is the worse failure mode to bias against, not the reverse.

2. **`actions/documents.ts#triggerExtraction`: derive the extraction shape from the *current* linked
   account, not from `Document.docType`.** `Document.docType` stays the literal string `"bank_statement"`
   for every `BankStatement`-linked document regardless of the account's type (deliberate — avoids adding
   a new `docType` value, touching `DOC_TYPES`, `classifyDocType`'s mapped table, or the review page's
   existing `isBankStatement` gate at all). Extend the query:
   ```ts
   const doc = await db.document.findUniqueOrThrow({
     where: { id: documentId },
     include: { bankStatement: { include: { account: { select: { accountType: true } } } } },
   });
   ...
   const docType = doc.bankStatement?.account?.accountType === "credit_card"
     ? "credit_card_statement"
     : classifyDocType(doc.docType, doc.fileKey);
   const result = await extractDocument(buffer, mimeType, docType);
   ```
   This makes correctness depend only on a real DB `Account.accountType` value at the moment extraction
   actually runs — not on whether an account happened to be selected at upload time (which is optional
   today and stays optional; see Risks for the resulting timing gap and its mitigation in step 5).

3. **New `lib/statement-review.ts`** (pure, unit-tested):
   ```ts
   export function defaultImportSelection(
     rows: { date: string; lineType?: "charge" | "payment" }[],
     plaidCoverageStartIso: string | null
   ): number[] {
     return rows
       .map((row, i) => ({ row, i }))
       .filter(({ row }) =>
         row.lineType !== "payment" && !isWithinPlaidCoverage(row.date, plaidCoverageStartIso)
       )
       .map(({ i }) => i);
   }

   export function isWithinPlaidCoverage(dateIso: string, plaidCoverageStartIso: string | null): boolean {
     if (!plaidCoverageStartIso) return false;
     return dateIso >= plaidCoverageStartIso; // ISO YYYY-MM-DD strings compare lexicographically = chronologically
   }

   export function needsCreditCardReclassification(
     accountType: string | null | undefined,
     extraction: { transactionRows?: { lineType?: "charge" | "payment" }[] } | null
   ): boolean {
     if (accountType !== "credit_card") return false;
     const rows = extraction?.transactionRows;
     if (!rows || rows.length === 0) return false;
     return rows.every((r) => r.lineType === undefined);
   }
   ```

4. **`actions/documents.ts#importStatementTransactions`: add the business-expense override.** New
   signature:
   ```ts
   export async function importStatementTransactions(
     documentId: string,
     selectedIndices: number[],
     accountId: string,
     businessExpenseIndices: number[] = []
   ): Promise<{ imported: number; skipped: number }>
   ```
   Fetch `account` with its `entity.type`. If `businessExpenseIndices.length > 0` and
   `account.entity.type !== "personal"`, throw (fail closed — this should be unreachable via the normal
   UI, which only renders the checkbox for Personal-entity documents, but the server must not trust the
   client). Resolve EK Consulting's id via `getEntityBySlug("ek-consulting")` (imported from
   `lib/entity.ts`) once, only when needed. Change the row loop to iterate `selectedIndices` directly
   (not a pre-mapped array) so each row's original index is available for the
   `businessExpenseIndices`-membership check; set `entityId = businessExpenseSet.has(i) ? ekEntity.id :
   account.entityId` per row instead of the current single `account.entityId` for every row. The
   existing dedupe check (`accountId`+`postedAt`+`amount`+`payeeNormalized`) is unchanged.

5. **Close the extraction-timing gap with a self-healing, signal-based re-check** (not a blind
   re-run-everything): in `app/documents/[id]/review/page.tsx`, widen the auto-trigger condition from
   `!doc.extractionStatus || doc.extractionStatus === "pending"` to also re-trigger when
   `needsCreditCardReclassification(doc.bankStatement?.account?.accountType, doc.extractionData)` is
   true (i.e. the account is now known to be a credit card, but the stored extraction was produced before
   that was known — no row has a `lineType` at all). Apply the same check inside
   `actions/bank-statements.ts#extractAllStatementTransactions`'s "needs extraction" filter (currently
   `!s.document || !s.document.extractionStatus || s.document.extractionStatus === "failed"` — add the
   `needsCreditCardReclassification` condition as an additional OR-branch, using the already-fetched
   `s.account` include). This requires extending `getDocumentWithExtraction`'s `bankStatement` include to
   reach `account.accountType`, and `extractAllStatementTransactions`'s existing `db.bankStatement.findMany`
   to also select `account: { select: { accountType: true } }`.

6. **`actions/bank-statements.ts#listEntityAccounts`: add `plaidCoverageStart` per account.** One extra
   `db.transaction.groupBy({ by: ["accountId"], where: { accountId: { in: accountIds }, source: "plaid" },
   _min: { postedAt: true } })` query, merged into the existing per-account result as
   `plaidCoverageStart: string | null` (ISO date, or `null` if the account has never had a Plaid-synced
   transaction). This is a generic, account-type-agnostic addition (not hardcoded to Capital One) — it
   fires for any Plaid-connected account someone later tries to statement-import into.

7. **`document-review-client.tsx`: wire up the new UI.**
   - Accept `canFlagBusinessExpense: boolean` and extend the existing `accounts` prop's `AccountOption`
     type with `plaidCoverageStart: string | null`.
   - Replace the `useState<Set<number>>(new Set(extraction.transactionRows?.map((_, i) => i) ?? []))`
     initializer with `defaultImportSelection(extraction.transactionRows ?? [], selectedAccountOption?.plaidCoverageStart ?? null)`
     (recomputed via `useEffect`/`useMemo` when `accountId` changes, since the target account — and
     therefore its Plaid coverage window — can change after the row list first renders).
   - Add a second `Set<number>` state, `businessExpenseRows`, and a second checkbox column, rendered only
     when `canFlagBusinessExpense` is true.
   - Per-row badges: `lineType === "payment"` → a distinct label (e.g. "Payment — already captured
     elsewhere, excluded by default"); `isWithinPlaidCoverage(row.date, plaidCoverageStart)` → a distinct
     warning label (e.g. "⚠ possibly already synced automatically — verify before importing"). Both stay
     individually togglable, same as every other row.
   - `handleConfirm` calls `importStatementTransactions(documentId, Array.from(selectedRows), accountId,
     Array.from(businessExpenseRows).filter((i) => selectedRows.has(i)))` — only rows that are both
     selected for import AND flagged get the override (a flagged-but-unselected row must not silently
     import anyway).

8. **Copy/breadcrumb fixes** (needed because Personal will now use a page/components written assuming a
   business entity):
   - `app/business/[slug]/statements/page.tsx`: only render the leading `Business / {entityLabel}`
     breadcrumb segment when `entity.type === "business"`; for Personal, render `Personal / Statements`
     with no "Business" link (Personal is a sibling bucket, not nested under Business — matches the
     mental model already established elsewhere in the app, e.g. the sidebar's own bucket split).
     Same treatment in `app/documents/[id]/review/page.tsx`'s breadcrumb.
   - Rename user-facing copy "Bank Statements"/"Upload Bank Statements" → "Statements"/"Upload
     Statements" in the page heading, `StatementUploadForm`'s card title, and `StatementsTable`'s "No
     statements uploaded yet" copy. Leave file names, the `BankStatement` model name, and the
     `bank-statements.ts` action file name unchanged (renaming those is unnecessary churn/migration risk
     for a copy-only fix).
   - Add a short hint under "Linked account" in `StatementUploadForm`: "Select the account before
     uploading a credit card statement — needed to correctly separate payments from charges."

9. **`components/app-sidebar.tsx`: make the feature reachable from Personal.** Add
   `{ label: "Statements", base: "/business/personal/statements", href: "/business/personal/statements" as Route }`
   to `personalItems`. No new route file — `app/business/[slug]/statements/page.tsx` already resolves any
   entity by slug with no business-type restriction (confirmed by reading the whole file).

10. **Tests.** Add the `credit_card_statement` describe block to `lib/__tests__/doc-extract.test.ts`
    (mock a Claude response with both a charge and a payment row, assert `lineType` survives the
    round-trip). Add `lib/__tests__/statement-review.test.ts` covering `defaultImportSelection` (excludes
    payment rows, excludes Plaid-covered-date rows, includes everything else, handles an empty/undefined
    `lineType` as a charge), `isWithinPlaidCoverage` (boundary: exactly the coverage-start date counts as
    covered; the day before does not; `null` coverage start never matches), and
    `needsCreditCardReclassification` (true only for `credit_card` + non-empty rows + zero rows carrying
    `lineType`; false for a checking account, an empty extraction, or an already-reclassified one).
    `actions/documents.ts` and `actions/bank-statements.ts` changes get `pnpm typecheck` +
    `pnpm lint` verification only, matching this repo's existing convention of no `actions/__tests__`
    directory anywhere — plus a manual smoke test (see Test expectations).

## Risks/unknowns

- **AI charge/payment classification is a heuristic, not a proof.** A statement description Claude
  doesn't recognize as a payment (unusual bank-issued phrasing, a scanned/low-quality image, etc.) could
  be misclassified as `"charge"` and imported by default. Mitigated, not eliminated, by defaulting to
  human review of every row (nothing auto-imports without the confirm click) — but a distracted reviewer
  could still click through. This is the same class of risk this repo already accepts for every other AI
  extraction feature (W-2s, 1099s, etc.); no stronger guarantee is possible without hand-written statement
  parsers per issuer, which is out of scope.
- **The Plaid-overlap warning is a coverage-window proxy, not an exact duplicate detector.** It only
  compares dates against the account's earliest Plaid-synced transaction; it doesn't diff amounts/payees
  against actual Plaid rows. A statement whose period straddles the Plaid cutover (e.g. late March into
  early April 2026) will have some rows correctly flagged and some not, based on date alone. This is a
  deliberate, cheap, "flag for human attention" mitigation, not a guarantee — documented as such rather
  than oversold.
- **Extraction-timing gap, only partially closed.** If a statement is uploaded in `batch` mode (which
  always skips extraction) or in `single` mode without an account selected, and the linked account is
  only set as `credit_card` *after* the transaction-row extraction has already run once and completed,
  the self-healing check in step 5 catches it the next time either the review page loads or "Extract
  transactions for all statements" runs — but not instantly/automatically the moment the account gets
  linked. Practical mitigation: the new upload-form hint (step 8) encourages picking the account up
  front. This is flagged, not fully eliminated.
- **The business-expense override is scoped to "any Personal-entity account's statement," not
  hardcoded to the Capital One card specifically.** This is a deliberate generalization along the real
  invariant that creates the ambiguity (a Personal-owned account could plausibly see occasional business
  use) rather than overfitting to one account id or to `accountType === "credit_card"` specifically — a
  Personal checking account's statement would get the same control if reviewed. No evidence this is
  wrong, but flagging it as a scope decision rather than leaving it implicit, per the request's own
  instruction to justify the generalization choice.
- **No support for correcting an already-imported transaction's entity.** If a row is imported with the
  wrong flag (or the flag is only realized to be needed after the fact), there's no edit path — only
  delete (`deleteTransaction`) and re-import. Flagged as a real, accepted limitation of the narrow-scope
  choice in Required Finding 2.
- **Follow-on need, not built:** flagging an already-Plaid-synced Capital One transaction (76 real rows,
  2026-04-02 onward, all currently `entityId = Personal`, all untagged) as an EK Consulting business
  expense. Same underlying real-world need as this task, different mechanism (an edit action on existing
  `Transaction` rows, not an import-time flag) — recommend as a near-term follow-on task, not building it
  here since it wasn't asked for and touches a different code path (`updateTransactionTags`-adjacent, not
  `importStatementTransactions`).
- **Bucket-switcher asymmetry (cosmetic, not fixed):** `lib/buckets.ts#bucketPathFor`'s business-slug-swap
  branch sends "switch bucket while on a business statements page" → Personal to `/` (dashboard), not to
  `/business/personal/statements`, because its `BUCKET_BASES`/`PERSONAL_TO_BUSINESS` tables predate
  Personal having a statements page at all. Low-priority; not required for acceptance.
- **`Document.docType` stays `"bank_statement"` for credit-card statements** (design choice in step 2) —
  means the generic `/documents` vault list and any future feature filtering `docType === "bank_statement"`
  will not be able to distinguish a credit-card statement from a checking-account one by `docType` alone;
  the only reliable signal is the linked `BankStatement.account.accountType`. Flagged in case a future
  task needs that distinction at the `Document` level directly.

## Acceptance criteria

1. The Personal bucket's sidebar shows a "Statements" link reaching `/business/personal/statements`,
   listing Personal's own accounts (including the real Capital One card) in the upload form's account
   picker.
2. Uploading a PDF/image with the Capital One account selected still correctly extracts
   period/opening/closing balance via the unchanged balance pipeline (no regression).
3. On `/documents/{id}/review` for a document linked to a `credit_card`-type account, the extracted
   `transactionRows` include a `lineType` per row (`"charge"` or `"payment"`).
4. Rows with `lineType: "payment"` are unchecked by default on page load and are visually distinguished
   from charge rows; toggling them on and confirming still imports them (no hard block).
5. Rows whose date is on/after the target account's Plaid coverage start (when the account has any
   Plaid-synced transactions) are unchecked by default and visually flagged; toggling them on and
   confirming still imports them.
6. When reviewing a document belonging to the Personal entity, each transaction row shows an "EK
   Consulting business expense" checkbox, independent of the import-selection checkbox.
7. Confirming with one or more business-expense-flagged, import-selected rows creates those `Transaction`
   rows with `entityId` = EK Consulting's real entity id; all other imported rows keep `entityId` =
   the target account's own entity id (Personal) — verified by a direct read of the created rows in a
   manual smoke test.
8. Reviewing a document belonging to a business entity (e.g. Sudden Valley, EK Consulting) shows no
   business-expense checkbox at all, and importing behaves exactly as it does today (no regression).
9. `importStatementTransactions` throws if called with a non-empty `businessExpenseIndices` against an
   account whose entity isn't Personal.
10. `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass with no new failures.
11. `git diff prisma/schema.prisma` is empty — no migration added or needed.

## Test expectations

- **Unit (Vitest, `lib/__tests__/`):**
  - `doc-extract.test.ts` — new `credit_card_statement` extraction round-trip test (mocked Claude
    response with a mixed charge+payment row set; asserts `lineType` and sign convention survive).
  - `statement-review.test.ts` (new file) — `defaultImportSelection`, `isWithinPlaidCoverage` (including
    the exact-boundary-date case), `needsCreditCardReclassification`, each with both a positive and a
    negative case.
- **Not unit-tested (matches established repo convention, verified by reading current test-file
  layout):** `actions/documents.ts` and `actions/bank-statements.ts` changes — no `actions/__tests__`
  directory exists anywhere in this repo; verified via `pnpm typecheck` + `pnpm lint` plus the manual
  smoke test below. `document-review-client.tsx` — no DOM/component test infrastructure exists in this
  repo (`vitest.config.ts` uses `environment: "node"`, no jsdom/RTL); verified by `pnpm typecheck` plus
  manual click-through, matching every other client component in this codebase.
- **Manual smoke test (required before calling this done, given real financial data is involved):**
  upload one real historical Capital One statement covering a 2025 period (pre-Plaid-coverage, so no
  overlap warnings expected) via `/business/personal/statements`; confirm the extracted rows show
  `lineType`; confirm payment rows are unchecked by default; flip one charge row's "EK Consulting
  business expense" checkbox and confirm; directly query the created `Transaction` row and confirm its
  `entityId` matches EK Consulting's real id and every other imported row's `entityId` matches Personal's
  real id. Separately, confirm a statement period overlapping April 2026 onward shows the Plaid-overlap
  warning on the expected rows.

## Edge cases worth explicit attention

- A charge row with a positive `amountCents` that's a genuine merchant refund/credit (not a payment) —
  must stay `lineType: "charge"`, not get swept into the payment-exclusion default.
- A statement whose account was never selected at upload and never gets confirmed/linked before the user
  navigates to the review page — extraction runs under the generic `bank_statement` shape (no
  `lineType` at all); every row defaults to "charge"-equivalent (nothing excluded), which is the existing,
  unchanged behavior for an unlinked statement today. Flagged in Risks, not silently perfect.
- A row selected for import but also flagged business-expense, then *deselected* for import before
  confirming — must not import at all (the `handleConfirm` intersection logic in step 7 already handles
  this; a test/manual check should confirm it explicitly).
- Re-uploading/re-extracting the same statement after a business-expense flag was already applied and
  imported once — the existing exact-match dedupe (`accountId`+`postedAt`+`amount`+`payeeNormalized`)
  will skip it as a duplicate regardless of the flag's current state on the second pass; this is existing
  behavior, not new, but worth being aware of given the new entity-override dimension.
