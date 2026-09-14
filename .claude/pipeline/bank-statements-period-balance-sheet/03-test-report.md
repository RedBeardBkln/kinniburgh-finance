# Test Report — Bank Statements / Period Balance Sheet

## FINAL VERDICT (after re-verification below): PASS (with an urgent, separate, out-of-scope production data-access issue flagged — see "Re-verification (bucket-routing fix)" section at the bottom)

## Original Verdict (first pass, before Coder's fix): FAIL

A confirmed, reproducible financial-correctness bug in `lib/period-balance-sheet.ts`'s
`buildPeriodBalanceSheet` will silently overstate equity on every period balance sheet
that includes a bank-statement-confirmed liability account (credit card, mortgage, or
loan) — which is a normal, expected case for this household's business entities, and is
the entire point of this feature. This is not a hypothetical/contrived edge case: it
follows directly from the sign convention the feature's own extraction prompt documents
for itself. Full details below.

**This defect has since been fixed and independently re-verified — see the
"Re-verification" section below for the current, authoritative PASS verdict. The
sections immediately following (checklist, defects, etc.) are the original first-pass
findings, kept for history.**

## Acceptance criteria checklist

Since no plan document exists for this task, criteria below are the 9 verification
points from the task instructions.

1. **Money handling — integer cents / Decimal, never floats doing arithmetic.** ❌ FAIL
   (see Defect 1). Everything else is integer-cents-clean: `lib/period-balance-sheet.ts`
   never does float arithmetic on money; `actions/bank-statements.ts` stores
   `Prisma.Decimal` in the DB and converts via `centsToDecimal()`/`.toNumber() * 100`
   only in the same pattern already used by `lib/reports.ts` and `actions/net-worth.ts`.
   `fmtDollars(cents: number)` in the new `exportPeriodBalanceSheetCsv`
   (`actions/reports.ts:207-209`) is byte-identical to the existing, already-accepted
   `fmtDollars` in `exportBalanceSheetCsv` (`actions/reports.ts:154-156`) — this is an
   established pattern in this file, not a new deviation, and formats an already-summed
   integer-cents value, which is fine per CLAUDE.md's carve-out. The actual defect is a
   **sign-normalization bug**, not a float-precision bug — see Defect 1.

2. **Auth — every server action calls `requireAuth()`/`auth()` first.** ✅ PASS. Checked
   every exported function in `actions/bank-statements.ts`:
   `uploadBankStatement` (line 153), `uploadBankStatementsBatch` (188),
   `listBankStatements` (248), `listEntityAccounts` (274), `confirmBankStatement` (305),
   `retryStatementExtraction` (355), `archiveBankStatement` (430),
   `getPeriodBalanceSheet` (449) — all call `requireAuth()`/`await requireAuth()` as the
   first statement in the function body. `requireAuth()` itself (lines 16-20) correctly
   throws `Unauthorized` when there's no session.

3. **Archive-only / soft delete — `BankStatement.archivedAt` respected.** ✅ PASS (with
   one stylistic note, not a defect). `listBankStatements` (251), `getPeriodBalanceSheet`
   (458), `listEntityAccounts`/`uploadStatementCore`'s account lookups (276, 58) and
   `page.tsx`'s live-fallback account query (137) all filter `archivedAt: null` at the DB
   level. `confirmBankStatement` (313-316) and `retryStatementExtraction` (357-360) use
   `findUnique` without an `archivedAt: null` WHERE clause but immediately check
   `if (!statement || statement.archivedAt) return { error: ... }` before any further
   read/write — functionally equivalent, just checked in application code instead of the
   query. `archiveBankStatement` never hard-deletes (`data: { archivedAt: new Date() }`
   only) — correct per CLAUDE.md's tax-retention rule.

4. **Migration matches schema; `prisma migrate status` confirms already-applied.**
   ✅ PASS. Read `prisma/schema.prisma`'s committed `BankStatement` model (lines 411-438)
   against `prisma/migrations/20260908120000_bank_statements/migration.sql` field by
   field — column names, types (`Decimal(14,2)` ↔ `DECIMAL(14,2)`, `Json?` ↔ `JSONB`,
   nullability, `@default`/`DEFAULT`, the `documentId` unique index, the
   `[entityId, periodEnd]` index, and all three FK constraints incl. `ON DELETE
   RESTRICT`/`SET NULL`) — no drift. Back-reference relations
   (`Entity.bankStatements` line 93, `Account.bankStatements` line 150,
   `Document.bankStatement` line 463) all present and consistent. Ran
   `npx prisma migrate status` myself against the real `.env` connection:
   ```
   31 migrations found in prisma/migrations
   Database schema is up to date!
   ```
   Confirms the migration is already applied in production and will be a clean no-op on
   the next `prisma migrate deploy`.

5. **Personal/business separation and entity scoping (IDOR check).** ✅ PASS, no
   regression. Every query in `actions/bank-statements.ts` is scoped by `entityId` (no
   query fetches a statement/account by ID alone without an entity filter, except
   `confirmBankStatement`/`retryStatementExtraction`/`archiveBankStatement`, which
   resolve `entityId` *from* the statement row itself rather than trusting a client-
   supplied value — correct). There is no per-user entity-membership check anywhere
   (any authenticated user can act on any entity's statements) — but this exactly
   matches the existing, already-shipped pattern in `actions/reports.ts`
   (`exportPlCsv`, `exportBalanceSheetCsv`, `exportCpaBundle` all accept a bare
   `entityId` with zero membership check), which is consistent with CLAUDE.md's rule 4
   ("two-person household... shared visibility") — this app's authorization model is
   session-presence, not per-entity ACLs, by design. Not a new deviation.

6. **`getPeriodBalanceSheet` output shape / logic.** ✅ PASS on shape and query logic,
   but its output is the *input* to the buggy function (Defect 1). Verified
   `getPeriodBalanceSheet` (`actions/bank-statements.ts:444-487`) returns
   `{ snapshots, accounts }`, and both call sites (`app/business/[slug]/balance-
   sheet/page.tsx:123-128` and `actions/reports.ts:192-197`) correctly destructure and
   feed it into `buildPeriodBalanceSheet(snapshots, accounts, period)` — the shapes
   line up and `pnpm typecheck` is clean. The per-account "pick latest statement inside
   the period" logic in `pickLatestClosingBalances` (`lib/period-balance-sheet.ts:123-
   139`) is sound and covered by tests (overlapping monthly/quarterly statements,
   accounts with no statement in period, unlinked statements keyed by
   institution+mask). Minor doc/code mismatch: the function's comment says "Only
   statements fully inside the period are considered" (`lib/period-balance-sheet.ts:121`)
   but the code only checks `periodEnd` against the period bounds, not `periodStart` —
   this doesn't cause incorrect output for the point-in-time balance-sheet use case (an
   annual statement's Dec 31 closing balance legitimately represents the account's state
   as of a December-month query), but the comment overstates what's actually checked.
   Not blocking, just a stale comment.

7. **UI copy — no financial-advice overreach.** ✅ PASS. Skimmed
   `components/bank-statements/statement-upload-form.tsx`,
   `components/bank-statements/statements-table.tsx`,
   `app/business/[slug]/statements/page.tsx`, and the balance-sheet page additions. All
   copy is observational/reconciliation language ("Extracted N accounts... Review and
   confirm below", "Statements are stored permanently in the tax document vault", "Period
   figures use closing balances from uploaded bank statements... Confirm all figures with
   your CPA — this is not financial advice."). No investment/tax advice claims found.

8. **Tests — meaningful or superficial?** ⚠️ PARTIAL. `period-balance-sheet.test.ts`'s
   period-math tests are genuinely good (leap-year Feb 29 vs. non-leap Feb 28, Q1
   spanning Feb, 30- vs. 31-day months, invalid selector rejection). But the
   `buildPeriodBalanceSheet` tests use a **positive** `closingBalanceCents: 320_000` for
   the credit-card fixture (test file, original line 122) — the opposite sign of what the
   feature's own extraction prompt documents as the expected real-world value for a
   credit card (see Defect 1) — so the suite never exercised the actual bug before this
   review. `bank-statement-extract.test.ts` only tests the pure JSON-parsing function
   (reasonable: the Anthropic API call itself is a third-party boundary, appropriately
   left untested per this repo's "mock at the function boundary" convention) but has no
   case for a negative `closingBalanceCents` (credit-card-style) value either, even
   though the prompt explicitly documents that shape.

9. **Full suite run, my own commands, real output:**
   ```
   $ npx prisma migrate status
   31 migrations found in prisma/migrations
   Database schema is up to date!

   $ pnpm typecheck
   $ tsc --noEmit
   (clean, no output, exit 0)

   $ pnpm lint
   ✖ 43 problems (0 errors, 43 warnings)
   0 errors and 1 warning potentially fixable with the `--fix` option.
   (all 43 warnings are in pre-existing files unrelated to this feature — none in
   lib/period-balance-sheet.ts, lib/bank-statement-extract.ts, actions/bank-
   statements.ts, actions/reports.ts, or components/bank-statements/; confirmed with
   `pnpm lint | grep -i "bank-statement\|period-balance"` → no matches)

   $ pnpm test   (before my added test)
   Test Files  36 passed (36)
        Tests  420 passed (420)

   $ pnpm vitest run lib/__tests__/period-balance-sheet.test.ts   (after my added test)
   Test Files  1 failed (1)
        Tests  1 failed | 15 passed (16)
   ```

## Tests added

Added one regression test to `lib/__tests__/period-balance-sheet.test.ts`
(`buildPeriodBalanceSheet > "normalizes a liability's signed closing balance so equity
is reduced, not inflated..."`) that constructs a $10,000 checking account + a $3,200
credit-card debt (using the negative-cents convention the extraction prompt itself
documents) and asserts the balance sheet should show `totalLiabilitiesCents: 320_000`
and `equityCents: 680_000`. This test currently **fails** — it documents Defect 1 as a
concrete, permanent regression check for whichever fix the Coder applies. I did not
modify any implementation file.

## Defects found

### Defect 1 (blocking, high severity): liability sign not normalized — equity is
inflated instead of reduced by the debt amount

**Where:** `lib/period-balance-sheet.ts:158-180` (`buildPeriodBalanceSheet`), read
together with `lib/bank-statement-extract.ts:36` (the extraction prompt's own documented
convention: `"All dollar amounts in integer cents (negative = negative balance, e.g.
credit cards)."`).

**Repro (exact, run via vitest):**
```ts
import { buildPeriodBalanceSheet, monthRange } from "@/lib/period-balance-sheet";

const ACCOUNTS = [
  { id: "acct-checking", nickname: "Checking", accountType: "checking" },
  { id: "acct-cc", nickname: "Capital One Card", accountType: "credit_card" },
];
const statements = [
  { accountId: "acct-checking", accountMask: "1234", institutionName: "JCSB", closingBalanceCents: 1_000_000, periodEnd: "2026-08-31" }, // $10,000 checking
  { accountId: "acct-cc", accountMask: "9999", institutionName: "Capital One", closingBalanceCents: -320_000, periodEnd: "2026-08-31" }, // $3,200 owed, per the extraction prompt's own sign convention
];
const result = buildPeriodBalanceSheet(statements, ACCOUNTS, monthRange(2026, 8));
console.log(result.totalLiabilitiesCents, result.equityCents);
```
**Actual output (confirmed by running it):** `totalLiabilitiesCents = -320000`,
`equityCents = 1320000` ($13,200).

**Expected:** a household/entity with $10,000 in checking and $3,200 owed on a credit
card has $6,800 of equity, not $13,200. `totalLiabilitiesCents` should be `320000`
(positive magnitude) and `equityCents` should be `680000`.

**Why this happens:** `buildPeriodBalanceSheet` pushes `snap.closingBalanceCents`
straight into the `liabilities` array (`lib/period-balance-sheet.ts:167`) with no sign
normalization, then computes `equityCents: totalAssetsCents - totalLiabilitiesCents`
(line 194). When a liability's closing balance is negative — which is not an edge case,
it is the *documented, expected* value for every credit card statement per the
extraction prompt the Coder wrote themselves — subtracting a negative total liability
*adds* the debt to equity instead of subtracting it. This is a $6,400 swing in the
example above (double the debt, since it both fails to subtract and adds).

This directly contradicts an established, already-shipped convention in this exact
codebase: both `lib/reports.ts:127` (`computeBalanceSheet`,
`const amountCents = Math.round(balance.abs().toNumber() * 100);`) and
`actions/net-worth.ts:105` (`computeNetWorth`,
`const balanceCents = Math.abs(Math.round(a.currentBalance.toNumber() * 100));`) both
take the absolute value of a liability's balance before including it in totals, precisely
so that `totalAssets - totalLiabilities` always subtracts a positive magnitude. The new
statement-driven code is the only balance-sheet-shaped calculation in the repo that
skips this normalization.

**Compounding factor:** the manual-confirm UI (`components/bank-statements/statements-
table.tsx:319-327`, "Closing balance ($)" field, placeholder `"13100.00"`) gives the user
no indication that a credit card's owed balance should be entered as a *negative* number
— a person confirming/correcting a statement by hand will naturally type the positive
amount they owe (e.g. "3200.00"), which would coincidentally avoid the bug for that one
row, but is inconsistent with what the AI-extraction path produces for the same kind of
account, and there is no visible guidance either way. This isn't a separate defect so
much as a symptom of the same missing sign-handling: the codebase needs one clear,
enforced convention (normalize to positive liability magnitudes, matching
`computeBalanceSheet`/`computeNetWorth`) rather than trusting the sign to arrive correct
from two different input paths.

**Severity:** High / blocking. This is the core output of the feature — an inaccurate
balance sheet for exactly the account types (credit card, mortgage, loan) most likely to
appear in the three business entities' real statements. It will not throw, crash, or fail
type-checking; it will silently produce a wrong number that looks plausible, which is the
worst failure mode for financial reporting.

**Fix ownership:** implementation fix belongs to the Coder — likely: take `Math.abs()`
of a snapshot's `closingBalanceCents` when constructing a `liabilities` line in
`buildPeriodBalanceSheet` (mirroring `lib/reports.ts`/`actions/net-worth.ts`), and/or add
UI guidance in `statements-table.tsx` clarifying that liability closing balances
represent a positive amount owed regardless of how the source data is signed. I did not
make this change myself — only added the regression test.

### Minor, non-blocking observations (not filed as separate defects, noted for
completeness)

- `lib/period-balance-sheet.ts:121`'s comment ("Only statements fully inside the period
  are considered") slightly overstates what the code checks (only `periodEnd`, not
  `periodStart`, is bounded) — doesn't cause wrong output for this feature's point-in-
  time use case, just a stale/imprecise comment.
- The asset-side "overdraft" test (`period-balance-sheet.test.ts`, "handles negative
  balances (overdraft) as signed cents") passes a negative balance straight through as a
  reduced asset total, which is directionally reasonable for an overdrawn checking
  account, but is itself inconsistent with `computeBalanceSheet`'s `abs()`-everything
  convention on the asset side too (a live-view overdraft would show as a *positive*
  asset there). This is a pre-existing inconsistency in how the codebase treats signed
  asset balances generally, not something introduced by this task, and out of scope to
  fix here — flagging only so it isn't assumed already resolved.

## Re-verification (2026-09-13, after Coder's fix)

### Verdict: PASS

The fix is correct, targeted, and does not weaken the regression test or introduce a
new defect. Verified independently, not just from the Coder's report.

### 1. `lib/period-balance-sheet.ts` diff review — correct

Read the current `buildPeriodBalanceSheet` (lines 158-188). Confirmed:
- `isLiability` is computed from `LIABILITY_TYPES.has(type)` (credit_card/mortgage/loan)
  exactly as before.
- The `PeriodBalanceLine.balanceCents` field is now built with a ternary:
  `isLiability ? Math.abs(snap.closingBalanceCents as number) : (snap.closingBalanceCents as number)`.
  Liabilities get `Math.abs()`'d; assets are passed through completely unchanged
  (identical code path to before the fix).
- Sanity-checked the asset-side "overdraft" concern explicitly: an overdrawn checking
  account (`accountType: "checking"`, which is in `ASSET_TYPES`, not `LIABILITY_TYPES`)
  takes the `: (snap.closingBalanceCents as number)` branch — untouched, still signed.
  Confirmed by the pre-existing "handles negative balances (overdraft) as signed cents"
  test (line 157-164 of the test file), which still asserts
  `totalAssetsCents === -15_000` and passes. The fix does **not** accidentally flip an
  overdrawn asset to positive — it only affects the liability branch.
- Comment added at lines 169-173 explaining the rationale and citing
  `lib/bank-statement-extract.ts`'s `STATEMENT_PROMPT` plus the matching convention in
  `lib/reports.ts`/`actions/net-worth.ts` — accurate, matches what I verified in Defect 1
  originally.

### 2. Regression test — not weakened

Read the current `lib/__tests__/period-balance-sheet.test.ts` (lines 166-180). The test
I originally added is present, unmodified in substance:
- Same fixture: $10,000 checking (`closingBalanceCents: 1_000_000`) + credit card debt
  entered as `closingBalanceCents: -320_000` (negative, per the extraction prompt's own
  documented convention).
- Same assertions: `totalAssetsCents === 1_000_000`, `totalLiabilitiesCents === 320_000`,
  **`equityCents === 680_000`** ($6,800) — the exact real figure from my original defect
  report, not a diluted or trivially-true assertion. Ran it standalone to confirm it's
  not silently skipped or passing for the wrong reason:
  ```
  $ pnpm vitest run lib/__tests__/period-balance-sheet.test.ts
  ✓ lib/__tests__/period-balance-sheet.test.ts (16 tests) 16ms
  Test Files  1 passed (1)
       Tests  16 passed (16)
  ```
  All 16 tests pass, including both the original positive-fixture liability test
  (line 118-132, `closingBalanceCents: 320_000`) and my negative-fixture regression test
  — confirming the fix is sign-agnostic, matching the "either sign works" claim.

### 3. Full suite — my own run, real output

```
$ pnpm typecheck
$ tsc --noEmit
(clean, no output, exit 0)

$ pnpm lint
✖ 43 problems (0 errors, 43 warnings)
(all 43 warnings are in unrelated pre-existing files: retroactive-rule-modal.tsx,
vault-client.tsx, vault-verify-client.tsx, doc-extract.test.ts, forecast.test.ts,
encrypt.ts, plaid-sync.ts, seed.ts — none in lib/period-balance-sheet.ts,
lib/bank-statement-extract.ts, actions/bank-statements.ts, actions/reports.ts, or
components/bank-statements/. Same 0-errors/43-warnings baseline as before the fix.)

$ pnpm test
Test Files  36 passed (36)
     Tests  421 passed (421)
```
420 pre-fix baseline + 1 new regression test = 421, all green. No new failures, no
skipped tests, no test count regression.

### 4. `components/bank-statements/statements-table.tsx` UI note — accurate, no contradiction

Read lines 319-331. The "Closing balance ($)" field now has a helper line:

> "Credit card, mortgage, or loan balances: enter the amount owed. Positive or negative
> both work — the balance sheet always treats it as debt owed."

This is factually correct against the fixed implementation: `Math.abs()` is applied to
any liability-classified line regardless of input sign, so both a manually-typed
positive "3200.00" and an AI-extracted "-320000" cents value produce the same correct
$3,200 liability line. No contradiction with the accepted-either-sign behavior. The
Coder's stated rationale (not forcing a single stored-sign convention, to avoid also
having to touch `confirmBankStatement`'s validation) is reasonable and matches what's
actually implemented — verified `actions/bank-statements.ts`'s `confirmBankStatement`
was *not* touched (no sign-normalization/validation added there), consistent with the
implementation notes.

### 5. Other consumers of `closingBalance` / `buildPeriodBalanceSheet` output — no regression

Traced every consumer:
- `actions/reports.ts`'s `exportPeriodBalanceSheetCsv` (lines 176-242): sums
  `fromStatements.liabilities` (now `Math.abs()`'d by the fixed function) with
  `live.liabilities` from `computeBalanceSheet` (already `Math.abs()`'d at
  `lib/reports.ts:127`, confirmed by re-reading that line). Both sides are positive
  magnitudes before the final `totalAssets - totalLiabilities` subtraction at line
  238 — no double-negation, no sign mismatch between the two sources being merged.
- `app/business/[slug]/balance-sheet/page.tsx` (lines 95-168): same merge pattern —
  `fromStatements.liabilities.map(l => ({ ...amountCents: l.balanceCents }))` combined
  with `live.liabilities` (already positive from `computeBalanceSheet`), then reduced
  and subtracted from assets at line 168. Consistent, correct.
- `actions/bank-statements.ts`: `closingBalanceCents` is read from/written to the DB via
  `centsToDecimal()`/`Math.round(s.closingBalance.toNumber() * 100)` (lines 122-123,
  337-338, 480-481) — a pure sign-preserving round-trip through `Prisma.Decimal`, no
  normalization applied at this layer (correct — normalization is intentionally
  centralized in `buildPeriodBalanceSheet`, per the implementation notes).
- No other call site in the repo reads `BankStatement.closingBalance` or consumes
  `buildPeriodBalanceSheet`'s output (confirmed via grep for `closingBalance` across the
  repo — only the files already covered above and test/schema/migration files touch it).

No other correctness regression found. The fix is scoped exactly to the reported
defect.

## Not tested

- `extractBankStatement`'s actual call to the Anthropic API (`lib/bank-statement-
  extract.ts:68-110`) — no live extraction was run against a real PDF/image; only the
  pure `parseStatementResponse` function was exercised (by the existing test suite and
  by reading the code). This matches the repo's established "mock at the function
  boundary, don't hit third-party services in unit tests" convention, so I'm not
  flagging its absence as a defect, but it means a live extraction — including whether
  Claude actually follows the "negative = credit card debt" instruction reliably in
  practice — was not independently verified end-to-end.
  - This is a fully offline dev environment (no `pnpm dev` server exercised, no browser
  click-through of the upload/confirm/statements UI or the balance-sheet page's period
  picker) — all UI review was by reading source, not by running the app. I did not spin
  up the dev server or click through the flow live.
- Supabase file storage (`uploadTaxFile`/`downloadTaxFile` in `lib/supabase-storage.ts`)
  was read for call-site correctness but not exercised with a real upload/download round
  trip.
- Concurrency/race conditions (e.g. two simultaneous `confirmBankStatement` calls for the
  same statement, or an `archiveBankStatement` racing a `getPeriodBalanceSheet` read)
  were not tested — low likelihood in this two-user household app and not flagged as a
  defect, just unverified.

## Re-verification (bucket-routing fix)

### Verdict: PASS for this task's scope (the `statements/` prefix Document Vault crash)

**But: a real, live, pre-existing production bug was independently confirmed during this
re-verification — see item 4 below. It is out of scope for this task (it predates it and
isn't caused by it), but it needs a dedicated follow-up task, soon.**

### 1. `getDocumentFileSignedUrl`/`downloadDocumentFile` prefix-dispatch logic — correct

Read the current `lib/supabase-storage.ts:258-268`. The dispatch is:
- `taxes/` prefix → `getTaxSignedUrl`/`downloadTaxFile` with the prefix **stripped**
  (`fileKey.slice("taxes/".length)`).
- `statements/` prefix → same functions, key **unstripped**.
- anything else → `getReceiptSignedUrl`/`downloadReceiptFile`, unstripped (`receipts` bucket).

Traced why the two `taxes`-bucket prefixes are handled differently, against the actual
upload call sites (not assumed):
- `actions/bank-statements.ts:66-69` (`uploadStatementCore`): `fileKey =
  \`statements/${entity.id}/${statementId}.${ext}\`` → `uploadTaxFile(buffer, fileKey,
  file.type)`. `uploadTaxFile` → `uploadFile(buffer, TAX_BUCKET, fileKey, ...)`, which
  POSTs to `.../object/${bucket}/${fileKey}` — i.e. the physical object path *is* the
  full `statements/{entityId}/{statementId}.ext` string, unstripped, inside the `taxes`
  bucket. Its own reader, `retryStatementExtraction` (`actions/bank-statements.ts:373`),
  calls `downloadTaxFile(doc.fileKey)` **unstripped** — self-consistent already. The new
  shared helper matches this: `statements/` → unstripped. Correct.
- `actions/tax-planning.ts:169-171` (`uploadTaxDocumentCore`): `fileKey =
  \`taxes/${entityId}/${docId}.${ext}\`` → `uploadTaxFile(buffer, fileKey, mimeType)` →
  same `uploadFile` mechanics → physical object path is the full, unstripped
  `taxes/{entityId}/{docId}.ext` inside the `taxes` bucket (i.e. a literal `taxes/`
  subfolder nested inside the `taxes` bucket). But the **read** path — both the
  pre-existing `getTaxSignedUrlSafe` (already committed in `HEAD` at `c97fc9c`, dated
  2026-08-31, well before this task) and the new shared `getDocumentFileSignedUrl` that
  intentionally preserves it — strips the `taxes/` prefix before calling
  `getTaxSignedUrl`/`downloadTaxFile`, requesting object path
  `{entityId}/{docId}.ext` (no nested `taxes/` folder). **This is a physical-path
  mismatch between write and read**, independent of anything this task changed. See item
  4 for live confirmation this is a real, currently-broken condition in production, not
  a hypothetical.

The Coder's fix does not introduce this mismatch — it already existed in committed code
before this session's `statements/`-prefix work began, and the fix explicitly (and
correctly, given the task's scope) chose to preserve rather than "fix" it, since
reconciling it without live verification risks guessing wrong. I was able to do that
live verification (below) since I have production DB/Storage access from this
environment.

### 2. `actions/documents.ts` — old `receipts`-only bug confirmed gone

Read `actions/documents.ts:99-103` and `:117-129`. `getDocumentSignedUrl` now calls
`getDocumentFileSignedUrl(doc.fileKey)`; `triggerExtraction` now calls
`downloadDocumentFile(doc.fileKey)`. Neither hardcodes `getReceiptSignedUrl`/
`downloadReceiptFile` anymore. This is exactly the fix for the Reviewer's blocking
finding — a `statements/`-prefixed `Document` row will now resolve to the `taxes`
bucket instead of throwing against `receipts`. Confirmed the import line
(`lib/supabase-storage.ts`) pulls in the new shared helpers plus `uploadReceiptFile`
(still needed by `uploadDocument`, unchanged).

### 3. `actions/tax-planning.ts` — switched to shared helper, no new regression

`getTaxDocumentSignedUrl` (`:352-360`) and `downloadTaxDocument` (`:362-366`) now call
the shared `getDocumentFileSignedUrl`/`downloadDocumentFile` directly, replacing the
old private `getTaxSignedUrlSafe`. Behavior for `taxes/`-prefixed keys is byte-identical
to before (same strip-then-route logic, just centralized) — confirmed by reading both
the current file and the pre-session committed version (`git show HEAD:actions/tax-
planning.ts`), which had the identical `if (fileKey.startsWith("taxes/"))
{ ...slice("taxes/".length)... }` branch. No behavior change for existing tax documents
from this particular switch — the switch doesn't fix or break the pre-existing bug in
item 4, it just relocates identical logic. Confirmed via the test suite (`pnpm test`
below) that nothing in the tax-planning flow regressed.

### 4. Investigation of the Coder's flagged open item — CONFIRMED REAL, LIVE, PRE-EXISTING PRODUCTION BUG

This is not a false alarm and not something the new fix resolves as a side effect. I
verified this directly against the real production Supabase Postgres DB and Storage
buckets (read-only), not just by re-reading the code:

**Step 1 — real DB query** (`Document` rows with `fileKey` starting `taxes/`, via a
throwaway read-only Prisma script run from the repo root against the live `DATABASE_URL`
in `.env`, deleted immediately after):
```
Documents with fileKey starting 'taxes/': 10
{"fileKey":"taxes/6f55fa50-9d94-47a8-92d6-2cc5abeac714/ecca3a6a-....pdf","docType":"w2","archivedAt":null,...}
... (10 total: w2 x5, 1099 x3, other x1, plus one more w2 — all archivedAt: null, all
created 2026-08-31 to 2026-09-01, all under the same entityId)

Documents with fileKey starting 'statements/': 0
```
These are real, non-archived, currently-live tax documents uploaded through the
prior-year-tax-document feature earlier this session (commit `64ca8bc`). No
`statements/`-prefixed `Document` rows exist yet in production (bank statement upload
hasn't been used live), so that prefix's correctness (confirmed correct above) hasn't
been exercised in prod yet either way.

**Step 2 — real Supabase Storage list query** (same throwaway-script technique, hitting
the live Storage REST API's `list` endpoint, read-only, no file contents downloaded):
```
list(bucket=taxes, prefix="6f55fa50-.../")       -> status 200, []            <- what the READ path requests
list(bucket=taxes, prefix="taxes/6f55fa50-.../") -> status 200, [10 objects]  <- where the bytes actually ARE
```
This directly confirms, against the real bucket contents: all 10 tax documents physically
exist at `taxes/{entityId}/{docId}.ext` (i.e. nested under a literal `taxes/` subfolder
*inside* the `taxes` bucket, exactly as `uploadTaxDocumentCore`'s unstripped upload key
would produce), and **nothing exists** at the stripped path
(`{entityId}/{docId}.ext`) that `getTaxDocumentSignedUrl`/`downloadTaxDocument` actually
request.

**Conclusion:** every one of these 10 real W2/1099/other tax documents currently 404s
if a user tries to view or download it via `getTaxDocumentSignedUrl`/`downloadTaxDocument`
in production today. This is:
- **Real**, not a false alarm — confirmed against live DB rows and live Storage bucket
  contents, not just static code reading.
- **Pre-existing**, not introduced by this task or this session's bucket-routing fix —
  the stripping behavior was already committed in `HEAD` before this task started
  (`c97fc9c`, 2026-08-31), and the current fix explicitly preserves it rather than
  changing it.
- **Not resolved as a side effect** of the current fix — the shared helper's `taxes/`
  branch does exactly what the old code did (strip-then-route), so the mismatch persists
  unchanged after this fix.
- **Currently affecting real user data** — the 10 documents found are genuine tax
  documents (W2s, 1099s) uploaded by the household this week, not test fixtures.

**Recommendation:** this needs a dedicated, urgent follow-up task, separate from this
pipeline task, to fix the physical-path mismatch — either (a) change
`uploadTaxDocumentCore` to upload with the stripped key (matching what reads expect,
requiring a one-time migration to move/re-upload the 10 existing objects to the
unnested path), or (b) change the read path to stop stripping `taxes/` (simpler, no data
migration needed, since the object already exists at the nested path — just requires the
shared helper's `taxes/` branch to route like `statements/`'s: unstripped). Given no data
migration is required, (b) is very likely the lower-risk fix, but this deserves its own
scoped task with its own test coverage, not a rushed patch appended here.

I did not modify any implementation file to fix this (out of scope for this Tester
task, and the root cause lives in `actions/tax-planning.ts`, not
`lib/supabase-storage.ts`'s new code, which faithfully preserves pre-existing behavior
as directed).

### 5. `lib/__tests__/supabase-storage.test.ts` — meaningful coverage

Read all 6 tests. They mock only `global.fetch` (the real network boundary) and assert,
for each of the three prefixes (`statements/`, `taxes/`, unrecognized/`documents/`):
which bucket segment (`taxes` vs `receipts`) appears in the constructed request URL, and
— critically — for `taxes/` vs `statements/`, whether the prefix is stripped from the
object key in the request path (asserting `.../sign/taxes/e1/d1.pdf` and explicitly
`.not.toContain(".../sign/taxes/taxes/")` for the `taxes/` case, vs. the full unstripped
key present for `statements/`). This directly exercises the stripping-vs-not-stripping
distinction, not just "does it pick the right bucket." Ran standalone:
```
$ pnpm vitest run lib/__tests__/supabase-storage.test.ts
✓ lib/__tests__/supabase-storage.test.ts (6 tests) 9ms
Test Files  1 passed (1)
     Tests  6 passed (6)
```
Genuinely meaningful, not superficial — they would have caught the exact page-crash bug
being fixed (unrecognized prefix routing to the wrong bucket) had they existed before it
shipped.

### 6. Full suite — my own run, real output

```
$ pnpm typecheck
$ tsc --noEmit
(clean, no output, exit 0)

$ pnpm lint
✖ 43 problems (0 errors, 43 warnings)
(same baseline as every prior run this task — retroactive-rule-modal.tsx, vault-
client.tsx, vault-verify-client.tsx, doc-extract.test.ts, forecast.test.ts, encrypt.ts,
plaid-sync.ts, seed.ts — all pre-existing, unrelated to this task; zero warnings in any
file touched by the bucket-routing fix)

$ pnpm test
Test Files  37 passed (37)
     Tests  427 passed (427)
```
Matches the Coder's reported counts exactly (37 files / 427 tests, up from the prior
36/421 baseline by exactly the 6 new `supabase-storage.test.ts` tests).

### 7. Nit fixes — spot-checked, no new issues

- `lib/period-balance-sheet.ts:116-122` — comment now accurately describes that only
  `periodEnd` (bounded against both `period.start` and `period.end`) is checked, not a
  statement's own `periodStart`. Matches the actual code at line 133.
- `components/bank-statements/statements-table.tsx:73,165-166,334-339` — the liability
  helper caption is now gated behind `isLiabilityAccount` (derived from
  `LIABILITY_ACCOUNT_TYPES.has(selectedAccountType)`), only rendering for
  credit_card/mortgage/loan account types. Confirmed present and correctly scoped.
- `app/business/[slug]/balance-sheet/page.tsx` — confirmed the `db` import was removed
  (grepped imports, no `db.` calls remain) and the file ends with a trailing newline
  (`}\n`).
- `components/bank-statements/statement-upload-form.tsx:231` — copy now reads "Review
  and confirm in the statements table below," no longer references a nonexistent
  "statement's review page."
- No regressions introduced by any of these — full suite (above) still 427/427 passing,
  typecheck clean.

### Verification technique note

Items 1 and 4 were verified against the real production Supabase Postgres DB
(`DATABASE_URL` in `.env`) and Storage REST API (`SUPABASE_URL`/`SUPABASE_SERVICE_KEY`
in `.env`) via two throwaway, read-only `.mjs` scripts written to the repo root (required
for Prisma client module resolution) and deleted immediately after use — confirmed via
`git status --porcelain` that no trace remains. All queries were read-only (`findMany`,
Storage `list`) — no writes, no file downloads, no data modified.
