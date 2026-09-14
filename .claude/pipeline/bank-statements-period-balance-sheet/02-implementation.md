# Implementation — Fix for Tester Defect 1 (liability sign not normalized)

No prior Coder stage exists for this feature (it was built outside the pipeline; see
`00-request.md`). This document covers only the fix for the single blocking defect the
Tester found in `03-test-report.md`.

## Summary of changes

### `lib/period-balance-sheet.ts` (`buildPeriodBalanceSheet`)

Root cause: the function pushed `snap.closingBalanceCents` straight into a
`PeriodBalanceLine` regardless of asset/liability classification, then computed
`equityCents = totalAssetsCents - totalLiabilitiesCents`. Per
`lib/bank-statement-extract.ts`'s own extraction prompt, liability balances (credit
card, mortgage, loan) are extracted as *negative* cents (money owed). Left un-normalized,
subtracting a negative `totalLiabilitiesCents` **added** the debt to equity instead of
subtracting it.

Fix: when building a `PeriodBalanceLine` for an account classified as a liability
(`LIABILITY_TYPES.has(type)`), take `Math.abs()` of `closingBalanceCents` before storing
it on the line. Asset lines are left untouched (unchanged behavior, including the
existing "handles negative balances (overdraft) as signed cents" test). This exactly
mirrors the already-established convention in this codebase:
- `lib/reports.ts:127` (`computeBalanceSheet`) — `Math.abs(balance.toNumber() * 100)`
- `actions/net-worth.ts:105` (`computeNetWorth`) — `Math.abs(Math.round(a.currentBalance.toNumber() * 100))`

Because the normalization happens once, at the point every `StatementSnapshot` (regardless
of whether it originated from AI extraction or manual confirm-form entry) is turned into a
`PeriodBalanceLine`, this is also the single choke point all downstream consumers read
from — `totalLiabilitiesCents`/`equityCents` on the returned `PeriodBalanceSheet`, the
balance-sheet page's merge with `computeBalanceSheet`'s live fallback
(`app/business/[slug]/balance-sheet/page.tsx`), and `actions/reports.ts`'s
`exportPeriodBalanceSheetCsv` (which sums `fromStatements.liabilities` — already
normalized — with `computeBalanceSheet`'s live liabilities — already `Math.abs()`'d by
the pre-existing code). No changes were needed in either of those two call sites; they
were already written to trust the sign convention this function is supposed to enforce.

This makes the fix robust to *either* sign arriving from the storage layer — it no longer
matters whether a given `BankStatement.closingBalance` was stored negative (AI extraction
path) or positive (a user who typed the positive amount owed), the balance sheet math is
correct either way.

### `components/bank-statements/statements-table.tsx` (manual-entry UI clarification)

The Tester flagged that the manual "Closing balance ($)" field gave no guidance on sign
convention, so a person confirming a credit-card statement by hand would naturally type a
positive "amount owed" — which happens to differ from what AI extraction stores for the
same account type, even though (post-fix) both now produce a correct balance sheet.
Rather than force a single stored-sign convention (which would require also changing
`confirmBankStatement`'s validation/normalization and risk conflicting with whatever the
AI extraction already wrote for other rows), I added a short helper line under the
"Closing balance ($)" input clarifying that credit card/mortgage/loan balances represent
the amount owed and that either sign is accepted — because `buildPeriodBalanceSheet` now
normalizes with `Math.abs()` regardless of input sign, this statement is accurate and
removes the ambiguity the Tester called out, without touching validation logic in
`actions/bank-statements.ts`.

## Deviations from the plan

None — this was a scoped bug-fix task (no plan document; working from the Tester's
report), and the change stayed within `lib/period-balance-sheet.ts` plus one small UI
clarification the Tester explicitly asked me to evaluate. I did not touch
`actions/bank-statements.ts`, `lib/bank-statement-extract.ts`, or the CSV export code —
all three were already correct once the aggregation function itself was fixed, per the
trace above.

I did not remove or weaken the Tester's regression test in
`lib/__tests__/period-balance-sheet.test.ts`; it now passes unmodified.

## Commands run and their results

All run from `D:\Repos\Personal\kinniburgh-finance` after making the fix:

```
$ pnpm typecheck
$ tsc --noEmit
(clean, no output, exit 0)

$ pnpm lint
✖ 43 problems (0 errors, 43 warnings)
(identical warning set to the Tester's pre-fix baseline in 03-test-report.md — all in
pre-existing unrelated files: vault-verify-client.tsx, doc-extract.test.ts,
forecast.test.ts, encrypt.ts, plaid-sync.ts, seed.ts. Zero warnings in
lib/period-balance-sheet.ts, lib/bank-statement-extract.ts, actions/bank-statements.ts,
actions/reports.ts, or components/bank-statements/.)

$ pnpm test
Test Files  36 passed (36)
     Tests  421 passed (421)
```

421 = the Tester's pre-fix baseline of 420 passing tests + the 1 new regression test
(`buildPeriodBalanceSheet > "normalizes a liability's signed closing balance..."`), which
now passes. All 16 tests in `lib/__tests__/period-balance-sheet.test.ts` pass, including
the pre-existing test with a *positive* `closingBalanceCents: 320_000` fixture for the
credit-card row (line 118-132) — confirming the fix doesn't regress the case where a
liability balance happens to already be entered/stored as positive.

## Open items

None known. The one minor, non-blocking documentation issue the Tester noted (the stale
comment at `lib/period-balance-sheet.ts:120` claiming "Only statements fully inside the
period are considered" when only `periodEnd` is actually bounds-checked, not
`periodStart`) is unrelated to the sign-convention defect and was left as-is per the
instruction not to touch unrelated code — flagging it here in case a future task wants to
clean it up.

---

# Implementation — Fix for Reviewer Defect (Document Vault crash on `statements/` fileKey prefix)

This covers only the fix for the single blocking finding in `04-review.md`
(`CHANGES_REQUESTED`, routed to coder), plus the review's low-risk should-fix/nit items.

## Summary of changes

### `lib/supabase-storage.ts` — new shared bucket-routing helpers

Root cause (per the Reviewer): `Document.fileKey` now has three possible routing
prefixes — `documents/` (generic vault uploads, `receipts` bucket), `taxes/` (tax-specific
uploads, `taxes` bucket, prefix stripped from the physical key), and the new
`statements/` (bank-statement uploads, `taxes` bucket, key used unstripped) — but the
bucket-selection logic for reading a `Document.fileKey` back was duplicated and
incomplete in two places: `actions/documents.ts`'s `getDocumentSignedUrl`/
`triggerExtraction` always assumed the `receipts` bucket (no prefix awareness at all),
and `actions/tax-planning.ts`'s private `getTaxSignedUrlSafe`/`downloadTaxDocument` only
special-cased `taxes/`, falling back to `receipts` for anything else — including the new
`statements/` prefix.

I confirmed the exact physical-path convention each existing uploader uses before writing
the shared helper, rather than guessing:
- `actions/documents.ts`'s `uploadDocument` calls `uploadReceiptFile(buffer, fileKey, ...)`
  with the full `documents/{entityId}/{docId}.ext` key, unstripped — reads must match.
- `actions/tax-planning.ts`'s `uploadTaxDocumentCore` calls
  `uploadTaxFile(buffer, fileKey, ...)` with the full `taxes/{entityId}/{docId}.ext` key,
  but the *existing* (pre-this-fix) `getTaxSignedUrlSafe`/`downloadTaxDocument` strip the
  `taxes/` prefix before calling into `lib/supabase-storage.ts`. I preserved this exact
  stripping behavior in the new shared helper rather than "fixing" it, since (a) it's the
  currently-live, already-shipped behavior for every existing tax document in production,
  and (b) reconciling whether the upload side or the read side has the "correct" physical
  path is a separate, higher-risk question outside this task's scope — changing it without
  being able to inspect the real Supabase bucket contents risks breaking every existing tax
  document's signed URL instead of just the new one this task is scoped to fix. Flagging
  this below under Open items.
- `actions/bank-statements.ts`'s `uploadStatementCore` calls
  `uploadTaxFile(buffer, fileKey, ...)` with the full `statements/{entityId}/{statementId}.ext`
  key, and its own `retryStatementExtraction` already reads it back via
  `downloadTaxFile(doc.fileKey)` unstripped — self-consistent already. The new shared
  helper mirrors this: `statements/`-prefixed keys route to the `taxes` bucket with the key
  used exactly as stored (no stripping).

Added two exported functions, `getDocumentFileSignedUrl(fileKey)` and
`downloadDocumentFile(fileKey)`, each with a short prefix-dispatch table (`taxes/` →
`getTaxSignedUrl`/`downloadTaxFile` with prefix stripped, `statements/` → same functions
with the key unstripped, anything else → `getReceiptSignedUrl`/`downloadReceiptFile`
unstripped) and a comment documenting every prefix currently in use, grepped from
`actions/**` and `app/api/**`, and why each one resolves the way it does. This is now the
single place a new prefix needs to be taught.

### `actions/documents.ts`

- `getDocumentSignedUrl` now calls `getDocumentFileSignedUrl(doc.fileKey)` instead of
  unconditionally `getReceiptSignedUrl(doc.fileKey)`. This is the exact fix for the
  blocking bug: `ViewLink` (`app/documents/page.tsx`) will no longer throw for a
  bank-statement `Document`, so the whole `/documents` page no longer crashes for the
  household once a single bank statement has been uploaded.
- `triggerExtraction` now calls `downloadDocumentFile(doc.fileKey)` instead of
  unconditionally `downloadReceiptFile(doc.fileKey)` — fixes the lower-severity,
  already-caught mis-extraction bug the Reviewer flagged for the same root cause.
- Updated the import line accordingly; `uploadReceiptFile` import kept (still used by
  `uploadDocument`).

### `actions/tax-planning.ts`

- Replaced the private `getTaxSignedUrlSafe` helper (which duplicated a narrower version
  of the same prefix logic, and didn't know about `statements/`) with a direct call to the
  new shared `getDocumentFileSignedUrl`. `getTaxDocumentSignedUrl` now delegates to it.
- Replaced `downloadTaxDocument`'s inline prefix-stripping with a direct call to the new
  shared `downloadDocumentFile`.
- This removes the duplicated bucket-routing logic per the review's explicit direction
  ("almost certainly means fixing it once in a shared helper... rather than patching
  `getDocumentSignedUrl` and `triggerExtraction` separately") and additionally applies the
  same fix to this file's two read paths, which also didn't know about `statements/`
  before this change (not flagged by the Reviewer by name, since they only traced
  `ViewLink`'s crash path, but they share the identical root cause and are exactly the
  "everywhere `Document.fileKey` is used" surface the task asked me to cover).
- `actions/bank-statements.ts`'s own `retryStatementExtraction` was intentionally left
  calling `downloadTaxFile(doc.fileKey)` directly rather than migrated to the shared
  helper — it only ever handles `statements/`-prefixed keys it created itself, so there's
  no routing ambiguity there, and changing it adds risk with no behavior change. Noted
  here rather than silently left inconsistent.

### Regression test — `lib/__tests__/supabase-storage.test.ts` (new)

`lib/supabase-storage.ts` has no existing test file (it's a thin HTTP wrapper around
Supabase's Storage API, not previously a "pure function" module per this repo's testing
convention). The prefix-dispatch logic in the two new functions is a genuine testable
seam, though: it's pure branching on the `fileKey` string, with the only external
dependency being `fetch` (the actual network boundary). I mocked `global.fetch` (via
`vi.stubGlobal`, matching this repo's existing `vi.mock`/`vi.fn` conventions used in
`doc-extract.test.ts`) and asserted, for each of the three prefixes, which bucket segment
(`taxes` vs `receipts`) appears in the constructed request URL, and — for `taxes/` vs
`statements/` — whether the prefix is stripped from the key. This directly exercises the
crash scenario without needing a browser: a `statements/`-prefixed fileKey resolving to
the `taxes` bucket (not `receipts`) is exactly what prevents `getReceiptSignedUrl`'s
`!res.ok` throw for a bank-statement `Document`. 6 tests, all passing.

I did not spin up the dev server or click through `/documents` in a browser (no browser
access in this environment, consistent with what the Tester/Reviewer both noted for this
task) — the fix's correctness is verified via this unit test plus static tracing of every
call site, not an end-to-end run.

## Non-blocking review nits — fixed vs. skipped

Fixed (trivial, low-risk, no judgment call needed):
- **Stale comment** (`lib/period-balance-sheet.ts:120-121`): corrected to accurately state
  that only `periodEnd` is bounds-checked against the period, not `periodStart`, with a
  one-line rationale (an annual statement's Dec 31 balance is still valid for a
  December-month query).
- **Unconditional liability caption** (`components/bank-statements/statements-table.tsx`):
  the "enter the amount owed... either sign works" helper text under "Closing balance ($)"
  now only renders when the row's selected account's `accountType` is a liability type
  (`credit_card`/`mortgage`/`loan`), matching the review's suggested fix exactly. Added a
  small `LIABILITY_ACCOUNT_TYPES` set and a derived `isLiabilityAccount` boolean from the
  already-in-scope `accounts` prop and `accountId` state — no new data fetching.
- **Redundant DB query** (`app/business/[slug]/balance-sheet/page.tsx`): removed the
  `db.account.findMany` query that existed solely to compute `liveAccounts.length > 0` for
  the `"statements+live"` vs `"statements"` source badge; replaced with
  `liveAssets.length + liveLiabilities.length > 0`, derived from data already fetched via
  `computeBalanceSheet` two lines below. Removed the now-unused `db` import from this file
  (confirmed via grep — no other `db.` usage remained in the file).
- **Copy inaccuracy** (`components/bank-statements/statement-upload-form.tsx`): "Review and
  confirm below or on the statement's review page" (no such page exists) changed to
  "Review and confirm in the statements table below."
- **Missing trailing newline** (`app/business/[slug]/balance-sheet/page.tsx`): added.

Skipped (needs a judgment call, per the task's explicit instruction not to expand scope):
- **Sidebar/overview Mezzo inconsistency** (`components/app-sidebar.tsx` showing "Bank
  Statements" for all business buckets including Mezzo, vs. `app/business/page.tsx`
  intentionally excluding it): the Reviewer explicitly flagged this as "not harmful" and a
  "nit-level inconsistency," and fixing it means picking a side (add Mezzo's exclusion to
  the sidebar too, or reverse the overview page's exclusion) — a product decision about
  whether Mezzo (not a yet-formed legal entity per `specs/03-business-finances.md`) should
  ever show this nav item, not a mechanical correction. Left unchanged.

## Commands run and their results

All run from `D:\Repos\Personal\kinniburgh-finance` after making the above changes:

```
$ pnpm typecheck
$ tsc --noEmit
(clean, no output, exit 0)

$ pnpm lint
✖ 43 problems (0 errors, 43 warnings)
(same 43-warning baseline as the Tester's and Reviewer's prior runs, all in pre-existing
files unrelated to this task — confirmed zero warnings in every file touched by this fix:
lib/supabase-storage.ts, actions/documents.ts, actions/tax-planning.ts,
app/business/[slug]/balance-sheet/page.tsx, components/bank-statements/statements-table.tsx,
components/bank-statements/statement-upload-form.tsx, lib/period-balance-sheet.ts,
lib/__tests__/supabase-storage.test.ts.)

$ pnpm vitest run lib/__tests__/supabase-storage.test.ts
Test Files  1 passed (1)
     Tests  6 passed (6)

$ pnpm test
Test Files  37 passed (37)
     Tests  427 passed (427)
```

427 = the prior 421 (420 baseline + the liability sign-normalization regression test) plus
the 6 new `supabase-storage.test.ts` tests added in this fix.

## Deviations from the plan

None from the Reviewer's fix-direction — the shared helper lives in
`lib/supabase-storage.ts` as suggested, and is used by both flagged call sites
(`getDocumentSignedUrl`, `triggerExtraction`) plus `actions/tax-planning.ts`'s two read
paths (an extension beyond what the Reviewer named by line number, but squarely inside
"everywhere `Document.fileKey` is used to decide which bucket to read/sign/download from,"
which the task instructions asked for explicitly).

One thing I deliberately did *not* do, flagged as an open item below rather than silently
decided: I did not reconcile the apparent physical-path mismatch between
`uploadTaxDocumentCore`'s upload (unstripped `taxes/` key) and the pre-existing read
path's stripped key — I preserved the existing (possibly already-buggy in production, but
unverifiable from here) behavior rather than changing it, since that reconciliation is a
separate, higher-risk question from the one this task asked me to fix.

## Open items

- **Possible pre-existing, out-of-scope bug in `actions/tax-planning.ts`'s tax-document
  upload/read path**: `uploadTaxDocumentCore` uploads with the *unstripped* key
  `taxes/{entityId}/{docId}.ext` (i.e., the physical object ends up nested under a `taxes/`
  folder inside the `taxes` bucket), but the pre-existing read path (which I preserved
  as-is in the new shared helper) strips the `taxes/` prefix before requesting a signed
  URL/download — requesting a *different* physical path than where the bytes were written.
  If my reading of `lib/supabase-storage.ts`'s `uploadFile`/`downloadFile`/`getTaxSignedUrl`
  is correct, this would mean **every tax document ever uploaded through
  `uploadTaxDocumentCore` currently 404s when viewed**, independent of and pre-dating this
  task's `statements/` bug. I did not verify this against the real Supabase bucket (no
  access from this environment), and did not change either side of it, because: (a) it's
  not the bug this task was scoped to fix, (b) the request framing described the `taxes/`
  routing as "already correctly routed," so I treated resolving that discrepancy as out of
  scope rather than assume my own static-reading analysis overrides that framing, and (c)
  "fixing" it in either direction without live verification risks breaking whichever side
  currently happens to work in production. Recommend a follow-up task that inspects the
  actual Supabase `taxes` bucket contents (e.g. via `supabase storage list`) to determine
  which side is actually correct before touching either the upload or the read path.
- The Reviewer's sidebar/Mezzo nit (above) is unresolved by design — left as a product
  decision for the user.
