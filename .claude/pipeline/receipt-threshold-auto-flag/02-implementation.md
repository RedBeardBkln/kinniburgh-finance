# Implementation: Auto-flag transactions needing a receipt into Receipts > Needs Review

## Summary of changes

**New files:**

- `lib/receipt-flagging.ts` — pure module, no DB/`"use server"`. Exports `RECEIPT_THRESHOLD_DOLLARS`
  (75, cited to `specs/10-receipt-substantiation-threshold.md`), `needsReceiptWhere(entityId?)` (the
  corrected `amount: { lte: -75 }` outflow-only, unconditionally-business-scoped where-clause builder),
  `receiptDismissalKey`, `serializeReceiptDismissal`/`parseReceiptDismissal`, and the two `ReviewItem`
  shapes plus `mergeReviewItems` for the combined Needs-Review list. Implemented exactly as specified in
  the plan's Approach step 1, verbatim.
- `lib/__tests__/receipt-flagging.test.ts` — 17 tests covering `needsReceiptWhere` (business-type filter
  present with and without `entityId`, including when `entityId` is passed; exact `-75` threshold;
  exclusion filters), `receiptDismissalKey`, dismissal serialize/parse round-trip + malformed-JSON +
  missing-field cases, and `mergeReviewItems` (interleaving, both-empty, stability on equal `sortAt`).
- `components/receipts/dismiss-receipt-flag-button.tsx` — small `"use client"` leaf, `window.confirm` +
  `useTransition` + `router.refresh()`, matching this repo's established pattern. Implemented verbatim
  from the plan.

**Modified files:**

- `actions/receipts.ts` — added `listFlaggedTransactions(entityId?)` and
  `dismissReceiptRequirement(transactionId, reason?)`, both exactly as specified in the plan (query +
  two-step `AppSetting` dismissal filter; fail-closed non-business-entity guard; paired `AuditLog` row
  with `changeType: "receipt_flag_dismissed"`).
- `app/receipts/page.tsx` — fetches `listFlaggedTransactions(entity?.id)` alongside `listReceipts` and
  the unconfirmed-receipt count (all three in one `Promise.all`); combined badge count
  (`reviewReceiptCount + flaggedTransactions.length`); on the `review` tab only, builds
  `ReviewReceiptItem[]`/`ReviewFlaggedTransactionItem[]` and merges via `mergeReviewItems`, rendering one
  combined `<tbody>` with per-kind row rendering. Flagged-transaction rows get a distinctly-colored
  (orange, vs. the existing yellow "Needs Review" receipt badge) badge reading "Flagged for review — no
  receipt on file," an "Attach receipt →" link to
  `/receipts/upload?bucket={entitySlug}&transactionId={id}`, and the new dismiss button. Added the
  required ground-rule-8 caption line above the table on the `review` tab. Suppressed the
  Previous/Next pagination controls specifically on the `review` tab (per Scope — no pagination for the
  merged list; `confirmed`/`all` tabs are unchanged).
- `app/receipts/upload/page.tsx` — reads optional `searchParams.transactionId`; when present, fetches
  that transaction (`include: { entity, account }`) and builds a `TransactionContext` object
  (`{ id, payeeRaw, postedAt (ISO date), amount (abs Decimal string), entityLabel, accountId }`), passed
  to `UploadClient` instead of relying on `?bucket=`-derived `entityLabel` in that mode.
- `app/receipts/upload/upload-client.tsx` — accepts optional `transactionContext`. When present: skips
  the `/api/entity-id?bucket=` fetch, sets `formData.set("transactionId", ...)` instead of `entityId`,
  replaces the read-only "Entity" field with a summary card ("Attaching a receipt to: **{payee}** — {date}
  — {amount} ({entity})"), defaults the "Capture date" input to the transaction's own `postedAt`, and
  redirects to `/receipts/{id}?transactionId={transactionContext.id}` on success (so the confirm page can
  pre-select the match).
- `app/api/receipts/upload/route.ts` — accepts optional `transactionId` from `formData`. When present:
  looks up the transaction server-side (never trusts a client-supplied `entityId` in that mode), rejects
  non-business-entity transactions with 400 (fail-closed, matching `dismissReceiptRequirement`'s guard),
  derives `entityId`/`accountId` from the transaction, and pre-fills `vendor`/`receiptDate`/`total` at
  `receipt.create` time before OCR runs. Both the OCR-failure catch branch and the OCR-success update
  branch were changed so that when `tx` is set: `ocrStatus` is forced to `"complete"` (never `"failed"`)
  and OCR is not allowed to overwrite the already-known `vendor`/`receiptDate`/`total` (only
  `description`/`glCode`/`ocrRaw` still come from OCR in that case). Response JSON now includes
  `transactionId` (`tx?.id ?? null`) alongside `receiptId`.
- `app/receipts/[id]/page.tsx` — accepts optional `searchParams.transactionId`; when present, fetches
  that one transaction (`id, postedAt, amount, payeeRaw, accountId, account.nickname`) in the same
  `Promise.all` as the other page data; builds `allMatches` by prepending the pinned transaction into the
  fuzzy-matched `matches` array, deduped by id; passes `initialTransactionId={pinnedTransaction?.id}` and
  `initialAccountId={pinnedTransaction?.accountId ?? receipt.accountId ?? null}` into
  `ReceiptConfirmForm`.
- `components/receipts/receipt-confirm-form.tsx` — added optional prop `initialTransactionId?: string`;
  changed `useState<string | undefined>()` to `useState<string | undefined>(initialTransactionId)` for the
  `transactionId` state. This is the **only** change to this file — no other logic touched, per the plan's
  explicit instruction not to duplicate the tag→GL-code tie-in.

## Deviations from the plan

None of substance. Two small, non-behavioral additions the plan's code sketch didn't spell out but that
were necessary to make the sketch compile/render correctly:

- The plan's `app/api/receipts/upload/route.ts` sketch didn't show the full `db.receipt.create` call; I
  added `accountId: tx?.accountId ?? null` to that call (the plan's prose explicitly calls for this — "sets
  `Receipt.accountId` from the transaction's account" — the sketch just didn't include the literal
  create-block diff).
- Picked a distinct badge color (orange, `bg-orange-100 text-orange-700`) for the flagged-transaction
  status badge rather than the plan sketch's unstyled `Badge` example, specifically so it's visually
  distinguishable from the existing yellow "Needs Review" receipt badge on the same page (the plan's own
  acceptance criterion 3 requires "visually distinct status badges" — same-color badges with only
  different text would have been a weaker reading of that requirement).

No scope changes, no schema changes, no reimplementation of the tag→GL-code tie-in.

## Commands run and their results

- `pnpm typecheck` — clean, no errors.
- `pnpm lint` — 0 errors, 49 warnings, all pre-existing (verified none are in any file this task touched
  — the new `lib/receipt-flagging.ts`, `lib/__tests__/receipt-flagging.test.ts`, and
  `components/receipts/dismiss-receipt-flag-button.tsx` produced zero warnings).
- `pnpm test` — **766/766 passed across 54 files** (includes the new
  `lib/__tests__/receipt-flagging.test.ts`, 17 tests, all passing).
- `npx next build` (schema untouched, so skipped `prisma generate` to avoid this repo's known Windows
  DLL-lock contention issue) — succeeded cleanly. All touched routes compiled and appear in the route
  manifest: `/receipts`, `/receipts/[id]`, `/receipts/upload`, `/api/receipts/upload`.
- `git diff --stat prisma/schema.prisma` — empty. **No migration added or needed**, confirming acceptance
  criterion 10.
- Disposable read-only `scripts/_tmp-verify-flagging.ts` / `scripts/_tmp-verify-receipts.ts` (tsx,
  deleted immediately after, per this repo's established live-data-verification pattern) run against the
  live shared DB to re-confirm the plan's cited numbers before trusting them:
  - `needsReceiptWhere(entityId)` live counts: **Sudden Valley 55, EK Consulting 20, Mezzo 0, Personal
    0** — matches the plan's cited numbers exactly.
  - Total `AppSetting` rows: 4, matching the plan's cited baseline.
  - **One real discrepancy found and reported honestly, not silently reconciled:** the plan's acceptance
    criterion 2 states "Personal currently has 1 real 'complete'/unconfirmed Receipt row." A live query
    just now shows **Personal has 0** such receipts; the 2 unconfirmed receipts are both on **Sudden
    Valley** (consistent with the plan's own earlier "two duplicate Lowe's Home Centers... $28.93 receipts"
    citation in finding 1). This looks like the same kind of hours-apart data drift this repo's memory has
    seen before on other tasks, not a bug in this implementation — `needsReceiptWhere`'s Personal-exclusion
    behavior itself is correct and verified (0 flagged transactions for Personal, as required). Worth a
    Tester/reviewer double-check against current data before treating "1 Personal receipt" as still true.

## Required findings — restated verdicts

**1. The "needs receipt" query is corrected and verified.** `needsReceiptWhere(entityId?)` in
`lib/receipt-flagging.ts` uses `amount: { lte: -RECEIPT_THRESHOLD_DOLLARS }` (i.e. `-75`, dollars —
`Transaction.amount` is `Decimal(14,2)` dollars, not cents) — outflow-only, never the request doc's wrong
`Math.abs(amount) >= 7500` cents reading and never a naive `abs(amount) >= 75` reading (which would wrongly
flag income). `entity: { type: "business" }` is unconditional in the returned where-input, appended
regardless of whether `entityId` is also supplied — verified both by a unit test
(`needsReceiptWhere` tests) and by a live query showing Personal returns 0 flagged transactions while
Sudden Valley/EK Consulting return the plan's cited 55/20. Exclusions (`archivedAt: null`, `receiptId:
null`, `transferPairId: null`) are present exactly as specified.

**2. Dismissal mechanism: built, reuses `AppSetting`, confirmed no migration.**
`dismissReceiptRequirement` writes a `receipt_not_required:{transactionId}` key via
`db.appSetting.upsert` (no new column, no new table) plus a paired `AuditLog` row with
`changeType: "receipt_flag_dismissed"`. `listFlaggedTransactions` filters dismissed transactions out via
the two-step fetch-then-filter pattern the plan specified. `git diff --stat prisma/schema.prisma` is
empty — **confirmed no Prisma migration was added or is needed.** No "undo dismissal" UI was built,
matching the plan's explicit scope.

**3. GL-code tie-in is genuinely reused, not reimplemented — confirmed by reading the actual code.**
Traced the same call chain the plan cites: `confirmReceipt` (`actions/receipts.ts`, unchanged) → when
`transactionId` + `tagIds` are present → `updateTransactionTags` (`actions/transactions.ts`, unchanged) →
`autoAssignGlCodes` (`lib/gl-code-resolver.ts`, unchanged, not even read/imported by this task's new
code). **Zero new tag/GL-code logic was written.** The entire "Attach receipt" flow's tie-in to that chain
is exactly one line: seeding `ReceiptConfirmForm`'s existing `transactionId` React state from a new
`initialTransactionId` prop (`useState<string | undefined>(initialTransactionId)` instead of
`useState<string | undefined>()`) — no other line in `receipt-confirm-form.tsx` was touched.
`app/api/receipts/upload/route.ts`'s new `transactionId` branch never calls `updateTransactionTags` or
`autoAssignGlCodes` directly — it only pre-fills `Receipt.vendor`/`receiptDate`/`total` and returns the
transaction id for the client to carry forward as a URL param.

## Open items

- **The plan's acceptance-criterion-2 data claim ("Personal has 1 unconfirmed receipt") no longer matches
  live data** (now 0) — see the verification note above. Not a defect in this implementation; flagging so
  the Tester doesn't get a false "regression" signal when re-checking that specific number, and so
  whoever wrote/reviews the plan is aware the underlying data moved between planning and coding.
- **No live browser click-through was performed** — this agent has no browser-control tool or app login
  credentials. Verification instead relied on: `pnpm typecheck`/`lint`/`test` (all clean/passing), a full
  `npx next build` (all touched routes compile and appear in the manifest), and live read-only DB queries
  re-confirming the flagged-transaction counts per entity match the plan's numbers. The plan's "Manual
  smoke test" section (6 steps, e.g. clicking "Not needed"/"Attach receipt" and confirming resulting DB
  rows) was not executed end-to-end through the UI and should be done by the Tester or the user before
  considering this fully verified in production.
- **Everything else in the plan's Scope/Risks/Edge-cases sections is implemented as specified** — no
  additional deviations, no new schema, no pagination added, no dismissal-reason UI added (matches
  explicit out-of-scope calls).
