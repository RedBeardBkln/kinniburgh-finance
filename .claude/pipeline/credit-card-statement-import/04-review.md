# Review: Credit card statement upload, parse, and transaction import

## Verdict: APPROVED

Both critical, real-money safety mechanisms — entity-assignment fail-closed behavior and
payment-double-counting prevention — are implemented correctly. I independently traced
`importStatementTransactions` and `defaultImportSelection`/`isWithinPlaidCoverage` myself (not
relying on the Coder's or Tester's write-ups) and confirm their conclusions. `pnpm typecheck`
output and the diff match what both prior stages reported. No blocking findings.

## Independent verification of the two critical safety mechanisms

**Entity assignment (`actions/documents.ts#importStatementTransactions`):**
- The fail-closed guard runs first, before any DB write and before `getEntityBySlug` is even
  called: `if (businessExpenseIndices.length > 0 && account.entity.type !== "personal") throw`.
  A crafted call against a business account with a non-empty override array fails atomically —
  confirmed by reading the function top to bottom.
- The server never accepts a client-supplied `entityId`. It resolves EK Consulting's real id
  itself via `getEntityBySlug("ek-consulting")`, only when `businessExpenseIndices` is non-empty.
- Per-row assignment: `entityId = businessExpenseSet.has(i) && ekConsultingEntityId ?
  ekConsultingEntityId : account.entityId`. The non-flagged branch is unconditionally
  `account.entityId` — there is no fallback path where an unflagged row can land anywhere other
  than the account's own entity (Personal, for the Capital One card). Confirmed by direct read of
  the diff, not the summary.

**Payment double-counting (`lib/statement-review.ts` + `document-review-client.tsx`):**
- `defaultImportSelection` excludes (unchecks, doesn't delete) rows where `lineType === "payment"`
  or `isWithinPlaidCoverage(row.date, plaidCoverageStartIso)` is true; everything else, including
  rows with no `lineType` at all (i.e. a plain `bank_statement` extraction), defaults to selected —
  matching today's unchanged behavior for non-credit-card statements.
- `isWithinPlaidCoverage`'s boundary is inclusive (`dateIso >= plaidCoverageStartIso`) and is
  unit-tested at exactly that boundary in both directions — correct and matches the plan.
- `handleConfirm` never re-checks `lineType`; `selectedRows` (the checkbox state) is the sole
  source of truth passed to `importStatementTransactions`, so toggling a payment row on and
  confirming imports it — no hard block, matching the plan's explicit "human always has final say"
  design.
- The new `credit_card_statement` prompt in `lib/doc-extract.ts` correctly keeps merchant
  refunds/credits (positive amount, not paid to the issuer) as `"charge"`, not `"payment"` — and
  this exact edge case has its own passing unit test (`doc-extract.test.ts`).

Both mechanisms are correct, and the reasoning in `02-implementation.md`/`03-test-report.md` holds
up against the actual code, not just the write-ups.

## The four specific scrutiny points from the task

**1. Safety mechanisms** — see above, independently confirmed.

**2. The disclosed deviation (hiding "View Balance Sheets →" + its disclaimer for non-business
entities)** — **Accept as-is, no revert needed**, but I want to record the actual reasoning rather
than just rubber-stamp the Tester's "same invariant" observation. I checked whether
`/business/personal/balance-sheet` would actually *work* if linked — `computeBalanceSheet()` in
`lib/reports.ts` is entirely entity-agnostic (just buckets `Account.currentBalance` by
asset/liability type), so the destination page is not literally broken for Personal. However:
`components/app-sidebar.tsx`'s `personalItems` array has no "Balance Sheet" entry at all (only
`businessItems`, gated on `isBusinessBucket`), so there is and was no other reachable path to that
page for Personal before or after this task — and the page's own copy ("Balance sheets are drafts
for CPA review — not financial advice") is written for business bookkeeping, not a personal
net-worth view. Hiding the CTA for Personal is a reasonable, conservative call that avoids
surfacing an unplanned, effectively-untested-for-Personal feature surface as a side effect of this
task — approved.

**3. The `accountId`-not-scoped-to-`documentId`'s-entity gap** — Independently confirmed: the
`db.account.findUniqueOrThrow({ where: { id: accountId }, include: { entity: ... } })` call has no
join back to `documentId` or its entity, and `git diff` shows the original code (`select: { id:
true, entityId: true }`) had the identical gap — this predates the task and isn't worsened by the
`businessExpenseIndices` addition, whose own fail-closed check is independently correct and keyed
only on `account.entity.type`. The review UI's `<select>` is scoped via
`listEntityAccounts(doc.entityId)`, so this isn't reachable through normal use — only a crafted
direct server-action call. I agree with the Tester: **non-blocking**, worth a should-fix note for
whoever next touches `importStatementTransactions`, not a reason to hold this task.

**4. "Next statement" nav + merged confirm/import flow for credit-card statements** — Verified by
reading `app/documents/[id]/review/page.tsx` in full. `isBankStatement = doc.docType ===
"bank_statement"` is true for credit-card statements too, because `Document.docType` is
deliberately left as the literal `"bank_statement"` string regardless of the linked account's real
type (the plan's step 2 design choice) — so the `nextReviewHref` computation
(`listBankStatements(doc.entityId)`, ordered by `periodEnd desc`) and the single
"Confirm extraction & import N transactions" button in `document-review-client.tsx` both fire
identically for credit-card statements, no special-casing needed and none missing. Confirmed
`listBankStatements` has no `accountType` filter of any kind.

**5. Plaid-overlap warning visibility** — Read the actual JSX in
`document-review-client.tsx`. Each flagged row gets a distinct colored inline badge directly under
the description ("⚠ possibly already synced automatically — verify before importing", blue,
bordered) and unchecked rows are dimmed (`opacity-40`) at the row level. There's no page-level
aggregate summary ("3 rows may already be synced"), but the dynamic confirm-button label ("Confirm
extraction & import N transactions", where N = the live `selectedRows.size`) does give a passive
numeric signal if the count is lower than the reviewer expects. This matches the plan's explicit
scope ("a warning + default-exclusion, not a hard block," "a coverage-window proxy, not an exact
duplicate detector") — adequate as shipped; a page-level summary banner would be a nice
incremental improvement but isn't required to approve.

## Findings

- **Should-fix, cosmetic** (`app/business/[slug]/statements/page.tsx`, lines ~48–51): The
  Coder's entity-type-conditional hiding fix caught the "View Balance Sheets →" link and the
  "Balance sheets are drafts for CPA review" disclaimer sentence, but missed a third occurrence of
  the same claim — the header description paragraph unconditionally reads "Upload account
  statements — bank or credit card. Confirmed closing balances feed the monthly, quarterly, and
  annual balance sheets." for every entity, including Personal, which (per finding above) has no
  reachable balance-sheet page. Minor, not financially risky, but worth a one-line fix
  (`{entity.type === "business" && " Confirmed closing balances feed the monthly, quarterly, and annual balance sheets."}`
  or similar) next time this file is touched.
- **Should-fix, pre-existing, not introduced here**: `importStatementTransactions`'s `accountId`
  lookup isn't scoped to the reviewed document's own entity — see point 3 above. Confirmed
  independently, agree with the Tester's non-blocking assessment.
- **Nit**: No aggregate/page-level summary for payment-excluded or Plaid-overlap rows, only
  per-row badges — acceptable given the plan's explicit scope, but worth considering for a future
  UX pass if Eric finds himself missing overlap warnings in practice during the real backfill.

## What's good

- The fail-closed entity-assignment check is written correctly and in the right order (guard
  before any resolution or write) — this is the one piece of this task that had to be right, and
  it is.
- Payment/Plaid-overlap default-exclusion is implemented as "unchecked, not deleted, still
  togglable" exactly as required — no silent data loss, no hard block, matches the repo's
  stub-vs-guess discipline for real financial data.
- Test coverage for the pure logic (`statement-review.test.ts`, the `doc-extract.test.ts` round
  trip) explicitly covers the two trickiest edge cases: the exact Plaid-coverage boundary date in
  both directions, and a positive-amount merchant refund staying `"charge"` rather than being swept
  into `"payment"`.
- `Document.docType` staying `"bank_statement"` for credit-card statements (rather than adding a
  new value and touching every `classifyDocType`/`isBankStatement` call site) was the right,
  narrower design choice — it's what keeps the "next statement" nav and merged confirm+import flow
  working for credit-card statements with zero special-casing, and is clearly documented as a
  deliberate trade-off (flagged in Risks) for any future feature that needs `docType`-level
  distinction.
- `git diff --stat prisma/schema.prisma` is genuinely empty — no migration, matching the ground
  rules.
- The Coder's and Tester's live read-only DB verification (Plaid coverage date, EK Consulting
  entity resolution, the real 4th `"CAPITAL ONE-CRCARDPMT"` row not in the plan) was done
  independently by each and cross-checked, which is exactly the right level of rigor for a feature
  whose entire purpose is real 2025 tax-year backfill data.

## Before this ships to real use (not blocking the pipeline, but must happen before Eric relies on it)

(a) **No real browser click-through has happened yet.** Neither the Coder, the Tester, nor I (as
Reviewer) have browser or app-login access in this pipeline. All verification across all four
stages has been via code trace, unit tests, `pnpm typecheck`/`lint`/`test`, and independent
live *read-only* DB queries — never an actual upload → extract → review → confirm → verify-the-
created-`Transaction`-row round trip through the real UI. Someone with dev-server browser + login
access (Eric, or a future Claude-in-Chrome session) needs to do that click-through with a real 2025
Capital One statement PDF before this is relied on for the real backfill — specifically to confirm
the business-expense checkbox column renders, the payment/Plaid-overlap badges render as expected,
and a real created `Transaction` row lands with the correct `entityId`.

(b) **Next natural task**: `.claude/pipeline/receipt-threshold-auto-flag/00-request.md` is already
drafted (not yet planned) and applies IRS-$75-threshold auto-flagging to transactions from both
this feature and the existing bank-statement feature — worth picking up next.

## Memory updates

Wrote one new memory entry (`entity-type-conditional-copy-drift.md`) capturing the reusable
pattern found in finding 1 above: when a Coder hides a UI element behind an entity-type or
feature-flag condition, check every place in the same file/page that makes the same underlying
claim — partial fixes (2 of 3 sentences conditioned) are a recurring near-miss in this repo.
