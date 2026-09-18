# Implementation: Credit card statement upload, parse, and transaction import

## Summary of changes

**New files:**
- `lib/statement-review.ts` — pure module (`defaultImportSelection`, `isWithinPlaidCoverage`,
  `needsCreditCardReclassification`) exactly matching the plan's step 3 signatures/semantics. No DB, no
  `"use server"`.
- `lib/__tests__/statement-review.test.ts` — 11 unit tests: `defaultImportSelection` (excludes payment
  rows, excludes Plaid-covered dates, includes everything else, treats undefined `lineType` as a charge),
  `isWithinPlaidCoverage` (exact-boundary-date counts as covered, day-before does not, `null` never
  matches), `needsCreditCardReclassification` (true only for credit_card + non-empty rows + zero rows
  carrying `lineType`; false for checking account / empty extraction / already-reclassified).

**Modified:**
- `lib/doc-extract.ts` — added `"credit_card_statement"` to `DocType`, added `lineType?: "charge" |
  "payment"` to `TransactionRow`, added the `credit_card_statement` prompt (mirrors `bank_statement`'s
  shape, adds `statementBalanceCents`/`minimumPaymentCents`/`paymentDueDate`, and the exact
  charge-vs-payment classification rules from the plan's Approach step 1, including the fail-closed
  "default to charge if unsure" instruction and the explicit "merchant refund/credit stays charge, don't
  conflate with payment" rule).
- `lib/__tests__/doc-extract.test.ts` — new `describe("extractDocument — credit_card_statement")` block:
  mocked Claude response with a charge row, a payment row, and a positive-amount merchant-refund row
  (explicitly asserting the refund stays `lineType: "charge"`, not swept into payment).
- `actions/documents.ts`:
  - `triggerExtraction` — now fetches `bankStatement.account.accountType` and derives the extraction
    `docType` from the *current* linked account (`credit_card_statement` if `accountType ===
    "credit_card"`, otherwise the existing `classifyDocType` path). `Document.docType` itself is left
    untouched (stays `"bank_statement"`), per the plan's deliberate design choice.
  - `importStatementTransactions` — new signature `(documentId, selectedIndices, accountId,
    businessExpenseIndices = [])`. Fetches the account with `entity.type`; throws if
    `businessExpenseIndices.length > 0` and `account.entity.type !== "personal"`. Resolves EK
    Consulting's entity id via `getEntityBySlug("ek-consulting")` (imported from `lib/entity.ts`) only
    when needed — never trusts a client-supplied entityId. Loop now iterates `selectedIndices` directly
    so each row's original index drives both the dedupe check and the
    `businessExpenseSet.has(i) ? ekConsultingEntityId : account.entityId` per-row entity assignment.
    Dedupe check (`accountId`+`postedAt`+`amount`+`payeeNormalized`) unchanged.
  - `getDocumentWithExtraction` — extended the `bankStatement` include to reach
    `account.accountType`, needed by the review page's self-healing re-check and by
    `canFlagBusinessExpense` gating logic.
- `actions/bank-statements.ts`:
  - `listEntityAccounts` — now returns `EntityAccountOption[]` with a new `plaidCoverageStart: string |
    null` per account, computed via one `db.transaction.groupBy({ by: ["accountId"], where: {
    accountId: { in: ... }, source: "plaid" }, _min: { postedAt: true } })` query. Generic/account-type-
    agnostic, matching the plan.
  - `extractAllStatementTransactions` — widened its "needs extraction" filter with an additional
    OR-branch calling `needsCreditCardReclassification(s.account?.accountType, s.document.extractionData)`,
    extending the `db.bankStatement.findMany` query to also select `account.accountType` and
    `document.extractionData`.
- `app/documents/[id]/review/page.tsx`:
  - Widened the auto-trigger-extraction condition to also fire when
    `needsCreditCardReclassification(doc.bankStatement?.account?.accountType, extraction)` is true.
  - `backLabel` generalized from `"Bank Statements"` to `"Statements"`.
  - `canFlagBusinessExpense = doc.entity.type === "personal"`, passed down to `DocumentReviewClient`.
  - Breadcrumb: only renders the `Business / {entityLabel}` segment when `entity.type === "business"`;
    renders a plain `Personal` label (no link — there's no `/business` equivalent for Personal) otherwise.
- `components/documents/document-review-client.tsx`:
  - `AccountOption` extended with `plaidCoverageStart?: string | null`; new `canFlagBusinessExpense?:
    boolean` prop.
  - Default row selection now computed via `defaultImportSelection(extraction.transactionRows ?? [],
    plaidCoverageStart)`, both as the `useState` initializer and recomputed in a `useEffect` keyed on
    `accountId` (since switching the target account changes which Plaid-coverage window applies).
  - New `businessExpenseRows` state + `toggleBusinessExpense`; a second checkbox column rendered only
    when `canFlagBusinessExpense`.
  - Per-row badges: a `lineType === "payment"` row shows "Payment — already captured elsewhere, excluded
    by default"; a `isWithinPlaidCoverage(row.date, plaidCoverageStart)` row shows "⚠ possibly already
    synced automatically — verify before importing". Both stay independently togglable.
  - `handleConfirm` now calls `importStatementTransactions(documentId, Array.from(selectedRows),
    accountId, Array.from(businessExpenseRows).filter((i) => selectedRows.has(i)))` — a
    flagged-but-deselected row is excluded from the override array (and from import entirely).
- `app/business/[slug]/statements/page.tsx` — breadcrumb is `Business / {entityLabel}` for
  `entity.type === "business"`, plain `Personal` label otherwise; heading generalized to "Statements";
  the "View Balance Sheets →" link and the balance-sheet-specific disclaimer sentence are now rendered
  only for business entities (this one specific hiding choice goes slightly beyond the plan's literal
  text — see Deviations below).
- `components/bank-statements/statement-upload-form.tsx` — card title generalized to "Upload
  Statements"; added the plan's exact hint sentence under "Linked account": "Select the account before
  uploading a credit card statement — needed to correctly separate payments from charges."
- `components/bank-statements/statements-table.tsx` — "No statements uploaded yet" empty-state copy
  generalized (dropped the balance-sheet-specific second sentence, since it's not universally true for
  Personal).
- `components/app-sidebar.tsx` — added `{ label: "Statements", base: "/business/personal/statements",
  href: "/business/personal/statements" as Route }` to `personalItems`. No new route file.

## Deviations from the plan

- **Hid the "View Balance Sheets →" link and its disclaimer sentence for non-business entities** on the
  statements page. The plan's step 8 only explicitly called out the breadcrumb and heading/copy fixes,
  not this link. I added it because `entity.type === "business"` is exactly the same invariant the plan's
  breadcrumb fix is keyed on ("page was written assuming a business entity"), and leaving a
  "View Balance Sheets" CTA pointed at `/business/personal/balance-sheet` for Personal would be a
  confusing dead-end for a page/feature this task didn't build out for Personal. This is a small,
  justified extension of the plan's own stated reasoning, not scope creep into a new feature — happy to
  revert if the Reviewer disagrees.
- Everything else matches the plan's function signatures, file list, and approach exactly — no other
  deviations.

## Commands run and their results

- `pnpm typecheck` — clean, no errors.
- `pnpm lint` — 0 errors, 49 warnings. Baseline in this repo has been drifting between ~44–49 warnings
  across sessions (see agent memory `commands.md`), all pre-existing categories
  (`react-hooks/set-state-in-effect`, unused vars, `no-unused-expressions` ternary-as-statement). Two new
  warnings are mine, both in `document-review-client.tsx`: one `react-hooks/set-state-in-effect` on the
  new account-change `useEffect` (same accepted pattern already present in 5+ other components in this
  repo — envelope/transfer-history-panel.tsx, insurance-policy-card.tsx, offline-indicator.tsx,
  retroactive-rule-modal.tsx, vault-verify-client.tsx), and one `no-unused-expressions` on
  `toggleBusinessExpense`'s `next.has(i) ? next.delete(i) : next.add(i)` line, which duplicates the
  pre-existing `toggleRow`'s identical style/warning already in this file before my edit. No errors in
  any file this task touched.
- `pnpm test` — 749/749 passed across 53 files. Two files changed test counts:
  `lib/__tests__/doc-extract.test.ts` went from 6 to 7 tests (+1, the new `credit_card_statement`
  round-trip test); `lib/__tests__/statement-review.test.ts` is a brand-new file with 11 tests. All
  passed on the run reported here (no fix-up iterations needed).
- `git diff --stat prisma/schema.prisma` — empty. No migration added or needed, confirming acceptance
  criterion 11.
- **Live read-only verification** (temporary in-tree `scripts/_tmp-verify-cc-statement-import.ts`, tsx,
  deleted immediately after — no writes, per this repo's established disposable-script pattern) against
  the real production-shared DB:
  - Confirmed the real Capital One `Account` (`505a29eb-f6b8-42d0-b40d-87046fdf36ad`): `accountType:
    "credit_card"`, `entity.type: "personal"`, `entity.slug: "personal"` — matches the plan's cited facts.
  - Confirmed `getEntityBySlug("ek-consulting")` resolves to the real EK Consulting entity (`type:
    "business"`) — the exact call `importStatementTransactions` makes.
  - Confirmed the live `db.transaction.groupBy` Plaid-coverage query for that account returns
    `plaidCoverageStart: "2026-04-02"`, matching the plan's stated live figure exactly.
  - Confirmed `isWithinPlaidCoverage("2025-01-14", "2026-04-02") === false` and
    `isWithinPlaidCoverage("2026-04-15", "2026-04-02") === true` against the real computed coverage date
    — the exact boundary behavior acceptance criteria 4/5 depend on.
  - Re-queried the real EK Consulting checking-account `"CAPITAL ONE-CRCARDPMT"` outflow rows the plan
    cited: found **4** real rows, not the 3 the plan enumerated (-$1,308.46 on 2025-01-14, -$2,941.60 on
    2025-02-13, -$1,593.50 on 2025-03-13, **and a 4th, -$352.30 on 2025-09-15, not mentioned in the
    plan**). This is real data that changed/synced between when the plan was written and now (today,
    2026-09-18) — not a bug in this implementation, but worth flagging: whoever does the real Capital One
    2025 statement backfill should be aware there may now be a 4th real payment-double-count risk to watch
    for around September 2025, not just the three January–March rows the plan called out.
- **Dev-server smoke test** (per agent memory `no-browser-tool-for-manual-verification` — this Coder
  session has no browser-control tool and no app login credentials, so a real click-through import could
  not be performed): started `pnpm dev` (bound to port 3002; 3000/3001 were already in use by other
  concurrent sessions), confirmed clean compilation with no errors in any touched file,
  `GET /login` → 200, `GET /business/personal/statements` → 307 (auth-gated redirect, expected, no 500),
  `GET /documents/{id}/review` → 307 (same). This confirms the new routes/wiring compile and serve
  without runtime errors, but **does not** confirm the actual visual UI (checkboxes, badges, the
  business-expense column) renders correctly, or that a real PDF upload → extraction → import round-trip
  produces the exact `Transaction` rows described in acceptance criterion 7. That real click-through with
  a real 2025 Capital One statement PDF is the one part of the plan's Test expectations I could not
  perform — flagged as an open item below for whoever (Tester/Reviewer/Eric) has real browser + login
  access.

## Required findings (restated verdict)

1. **Default landing entity/account** — confirmed unchanged: `account.entityId` (Personal, for the
   Capital One card), exactly like today's behavior. Verified by code (the `entityId` fallback in
   `importStatementTransactions`'s per-row loop) and live DB query above.
2. **Business-expense marking mechanism** — confirmed implemented exactly as specified: a second per-row
   checkbox in `document-review-client.tsx`, rendered only when `doc.entity.type === "personal"`,
   collected into `businessExpenseIndices: number[]`, passed to the extended
   `importStatementTransactions(documentId, selectedIndices, accountId, businessExpenseIndices)`. The
   server resolves EK Consulting's id itself via `getEntityBySlug("ek-consulting")` — the client never
   supplies an entityId — and throws if `businessExpenseIndices` is non-empty against a non-Personal
   account. Verified by direct code read (not unit-tested, matching this repo's no-`actions/__tests__`
   convention, per the plan's own Test expectations) and by the live `getEntityBySlug` call above.
3. **Payment-line double-count prevention** — confirmed implemented: the new `credit_card_statement`
   prompt tags each row `lineType: "charge" | "payment"`; `defaultImportSelection` (unit-tested, 11
   passing cases) excludes `"payment"` rows from the default checked set (unchecked, not deleted) and the
   review UI visibly labels them; toggling them on and confirming still imports them (no hard block —
   verified by code trace of `handleConfirm`/the checkbox `onChange` handlers, which never treat
   `lineType` as anything other than a default-selection input).

## Disposition of every item in the plan's Risks section

1. **AI charge/payment classification is a heuristic, not a proof** — implemented with documented
   limitation. The prompt encodes the exact classification rules and fail-closed "default to charge if
   unsure" instruction from the plan; every row still requires human review before import (nothing
   auto-imports on extraction alone). Not eliminated — same accepted risk class as every other AI
   extraction feature in this repo.
2. **Plaid-overlap warning is a coverage-window proxy, not an exact duplicate detector** — implemented
   with documented limitation. `isWithinPlaidCoverage` compares dates only, not amounts/payees against
   real Plaid rows, exactly as scoped. Live-verified the coverage-start value and boundary behavior above.
3. **Extraction-timing gap, only partially closed** — implemented with documented limitation.
   `needsCreditCardReclassification` closes the gap the next time the review page loads or "Extract
   transactions for all statements" runs (both wired per the plan's step 5); it is not instant the moment
   an account gets linked. The upload-form hint (added, verbatim from the plan) mitigates but doesn't
   eliminate this.
4. **Business-expense override scoped to "any Personal-entity account," not hardcoded to Capital One** —
   implemented exactly as the plan's deliberate generalization; `canFlagBusinessExpense` keys off
   `entity.type === "personal"`, not any specific account id or `accountType`.
5. **No support for correcting an already-imported transaction's entity** — genuinely deferred, not
   built, per the plan's explicit scope decision. No edit path exists; only delete + re-import.
6. **Follow-on need not built: flagging already-Plaid-synced Capital One transactions (76 real rows) as
   EK Consulting business expense** — genuinely deferred, not built, per the plan's explicit scope
   decision. Recommended as a near-term follow-on task (same as the plan states), not attempted here.
7. **Bucket-switcher asymmetry (cosmetic)** — genuinely deferred, not fixed, per the plan (low priority,
   explicitly "not required for acceptance").
8. **`Document.docType` stays `"bank_statement"` for credit-card statements** — implemented exactly as
   designed (deliberate choice in Approach step 2); flagged in code comments in `triggerExtraction` for
   any future task that needs that distinction at the `Document` level directly.

## Open items

- **Real browser click-through with a real 2025 Capital One statement PDF was not performed** — this
  Coder session has no browser-control tool and no app login credentials (see agent memory
  `no-browser-tool-for-manual-verification`). Substituted with: unit tests for all pure logic, full
  typecheck/lint/test, a dev-server compile+route-reachability smoke test, a live read-only DB
  verification of every fact the plan cited (Plaid coverage date, entity resolution, real transaction
  rows), and a full code trace against every acceptance criterion. The actual visual behavior (checkbox
  rendering, badge text, business-expense column, and the end-to-end
  upload → extract → review → confirm → `Transaction`-row-with-correct-`entityId` round-trip) still needs
  a real click-through by someone with dev-server browser + login access before this is fully "done" per
  the plan's own Test expectations section.
- **A 4th real `"CAPITAL ONE-CRCARDPMT"` checking outflow row was found live** (-$352.30 on 2025-09-15,
  EK Consulting) beyond the 3 the plan enumerated — not a code issue, just newer real data since the plan
  was written. Flagging so whoever performs the real 2025 statement backfill knows to watch for it too.
- Everything the plan itself flagged as "not fixing" (pre-existing `payeeNormalized` not routing through
  `normalizePayee()`, the "auto-match by last 4 digits" label having no backing logic, GL-coding still a
  separate manual step) remains unfixed, exactly as scoped — not reflagging each individually since the
  plan already documents them as explicitly out of scope.
