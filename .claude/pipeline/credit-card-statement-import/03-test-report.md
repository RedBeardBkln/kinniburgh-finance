# Test Report: Credit card statement upload, parse, and transaction import

## Verdict: PASS

The two critical safety areas this task exists for — entity-assignment (personal vs. EK Consulting) and
payment double-counting — are implemented correctly and fail closed, verified by direct code trace and
independent live read-only DB queries, not by trusting the Coder's self-report. `pnpm typecheck`, `pnpm
lint`, and `pnpm test` were re-run independently and match the Coder's claimed numbers exactly. One real
click-through with a real PDF has still not happened (no browser/login access on my end either) — flagged
below as the one remaining gap before Eric should rely on this for real 2025 backfill data.

## Acceptance criteria checklist

1. **Personal sidebar "Statements" link, lists Personal's accounts including Capital One** — PASS (code).
   `components/app-sidebar.tsx` has `{ label: "Statements", base: "/business/personal/statements", href:
   ... }` in `personalItems`. `app/business/[slug]/statements/page.tsx` has no business-type restriction
   (only redirects if the entity doesn't resolve at all) and calls `listEntityAccounts(entity.id)`. Live
   DB confirms `getEntityBySlug`-equivalent lookup for slug "personal" resolves to a real entity with the
   real Capital One account (`accountType: "credit_card"`) attached. Not click-through verified (no
   browser access) — see Not tested.

2. **Balance extraction unaffected (no regression)** — PASS (code). `lib/bank-statement-extract.ts` (the
   balance-only pipeline) is untouched by this diff (`git diff --stat` confirms zero changes to that
   file), and `finalizeStatementUpload`/`retryStatementExtraction` in `actions/bank-statements.ts` still
   call it unchanged.

3. **`lineType` present per row for `credit_card`-linked documents** — PASS (code + unit test). Verified
   `actions/documents.ts#triggerExtraction` derives `docType` from `doc.bankStatement?.account?.accountType
   === "credit_card"` (a live DB column value, not `Document.docType`), and the new
   `credit_card_statement` prompt in `lib/doc-extract.ts` requires `lineType` on every row. Round-trip
   verified by `lib/__tests__/doc-extract.test.ts`'s new test (charge, payment, and a positive-amount
   merchant-refund row that must stay `"charge"` — all three assertions present and passing).

4. **Payment rows unchecked by default, visually distinguished, togglable/importable** — PASS (code +
   unit test). `lib/statement-review.ts#defaultImportSelection` excludes `lineType === "payment"` rows;
   `lib/__tests__/statement-review.test.ts` covers this directly (`excludes payment rows by default`).
   `document-review-client.tsx` renders a distinct amber badge for payment rows and the checkbox is
   independently togglable — `handleConfirm` never special-cases `lineType`, so toggling a payment row on
   and confirming imports it (traced, no hard block found anywhere in the import path).

5. **Rows on/after Plaid coverage start unchecked by default, flagged, still importable if toggled** —
   PASS (code + unit test + live data). `isWithinPlaidCoverage` unit-tested including the exact boundary
   (coverage-start date counts as covered, day before does not, `null` never matches). Live DB query
   independently confirms the real Capital One account's Plaid coverage start is `2026-04-02` (`_min`),
   matching the plan's and Coder's cited figure exactly. Same "no hard block" trace as #4 applies (same
   toggle/handleConfirm code path).

6. **Personal-entity documents show "EK Consulting business expense" checkbox, independent of import
   checkbox** — PASS (code). `canFlagBusinessExpense = doc.entity.type === "personal"` in
   `app/documents/[id]/review/page.tsx`; `document-review-client.tsx` renders a second `<td>`/checkbox
   column gated on this prop, backed by a separate `businessExpenseRows` state independent of
   `selectedRows`.

7. **Business-expense-flagged + selected rows import with `entityId` = EK Consulting; all others keep the
   account's own entity** — PASS (code, live entity-resolution verified; not click-through verified — see
   Not tested). Read `actions/documents.ts#importStatementTransactions` line-by-line: `entityId =
   businessExpenseSet.has(i) && ekConsultingEntityId ? ekConsultingEntityId : account.entityId` per row —
   the non-flagged branch is always `account.entityId` (Personal for the Capital One card), never a
   fallback that could silently default to business. Live-queried `getEntityBySlug("ek-consulting")`
   equivalent independently myself: resolves to the real EK Consulting entity
   (`88734d5a-c7d2-4a14-94b0-5eb0dddaea21`, `type: "business"`). The actual `Transaction`-row-creation
   round trip (upload → extract → flag → confirm → query the created row) was not click-through tested by
   me or the Coder — flagged in Not tested, matching the Coder's own disclosed gap.

8. **Business-entity documents show no business-expense checkbox; unchanged import behavior** — PASS
   (code). `canFlagBusinessExpense` is `false` whenever `doc.entity.type !== "personal"`; the checkbox
   column and its `<th>` are both conditionally rendered off this same prop. `accounts` for a business
   document come from `listEntityAccounts(doc.entityId)` scoped to that business entity only, so `account`
   in `importStatementTransactions` will always resolve `entity.type === "business"` for these documents,
   and the empty-array default for `businessExpenseIndices` means the fail-closed throw is never hit under
   normal use.

9. **`importStatementTransactions` throws for non-empty `businessExpenseIndices` against a non-Personal
   account** — PASS (code, traced, not integration-tested — matches the repo's existing no-`actions/__tests__`
   convention, same as the Coder's own disclosure). The check (`if (businessExpenseIndices.length > 0 &&
   account.entity.type !== "personal") throw ...`) runs before any DB writes and before `getEntityBySlug`
   is even called, so a crafted call with a business `accountId` and a non-empty override array fails
   closed with no partial writes.

10. **`pnpm typecheck`, `pnpm lint`, `pnpm test` all pass, no new failures** — PASS, independently re-run
    (see Tests run below). Exact match to the Coder's claimed 749/749 and 0 errors/49 warnings.

11. **`git diff prisma/schema.prisma` empty** — PASS, independently confirmed (`git diff --stat
    prisma/schema.prisma` produced no output).

## Tests run

```
$ git diff --stat prisma/schema.prisma
(no output — empty diff, confirms AC 11)

$ pnpm typecheck
> tsc --noEmit
(clean, no errors)

$ pnpm lint
✖ 49 problems (0 errors, 49 warnings)
```
All 49 warnings are pre-existing categories (`react-hooks/set-state-in-effect`, unused vars,
`no-unused-expressions`) in files unrelated to or only lightly touched by this task; grepped specifically
for `document-review-client.tsx` and confirmed exactly 2 warnings there (lines 73 and the
`toggleBusinessExpense` ternary), matching the Coder's disclosure of "two new warnings, both mine, both
pre-existing accepted patterns elsewhere in the repo."

```
$ pnpm test
 Test Files  53 passed (53)
      Tests  749 passed (749)
```
Exact match to the Coder's claimed 749/749 across 53 files, including the new
`lib/__tests__/statement-review.test.ts` (11 tests) and the extended `lib/__tests__/doc-extract.test.ts`
(new `credit_card_statement` describe block).

## Live read-only DB verification (independent, not reusing the Coder's script)

Wrote a temporary in-repo script (`scripts/_tmp-tester-verify-cc-import.ts`, deleted immediately after —
no writes) against the same live Supabase DB the Coder queried, to independently confirm every disputed or
load-bearing fact rather than trust the Coder's report:

- **Capital One `Account`** (`505a29eb-f6b8-42d0-b40d-87046fdf36ad`): `accountType: "credit_card"`,
  `entity: { id: "6f55fa50-9d94-47a8-92d6-2cc5abeac714", name: "Personal", slug: "personal", type:
  "personal" }` — matches the plan/implementation's cited facts exactly.
- **EK Consulting entity resolution**: a `db.entity.findFirst({ where: { slug: "ek-consulting" } })` query
  (the exact query `getEntityBySlug` runs) resolves to `{ id: "88734d5a-c7d2-4a14-94b0-5eb0dddaea21", name:
  "Eric Kinniburgh Consulting, LLC", type: "business", slug: "ek-consulting" }` — confirms the entity-id
  the server resolves for the business-expense override is real and correctly typed `"business"`.
- **Plaid coverage window**: `db.transaction.groupBy` on the Capital One account, `source: "plaid"`, gives
  `_min.postedAt: "2026-04-02"`, `_max.postedAt: "2026-09-15"`, `_count: 76` — matches the plan's and
  implementation's cited figures exactly.
- **"CAPITAL ONE-CRCARDPMT" checking outflow count — the plan (3) vs. Coder (4) discrepancy**:
  independently re-queried EK Consulting's transactions for `payeeNormalized` containing "CRCARDPMT" and
  found **4** real rows: -$1,308.46 (2025-01-14), -$2,941.60 (2025-02-13), -$1,593.50 (2025-03-13), and
  **-$352.30 (2025-09-15)** — all `source: "import"`. **The Coder's figure of 4 is correct; the plan's
  cited figure of 3 is stale** (the 4th row synced/was entered into the live DB sometime between when the
  plan was written and this test round). This is real production data, not a bug in either the plan or the
  implementation. A broader search (case-insensitive, both `payeeRaw` and `payeeNormalized`) also surfaced
  6 more recent Plaid-synced `"CAPITAL ONE CRCARDPMT"` rows from 2026 (already covered by the live Plaid
  sync window, so not part of the 2025-backfill double-count risk this task addresses) — not a discrepancy,
  just confirms the payee string format changed slightly under Plaid vs. the original import.

## Code-trace verification of the two critical safety areas

**Entity-assignment safety (`actions/documents.ts#importStatementTransactions`):**
- (a) The server resolves EK Consulting's id itself via `getEntityBySlug("ek-consulting")` (imported from
  `lib/entity.ts`, a simple `db.entity.findFirst({ where: { slug } })`) — no `entityId` parameter of any
  kind is accepted from the client in the new signature `(documentId, selectedIndices, accountId,
  businessExpenseIndices = [])`. Confirmed by reading the full function and its signature.
- (b) Confirmed it throws (not silently no-ops) when `businessExpenseIndices.length > 0 &&
  account.entity.type !== "personal"` — this check runs first, before any DB writes and before
  `getEntityBySlug` is even called, so the failure is atomic/fail-closed with zero partial state.
- (c) Confirmed the per-row entity assignment `entityId = businessExpenseSet.has(i) && ekConsultingEntityId
  ? ekConsultingEntityId : account.entityId` — the non-flagged (default) branch is always
  `account.entityId`, i.e. the account's own entity (Personal for the Capital One card). There is no code
  path where a non-flagged row's `entityId` can resolve to anything other than `account.entityId`.

**Payment double-counting prevention:**
- `lib/doc-extract.ts`'s new `credit_card_statement` prompt requires `lineType: "charge" | "payment"` per
  row, with explicit classification rules (payment = only a payment *to the issuer*; merchant
  refunds/credits stay `"charge"` even though positive; unsure defaults to `"charge"`, i.e. fail-closed
  toward requiring human review rather than toward auto-exclusion).
- `lib/statement-review.ts#defaultImportSelection` (11 unit tests, all passing, including the merchant
  refund edge case in `doc-extract.test.ts`) excludes `"payment"` rows from the default-checked set —
  unchecked, not deleted, not hidden. `document-review-client.tsx` renders a visible amber badge on these
  rows and the row remains individually togglable; `handleConfirm`'s import call
  (`importStatementTransactions(documentId, Array.from(selectedRows), accountId, ...)`) treats
  `selectedRows` as the sole source of truth for what gets imported — nothing in the confirm path re-checks
  or overrides `lineType`, so toggling a payment row on and confirming does import it (no hard block, as
  required by AC 4).

## Tests added

None — the existing `lib/__tests__/statement-review.test.ts` (11 cases) and the new
`lib/__tests__/doc-extract.test.ts` describe block already cover every pure-function edge case called out
in the plan's Test expectations (payment exclusion, Plaid-boundary exclusion, undefined-`lineType`-as-charge,
the exact coverage-start boundary both directions, and the merchant-refund-stays-charge classification
edge case). I reviewed this coverage against the plan's "Edge cases worth explicit attention" section and
found no gap in the pure-function layer worth adding a test for. `actions/documents.ts` and
`actions/bank-statements.ts` remain untested by any automated test, matching this repo's established
no-`actions/__tests__` convention (verified: no such directory exists anywhere in the repo) — I did not add
integration tests here, consistent with repo convention and the plan's own stated Test expectations.

## Defects found

None that affect the plan's scope or the two critical safety areas. One pre-existing, unrelated
observation (not a regression, not blocking):

- **`actions/documents.ts#importStatementTransactions` never validates that the client-supplied `accountId`
  belongs to the reviewed `documentId`'s own entity** (or even the same entity at all) — it looks up
  `account` purely by `accountId`, independent of `documentId`. Confirmed via `git diff HEAD --
  actions/documents.ts` that this gap predates this task (the original `select: { id: true, entityId: true
  }` query had the identical lack of a documentId/accountId entity-match check). The review UI's own
  `<select>` is correctly scoped to `listEntityAccounts(doc.entityId)`, so this is only reachable via a
  crafted direct server-action call bypassing the UI, not through normal use, and it is not new or
  worsened by this task's `businessExpenseIndices` addition (that check is independently correct, keyed
  only on `account.entity.type`). Recorded in tester memory for future tasks that touch this action;
  **not a blocking finding for this PASS** per the pre-existing-issue carve-out in my instructions.
- Everything the plan/Coder explicitly flagged as deliberately not fixed (`payeeNormalized` not routing
  through `normalizePayee()`, the "auto-match by last 4 digits" label having no backing logic, GL-coding
  still manual, no edit path for an already-imported transaction's entity) was independently confirmed
  still true and still out of scope — not re-flagging as new findings.

## Deviation review (Coder's disclosed item)

The Coder hid the "View Balance Sheets →" link and its disclaimer sentence for non-business entities on
the statements page, beyond the plan's literal text (which only called out breadcrumb/heading copy fixes).
Verified this is keyed on the exact same `entity.type === "business"` invariant the plan's own breadcrumb
fix uses, is consistent with the plan's stated reasoning ("page was written assuming a business entity"),
and does not touch any code path relevant to entity-assignment or payment-double-counting safety. This is
a small, well-justified UI consistency fix, not scope creep that changes financial-data behavior —
recommend the Reviewer accept it, but it's their call per the pipeline, not a Tester veto.

## Not tested

- **Real browser click-through** (upload a real 2025 Capital One statement PDF → extract → review →
  confirm → verify `Transaction.entityId` lands correctly): not performed by me — I have no browser/login
  access in this environment, the same limitation the Coder disclosed. All verification above is via code
  trace, unit tests, and independent live read-only DB queries of every fact the implementation's behavior
  depends on (entity resolution, Plaid coverage date, real transaction counts). This is a real, outstanding
  gap — **someone with dev-server browser + login access must still do this click-through before Eric
  performs the real 2025 Capital One statement backfill**, per the plan's own Test expectations section.
  Specifically unverified: the actual visual rendering of the business-expense checkbox column, the
  payment/Plaid-overlap badges, and — most importantly — that a real `Transaction` row created through the
  UI (not a direct function call) actually lands with `entityId` = EK Consulting for a flagged row.
- **`document-review-client.tsx`'s client-side state logic** (the `useEffect` recomputing
  `defaultImportSelection` on `accountId` change, the `useState` initializers) was verified by static read
  only — this repo has no DOM/component test infrastructure (`vitest.config.ts` uses `environment: "node"`,
  no jsdom/RTL), matching the plan's own stated Test expectations and prior tester-memory precedent
  (`no-dom-test-env-for-sw-component-behavior`).
- I did not re-verify every one of the plan's "Risks/unknowns" disposition claims from scratch (e.g. the
  bucket-switcher asymmetry, the extraction-timing-gap self-healing re-check's exact trigger conditions
  beyond reading the code) — these are explicitly low-priority/non-blocking per the plan itself, and I
  focused my limited independent-verification effort on the two critical safety areas the task instructions
  emphasized.
