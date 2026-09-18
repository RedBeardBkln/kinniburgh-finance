# Test Report: Auto-flag transactions needing a receipt into Receipts > Needs Review

## Verdict: PASS

I re-ran every automated check myself, read every changed file end-to-end (not just the plan's
sketches), traced the GL-code tie-in chain into its unmodified callees, ran a live read-only query
against the real Supabase DB to independently confirm the cited per-entity counts, and specifically
tried to find a way the query or dismissal mechanism could leak into Personal or duplicate/lose a
GL-code assignment. I did not find one. I'm willing to stake my name on the query-correctness and
GL-code-reuse claims specifically (items 3 and 4 of the request). One data-provenance detail in the
Coder's self-report is inaccurate (see "Correction to the Coder's report" below) but it does not
change the verdict — it's a mischaracterization of a harmless planning-time miscount, not a defect.

## Acceptance criteria checklist (from 01-plan.md)

1. **EK Consulting/Sudden Valley/Mezzo flagged counts (20/55/0) — PASS.** Independently re-ran a live
   read-only query against the real DB using the actual `needsReceiptWhere()` function (not a
   hand-rolled re-implementation): Sudden Valley 55, EK Consulting 20, Mezzo 0, Personal 0. Matches
   the plan's and Coder's cited numbers exactly.
2. **Personal never shows flagged-transaction rows — PASS**, with a correction to the illustrative
   figure. Live query confirms 0 flagged transactions for Personal (`entity.type` filter is
   unconditional and correctly excludes Personal regardless of `entityId` narrowing — see below).
   The "existing uploaded-but-unconfirmed Receipt rows" part of this criterion is also satisfied:
   `listReceipts`'s review-tab where-clause (`ocrStatus: "complete", confirmedAt: null`) is completely
   unmodified by this task (confirmed via `git status`/reading `actions/receipts.ts`), so whatever it
   returns is pre-existing, unchanged behavior — currently 0 rows for Personal, see correction below.
3. **Visually distinct badges/actions for the two item kinds — PASS (verified by reading the render
   code, not a live screenshot).** `app/receipts/page.tsx` renders `item.kind === "receipt"` rows with
   the pre-existing yellow "Needs Review" `OcrStatusBadge` and a `Review →` link, and
   `"flagged_transaction"` rows with a distinctly-colored orange badge ("Flagged for review — no
   receipt on file") plus two different actions ("Attach receipt →" and the new "Not needed" dismiss
   button). Confirmed these are genuinely different code paths in the same `<tbody>`, not a shared
   component with a color prop that could silently regress to look identical.
4. **"Not needed" → excluded on reload, one `AppSetting` + one `AuditLog` row — code-traced PASS, not
   live-executed.** See "Dismissal mechanism" section below for the full trace. I did not execute this
   live: per this repo's own memory (`feedback_production_operations`), direct DB-write scripts are
   hard-blocked by the harness's auto-mode classifier, and I have no browser/login access to click
   through the actual UI. Disclosing this plainly rather than silently skipping it.
5. **"Attach receipt" → correct `Receipt`/`Transaction`/`TransactionTag`/`glCodeId` — code-traced PASS,
   not live-executed.** Same disclosure as above applies. See "GL-code tie-in" section below for the
   full call-chain trace, including the one file this task did NOT touch
   (`actions/transactions.ts#updateTransactionTags`), read directly to confirm it still derives
   `entityId` from the transaction and calls `autoAssignGlCodes` exactly as before.
6. **Attached transaction disappears from `listFlaggedTransactions` — PASS (query-level, verified by
   reading the code).** `needsReceiptWhere` filters `receiptId: null`; `confirmReceipt` sets
   `Transaction.receiptId` when `transactionId` is present. Once set, the transaction structurally can
   no longer match the where-clause. Not independently re-verified via a live attach-and-reload cycle
   (same access constraint as #4/#5).
7. **Fail-closed on non-business entity — PASS, read directly.** Both
   `actions/receipts.ts#dismissReceiptRequirement` and `app/api/receipts/upload/route.ts`'s
   `transactionId` branch fetch the transaction with `include: { entity: true }` and explicitly throw /
   return 400 when `tx.entity.type !== "business"`, before any write happens. Matches the cited
   `businessExpenseIndices` precedent in `actions/documents.ts:298-301` (confirmed that precedent code
   still exists as described).
8. **`needsReceiptWhere(entityId)` always includes `entity: { type: "business" }` — PASS, unit-tested
   and read directly.** `lib/receipt-flagging.ts:17` spreads `entity: { type: "business" }`
   unconditionally, before the optional `...(entityId ? { entityId } : {})` spread — order doesn't
   matter here since they're different keys, but confirmed both are always present together when
   `entityId` is supplied. `lib/__tests__/receipt-flagging.test.ts` explicitly tests this with
   `"personal-entity-id"` as the `entityId` argument, per the criterion's own framing.
9. **`pnpm typecheck`, `pnpm lint`, `pnpm test` all pass — PASS, independently re-run, see below.**
10. **`git diff --stat prisma/schema.prisma` empty — PASS, independently re-run, see below.**

## Tests run (exact commands, real output)

```
$ pnpm typecheck
> tsc --noEmit
(clean, no output, exit 0)

$ pnpm lint
✖ 49 problems (0 errors, 49 warnings)
0 errors and 1 warning potentially fixable with the `--fix` option.
```
All 49 warnings are in files this task did not touch (`offline-indicator.tsx`,
`retirement-balance-form.tsx`, `entities-client.tsx`, `retroactive-rule-modal.tsx`,
`vault-client.tsx`, `vault-verify-client.tsx`, `doc-extract.test.ts`, `forecast.test.ts`,
`encrypt.ts`, `plaid-sync.ts`, `transfer-match-runner.ts`, `seed.ts`) — matches the Coder's claim that
this task introduced zero new lint warnings.

```
$ pnpm test
 Test Files  54 passed (54)
      Tests  766 passed (766)
```
Exact match to the Coder's claimed 766/766 across 54 files, including
`lib/__tests__/receipt-flagging.test.ts (17 tests)` passing.

```
$ git diff --stat prisma/schema.prisma
(empty output)
```
Confirmed genuinely empty — no migration, matches AC10.

## Query correctness (request item 3) — verified directly

Read `lib/receipt-flagging.ts#needsReceiptWhere` in full:

```ts
export function needsReceiptWhere(entityId?: string): Prisma.TransactionWhereInput {
  return {
    archivedAt: null,
    receiptId: null,
    transferPairId: null,
    amount: { lte: -RECEIPT_THRESHOLD_DOLLARS }, // -75
    entity: { type: "business" },
    ...(entityId ? { entityId } : {}),
  };
}
```

- **Outflow-only, dollars not cents** — `amount: { lte: -75 }` against `Transaction.amount` which the
  schema itself comments as `Decimal @db.Decimal(14,2) // negative = outflow` (dollars). Correct: no
  cents-vs-dollars mixup, no `abs()` that would also catch income.
- **`entity: { type: "business" }` is unconditional** — present in the returned object every time,
  regardless of whether `entityId` is also supplied. Read the function body directly; there is no
  branch that omits it. Also unit-tested (`needsReceiptWhere("personal-entity-id")` still asserts
  `where.entity` equals `{ type: "business" }`).
- **Exclusions present**: `archivedAt: null`, `receiptId: null`, `transferPairId: null`, all as literal
  fields in the returned where-input, matching soft-delete/already-receipted/internal-transfer
  exclusion conventions used elsewhere in this repo.
- **Live independent re-query** (own script, read-only, run against the real DB, deleted after):
  calling the actual imported `needsReceiptWhere` function per-entity gives Sudden Valley 55, EK
  Consulting 20, Mezzo 0, Personal 0 — exact match to both the plan's and Coder's cited figures. I did
  not hand-roll a separate query; I imported and called the real function, so this also structurally
  confirms it compiles and executes against the live schema, not just that the plan's prose is
  self-consistent.

**Conclusion: this query cannot be called in a way that flags a Personal transaction.** The only way
to defeat the `entity: { type: "business" }` filter would be editing `lib/receipt-flagging.ts` itself.

## GL-code tie-in (request item 4) — verified directly

Read `components/receipts/receipt-confirm-form.tsx` in full (469 lines). The only diff from
pre-existing behavior is:

```ts
const [transactionId, setTransactionId] = useState<string | undefined>(initialTransactionId);
```

(previously `useState<string | undefined>()`, always `undefined`). Every other line — `handleConfirm`,
the `confirmReceipt` call shape, the tag picker, the match-radio-button list — is byte-identical to
before. `handleConfirm` still calls the same unmodified `confirmReceipt` server action with
`transactionId` and `tagIds` exactly as it did before this task.

Traced the full call chain by reading each file directly, not assuming the plan's prose:

1. `actions/receipts.ts#confirmReceipt` (unmodified — not in this task's diff) — when
   `data.transactionId` is set, sets `Transaction.receiptId`, then if `tagIds.length > 0` calls
   `updateTransactionTags(data.transactionId, data.tagIds)`.
2. `actions/transactions.ts#updateTransactionTags` (unmodified — not in this task's diff, confirmed
   via `git status`) — fetches the transaction for its `entityId`, writes an `AuditLog` row, replaces
   `TransactionTag` rows in a `db.$transaction`, then calls
   `autoAssignGlCodes([{ transactionId, entityId: tx.entityId, tagIds }], user.id!)`.
3. `lib/gl-code-resolver.ts#autoAssignGlCodes` — not imported or referenced anywhere in this task's new
   code (`lib/receipt-flagging.ts`, `actions/receipts.ts`'s two new exports,
   `app/api/receipts/upload/route.ts`'s new branch). Grepped for `autoAssignGlCodes` across the repo;
   the only call sites are the three pre-existing ones inside `actions/transactions.ts` (untouched).

**Conclusion: zero new tag/GL-code logic was written.** The entire mechanism by which the "Attach
receipt" flow reuses the tag→GL-code tie-in is the one-line `initialTransactionId` state seed. This is
exactly what the plan and Coder claimed, and I verified it by reading the actual bytes of the
unmodified downstream files, not by trusting either document's description of them.

## Dismissal mechanism (request item 5) — verified directly, not live-exercised

`dismissReceiptRequirement` (`actions/receipts.ts`):
- Fetches the transaction with `archivedAt: null` and `include: { entity: true }`; throws if not found
  or not business-typed (fail-closed, before any write).
- `db.appSetting.upsert({ where: { key: receiptDismissalKey(transactionId) }, ... })` — `AppSetting`
  schema is `model AppSetting { key String @id; value String }`, confirmed no new column/table; `key`
  is the `@id`, so the upsert's `where: { key }` is valid against the live schema.
- Writes a paired `db.auditLog.create` with `transactionId`, `changedBy: user.id!`,
  `changeType: "receipt_flag_dismissed"`, `after: JSON.parse(value)`. Cross-checked against the
  `AuditLog` model (`transactionId String?`, `changedBy String`, `changeType String`, `before Json?`,
  `after Json?`) — every field used is a plain existing column, no migration needed, matches the
  `changeType`-is-a-plain-string precedent the plan cites.

`listFlaggedTransactions`'s exclusion of dismissed rows: fetches candidate rows via
`needsReceiptWhere`, then `db.appSetting.findMany({ where: { key: { in: keys } } })` where
`keys = rows.map(r => receiptDismissalKey(r.id))`, builds a `Set`, and filters
`!dismissedKeys.has(receiptDismissalKey(r.id))`. This is a correct two-step exclusion — traced key
generation on both the write side (`dismissReceiptRequirement`) and read side
(`listFlaggedTransactions`) and confirmed they use the exact same `receiptDismissalKey` function, so
there's no risk of a key-format mismatch between write and read.

**Live DB check performed:** queried `AppSetting` for any existing `receipt_not_required:` keys — found
zero, confirming no prior dismissal exists to interfere with a future live test, and confirming the
total `AppSetting` row count is still 4 as both the plan and Coder claimed.

**Not live-exercised:** I did not call `dismissReceiptRequirement` against a real transaction and then
revert it. Per this repo's own memory (`feedback_production_operations.md`, confirmed current — I read
it before attempting this), direct DB-write scripts are hard-blocked by the harness's auto-mode
classifier as of 2026-09-16 regardless of framing, and I have no browser/login access to exercise the
real "Not needed" button through the UI. I did not attempt the write and get denied; I checked the
policy first and skipped straight to code-tracing, which is the documented correct fallback. This is a
real, disclosed gap in verification depth (acceptance criterion 4 is traced, not executed), not a
silent skip.

## Merged rendering (request item 6) — verified directly

`app/receipts/page.tsx`, `tab === "review"` branch: builds `ReviewReceiptItem[]` from `receipts`
(capped at `pageSize=25` via `listReceipts`'s existing pagination, `page` defaulting to 1) and
`ReviewFlaggedTransactionItem[]` from the full (unpaginated) `flaggedTransactions` list, merges via
`mergeReviewItems`, renders one `<tbody>` with a per-`item.kind` conditional row template. Confirmed
the two row templates are visually distinct (different badge color/text, different action
links/buttons) by reading the JSX directly — see AC3 above.

`mergeReviewItems` itself (`lib/receipt-flagging.ts`) is a pure `[...receipts, ...flagged].sort(...)` —
structurally cannot drop or duplicate an item (no filtering, no dedup-by-mistake logic), only
reorders. Unit-tested for interleaving, both-empty, and equal-`sortAt` stability.

**One latent, plan-endorsed limitation, not a new defect:** the review tab explicitly suppresses the
Previous/Next pagination controls (`tab !== "review" && totalPages > 1`), while the underlying
`receipts` fetch for that tab is still capped at 25 via `listReceipts`'s existing `skip/take`. If an
entity's uploaded-but-unconfirmed Receipt count ever exceeds 25, the review tab would silently show
only the most recent 25 with no way to page to the rest, while the `reviewCount` badge (computed from
an unbounded `db.receipt.count`) would over-report versus what's rendered. This is explicitly called
out as an accepted, deliberate simplification in both the plan (Approach step 3: "No pagination
applied to the review tab's merged list") and the Coder's own report — not a silent gap. Today's real
data (0/2/0/0 unconfirmed receipts across Personal/Sudden Valley/EK Consulting/Mezzo) is nowhere near
25, so this doesn't manifest currently. Noting it here per the Tester's job to flag boundary conditions
the pipeline should be aware of, not as a blocking defect.

## Ground rule 8 check (request item 7) — every new user-facing string read

Read every new/changed string literal in the diff across all seven touched files:
- Caption (review tab only): *"Transactions over $75 are flagged here using a commonly-applied
  receipt-substantiation guideline — not a certainty that every flagged item legally requires a
  receipt for your specific expense category. Dismiss any item that doesn't need one."* — matches
  `specs/10-receipt-substantiation-threshold.md`'s own recommended framing almost verbatim ("apply $75
  as the receipt-required threshold... as a practical, defensible default — but... describe it
  accurately ('commonly-applied $75 threshold,' not 'IRS requires receipts for all expenses over
  $75')"). Compliant.
- Badge text: *"Flagged for review — no receipt on file"* — a factual statement, no compliance claim.
- Confirm dialog: *"Mark this transaction as not needing a receipt? It will no longer show up in this
  queue."* — no compliance claim.
- Upload-attach summary card: *"Attaching a receipt to: **{payee}** — {date} — {amount} ({entity})"* —
  factual, no compliance claim.
- Server error strings: `"Transaction not found"`, `"Receipt flagging only applies to business
  transactions"`, `"entityId required"` — internal/defensive, no compliance claim.

**No string asserts certain IRS non-compliance or a legal requirement.** All read as "flagged for
review," matching ground rule 8 and the spec's own explicit scope caveat.

## Correction to the Coder's report

The Coder's implementation doc frames the Personal-receipt-count discrepancy (plan says "1 real
complete/unconfirmed Receipt row," live data now shows 0) as likely "the same kind of hours-apart data
drift this repo's memory has seen before." I checked this specifically and it does not hold up:

I queried all Personal `Receipt` rows including archived ones. There are exactly 3, and every one of
them has `createdAt`/`updatedAt` timestamps from **2026-06-27** (three months before this task was
planned or coded on 2026-09-18):
- one `ocrStatus: "pending"`, never completed OCR — does not match the review-tab filter.
- one `ocrStatus: "failed"`, `archivedAt` set (archived same day it was created) — does not match.
- one `ocrStatus: "complete"`, `confirmedAt: 2026-06-27T11:38:17Z` (already confirmed back in June) —
  does not match.

None of these rows have been touched since June, so there is no row whose state could plausibly have
flipped between the plan being written and the Coder verifying it hours later "today." The most likely
explanation is that the plan's cited "1 unconfirmed complete Personal receipt" figure was simply a
miscount at planning time (e.g., counting the pending or already-confirmed row), not genuine live data
drift. This doesn't affect the verdict — the actual acceptance criterion (zero flagged-transaction rows
for Personal, existing Receipt-row behavior unchanged) is independently confirmed true regardless of
which of the two explanations is correct, and `listReceipts`'s review-tab query is untouched by this
task either way — but the Coder's specific causal claim ("data drift... not a bug in this
implementation") is more precisely "planning-time miscount... not a bug in this implementation." Worth
correcting for the record so a future agent doesn't cite "hours-apart data drift" as a confirmed
pattern based on this instance.

## Tests added

None. `lib/__tests__/receipt-flagging.test.ts` (written by the Coder) already covers every pure-logic
edge case called out in the plan's Test Expectations section: the unconditional business-type filter
(with and without `entityId`, including a `"personal-entity-id"` argument specifically), the exact
`-75` threshold, the three exclusion filters, dismissal-key stability, serialize/parse round-trip
(with/without a reason), malformed-JSON handling, missing-required-field handling, and
`mergeReviewItems` interleaving/ordering/empty-array/equal-`sortAt`-stability. I read every test and
traced each assertion against the actual implementation (not just the test names) — they exercise real
behavior, not tautologies. I did not find a gap in the pure-function coverage worth adding to. I
considered adding a boundary-value test at exactly `amount = -75.00` against a real Prisma query
result, but that would require a live DB write (blocked, see above) or a mocked Prisma client (this
repo's established convention per `CLAUDE.md`'s Testing pattern section explicitly avoids DB
integration tests, mocking at the function boundary instead) — the existing
`expect(where.amount).toEqual({ lte: -75 })` test already correctly proves `lte` (inclusive) is used,
which is the load-bearing fact for the boundary case; a live-DB round-trip would test Prisma/Postgres
itself, not this task's code.

## Not tested

- **Live UI click-through of "Attach receipt" and "Not needed"** (plan's Manual Smoke Test steps 1-6).
  No browser/login access available to this agent. Verified via full code-path tracing instead (see
  "Dismissal mechanism" and "GL-code tie-in" sections above) — this is a genuine depth-of-verification
  gap, disclosed plainly, not silently assumed covered.
- **Live DB write-and-revert of `dismissReceiptRequirement`** (would have directly proven AC4's
  "creates one `AppSetting` row and one `AuditLog` row"). Hard-blocked by this repo's harness policy on
  direct DB-write scripts (confirmed via memory, not assumed) — code-traced instead.
- **Live DB write-and-revert of the "Attach receipt" flow** (would have directly proven AC5's full
  `Receipt`/`Transaction.receiptId`/`TransactionTag`/`glCodeId` chain against real rows). Same
  constraint as above — code-traced instead, including reading the one downstream file
  (`actions/transactions.ts`) this task doesn't touch to confirm it's genuinely unmodified.
- **`npx next build`** — not independently re-run by me (the Coder already ran it and reported success;
  re-running it is expensive and `pnpm typecheck` + `pnpm lint` + the full test suite already give
  strong signal that nothing is broken at the type/lint/unit level). Flagging that this specific check
  was trusted from the Coder's report rather than independently repeated.
- **The pre-existing `credit-card-statement-import` task's own correctness** — out of scope for this
  report; I read it only far enough to confirm the `businessExpenseIndices` fail-closed pattern this
  task cites as precedent still exists as described.
