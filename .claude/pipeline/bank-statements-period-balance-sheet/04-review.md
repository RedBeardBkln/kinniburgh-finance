# Review — Bank Statements / Period Balance Sheet

## Verdict: CHANGES_REQUESTED

## Route-back target: coder

This is an implementation-scope integration gap, not a flaw in the overall approach
(statement-driven period balance sheets backed by uploaded statements, with a live-balance
fallback, is a sound design and mostly well executed — see "What's good" below). No planner
stage exists for this task and none is needed; the fix is a bounded, mechanical change to
existing bucket-routing logic.

---

## Findings

### 1. BLOCKING — new `statements/` fileKey prefix breaks the existing Document Vault (`/documents`) page for the whole household, not just this feature

**Where:** `actions/bank-statements.ts:66-81` (`uploadStatementCore`) creates `Document` rows
with `fileKey: "statements/${entity.id}/${statementId}.${ext}"`, uploaded via `uploadTaxFile`
into the **`taxes`** Supabase bucket (`lib/supabase-storage.ts:205-207`, `TAX_BUCKET = "taxes"`).

Every other consumer of `Document.fileKey` in the repo only knows about two prefixes:
- `actions/tax-planning.ts`'s `getTaxSignedUrlSafe` (lines 358-370) special-cases `taxes/`
  and falls back to `getReceiptSignedUrl` (the `receipts` bucket) for anything else.
- `actions/documents.ts`'s `getDocumentSignedUrl` (lines 95-98) and `triggerExtraction`
  (line 124, `downloadReceiptFile`) have **no** prefix awareness at all — they always target
  the `receipts` bucket.

Neither of these (both pre-existing, untouched by this task) recognizes the new `statements/`
prefix. A bank-statement-created `Document` row's bytes live in `taxes`, but every existing
reader assumes `receipts` for anything not explicitly `taxes/`-prefixed.

**Concrete, reachable failure — this is not hypothetical:**
`app/documents/page.tsx` (the shared, pre-existing "Document Vault" page, used by the whole
household for every tax document — not in this task's file list, and its default/landing view
has no filters applied) renders one `<ViewLink documentId={doc.id} />` per row
(`app/documents/page.tsx:180`). `ViewLink` (lines 211-223) is an **async Server Component**
with no per-row `Suspense`/error boundary that directly `await`s
`getDocumentSignedUrl(documentId)`. For any bank-statement `Document`, this calls
`getReceiptSignedUrl(doc.fileKey)` (`lib/supabase-storage.ts:133-153`) against the `receipts`
bucket for an object that only exists in `taxes`. Supabase's sign endpoint will return a
non-OK response for the missing object, and `getReceiptSignedUrl` explicitly
`throw`s (`lib/supabase-storage.ts:144-149`) in that case. Because nothing catches this in the
render path, the throw propagates to the nearest route-level `error.tsx` — **the entire
`/documents` page fails to render**, for every user, on every visit, as soon as a single bank
statement has been uploaded through this feature. `triggerExtraction`
(`actions/documents.ts:113-141`, reachable via the same page's "Review" link for any
`extractable` doc type, and `bank_statement` is in `EXTRACTION_TYPES`) has the identical
`downloadReceiptFile` bug and would silently mis-extract/fail instead of crashing, since it's
wrapped in try/catch — lower severity than the `ViewLink` crash, but same root cause.

**Why this wasn't caught earlier:** it's a side effect on a file *outside* this task's own
change list (`app/documents/page.tsx`, `actions/documents.ts` — confirmed via
`git diff HEAD` showing zero changes to either). The Tester's checklist was scoped to this
task's own files and correctly verified `archivedAt`/auth/entity-scoping within
`actions/bank-statements.ts` itself, but nothing in that checklist traced what happens when a
*new* fileKey shape lands in a table three other pre-existing code paths already read from
with hardcoded bucket assumptions. `docType: "bank_statement"` already existed as an option in
the older generic upload flow (`actions/documents.ts`'s `DOC_TYPES`) using the `documents/`
prefix into `receipts` — that path was internally consistent. This task reused the same
`docType` label but introduced a third, incompatible prefix/bucket combination.

**Fix direction (implementation-level, for the Coder):** centralize the prefix → bucket
resolution (ideally one shared helper in `lib/supabase-storage.ts`, e.g.
`resolveDocumentSignedUrl(fileKey)` / `resolveDocumentBuffer(fileKey)`) used by
`getDocumentSignedUrl`, `getTaxDocumentSignedUrl`/`getTaxSignedUrlSafe`, and
`triggerExtraction`, so a `statements/` prefix routes to `getTaxSignedUrl`/`downloadTaxFile`
the same way `taxes/` already does. Separately (and this is worth doing regardless of the
specific bug): `ViewLink` calling an external signing API with no error handling, inline in a
table row with no isolation, means *any* transient signing failure — not just this bug — takes
down the whole vault page; wrapping it in a try/catch that renders "Unavailable" for that row
instead of throwing would make this class of failure non-fatal going forward.

I traced this via static reading of the code and Supabase HTTP-error-handling logic (no
pipeline agent has live browser/dev-server access per prior sessions), but the throw path is
unambiguous and does not depend on any edge-case interpretation of Supabase's response
contract — `!res.ok` unconditionally throws.

### 2. Should-fix — non-blocking

- **`lib/period-balance-sheet.ts:120-121`** — stale comment ("Only statements fully inside the
  period are considered") overstates what's checked (only `periodEnd` is bounded, not
  `periodStart`). Doesn't affect correctness for the point-in-time use case; already flagged by
  the Tester and left as-is per instruction not to touch unrelated code. Still worth a follow-up
  cleanup.
- **`components/bank-statements/statements-table.tsx:327-330`** — the "enter the amount owed...
  either sign works" helper caption under "Closing balance ($)" renders unconditionally,
  regardless of which account type is selected in the row. For a checking/savings account this
  caption is irrelevant/confusing (there's no "amount owed" concept for an asset). Minor UX
  nit — consider showing it only when the selected account's `accountType` is a liability type.
- **`app/business/[slug]/balance-sheet/page.tsx`'s period branch** — fetches `liveAccounts` via
  a full `db.account.findMany` query (lines ~117-125) solely to check `liveAccounts.length > 0`
  for the `"statements+live"` vs `"statements"` source badge; the same information is already
  derivable from `liveAssets.length + liveLiabilities.length` computed two lines later from data
  already in memory (`live.assets`/`live.liabilities`, already fetched via `computeBalanceSheet`).
  Redundant DB round-trip, not incorrect — cheap cleanup opportunity.
- **`app/business/page.tsx`** gates the "Bank Statements →" quick link to `sudden-valley` and
  `ek-consulting` only, excluding `mezzo` — confirmed intentional and correct against
  `specs/03-business-finances.md` ("Mezzo: not yet formed/registered, no legal entity exists
  yet"), not a defect. However `components/app-sidebar.tsx`'s new "Bank Statements" nav item is
  unconditional across all business buckets including `mezzo` — inconsistent with the overview
  page's exclusion, though not harmful (the `/statements` page renders an empty-state
  gracefully with zero accounts). Nit-level inconsistency, not blocking.

### 3. Nits

- `app/business/[slug]/balance-sheet/page.tsx` has no trailing newline at end of file.
- `components/bank-statements/statement-upload-form.tsx`'s success message references
  "the statement's review page" — there is no separate per-statement review page/route in this
  feature (review happens inline in the same table via the "Review"/"Edit" toggle). Minor copy
  inaccuracy, not misleading in a harmful way, but slightly promises a page that doesn't exist.

---

## Verification performed independently (not just reading the write-ups)

- Read the full diff for `actions/reports.ts`, `app/business/[slug]/balance-sheet/page.tsx`,
  `app/business/page.tsx`, `components/app-sidebar.tsx` via `git diff HEAD`.
- Read `lib/period-balance-sheet.ts`, `lib/bank-statement-extract.ts`, `actions/bank-statements.ts`,
  both new components, and the new `statements/page.tsx` in full (not just the Coder/Tester's
  excerpted line ranges).
- Confirmed the liability `Math.abs()` fix is real, present, and correctly scoped to the
  `isLiability` branch only (asset/overdraft path untouched) — matches the Tester's
  re-verification claim exactly.
- Re-ran independently, from a clean shell:
  - `pnpm typecheck` → clean, exit 0.
  - `pnpm test` → `36 passed (36)` / `421 passed (421)` — matches the Tester's reported count.
  - `pnpm lint` → `0 errors, 43 warnings`, all in the same pre-existing unrelated files the
    Tester listed (`doc-extract.test.ts`, `forecast.test.ts`, `encrypt.ts`, `plaid-sync.ts`,
    `seed.ts`); zero warnings in any file this task touches.
- Confirmed `git diff HEAD -- prisma/schema.prisma` is empty (no pending schema changes needed),
  matching the request doc's claim.
- Read `prisma/migrations/20260908120000_bank_statements/migration.sql` in full; confirmed it's
  a standalone `CREATE TABLE` with FKs only to already-existing tables (`Entity`, `Account`,
  `Document`) — no later-dated committed migration (`20260912000000_tag_gl_code_mapping`,
  `20260913000000_notification_approval`) touches `BankStatement`, so the migration's
  timestamp sorting before those (despite being committed after) causes no ordering hazard on
  a fresh deploy, and is consistent with the production-application-order story in
  `00-request.md`. The out-of-band-applied-to-production reasoning is sound — committing this
  file is a clean no-op against the already-recorded migration history.
- Traced the `Document`/fileKey blast radius by hand (see Finding 1) — this is the one place I
  did not take the Tester's "no other consumer of `closingBalance`" scoping at face value,
  because their trace was scoped to `closingBalance`/`buildPeriodBalanceSheet` consumers, not to
  the separate, shared `Document.fileKey` surface this task's new upload path also writes into.
- Confirmed all 8 exported functions in `actions/bank-statements.ts` call `requireAuth()` as
  their first statement; confirmed `archiveBankStatement` never hard-deletes; confirmed
  `Account`/`Entity` lookups scope by `entityId` and (where new) apply `archivedAt: null`.
- Confirmed no UI copy overreaches into financial/tax advice — all copy is
  observational/reconciliation language with explicit CPA-review disclaimers, consistent with
  the rest of the app's existing balance-sheet/P&L pages.

## What's good

- The liability sign-normalization fix is precise, well-commented, cites the exact prior art
  it mirrors (`lib/reports.ts`, `actions/net-worth.ts`), and the regression test that pins it
  down is a real, non-trivial assertion (not a tautology) — genuinely good work by both Coder
  and Tester here.
- `lib/period-balance-sheet.ts` and `lib/bank-statement-extract.ts` are clean, pure,
  well-tested modules with no float arithmetic anywhere in the money path.
- Every server action in `actions/bank-statements.ts` is properly authenticated, and the
  archive-only convention for tax-relevant records is respected throughout.
- The period-selector UI (`PeriodPicker`/`PeriodPickerGroup`) and the "statements+live" /
  "live-only" fallback messaging on the balance-sheet page are thoughtful, transparent about
  data provenance, and give the user an honest picture of which numbers are statement-backed
  vs. live-synced — this is exactly the kind of disclosure CLAUDE.md's "no financial-advice
  overreach" rule wants to see done well.
- Batch upload correctly skips AI extraction for cost/speed reasons and says so plainly in the
  UI, rather than silently degrading.
- The migration-timestamp/production-state investigation in `00-request.md` held up under my
  own independent check — nothing to walk back there.

---

# Re-review (2026-09-13) — bucket-routing fix

## Verdict: APPROVED

This section covers the Coder's fix for the single blocking finding above (Finding 1:
Document Vault crash on the new `statements/` fileKey prefix). All prior should-fix/nit
items were also addressed by the Coder in the same pass except the sidebar/Mezzo
inconsistency, which was left as-is with an explicit, correct rationale (a product decision,
not a mechanical fix — I agree with leaving it).

## What I independently verified (not just the write-ups)

- Read the current `lib/supabase-storage.ts` in full. The new `getDocumentFileSignedUrl` /
  `downloadDocumentFile` prefix-dispatch functions (lines 258-268) are exactly as described:
  `taxes/` → `getTaxSignedUrl`/`downloadTaxFile` with the prefix stripped, `statements/` →
  same functions with the key used unstripped, anything else → the original
  `getReceiptSignedUrl`/`downloadReceiptFile` behavior. The accompanying comment block
  correctly documents all three live prefixes and their bucket/stripping rules. This is sound
  and does exactly what's needed to stop `statements/`-prefixed `Document` rows from being
  signed against the wrong bucket.
- Confirmed via `git diff HEAD -- actions/documents.ts`: `getDocumentSignedUrl` now calls
  `getDocumentFileSignedUrl(doc.fileKey)` (was unconditionally `getReceiptSignedUrl`), and
  `triggerExtraction` now calls `downloadDocumentFile(doc.fileKey)` (was unconditionally
  `downloadReceiptFile`). This is the precise fix for the reachable crash path I traced last
  time: `app/documents/page.tsx`'s `ViewLink` (still calling `getDocumentSignedUrl` at line
  212, unchanged) no longer throws for a bank-statement `Document`.
- Confirmed via `git diff HEAD -- actions/tax-planning.ts`: the old private
  `getTaxSignedUrlSafe` (which only special-cased `taxes/` and fell back to `receipts` for
  anything else, including `statements/`) was removed and both `getTaxDocumentSignedUrl` and
  `downloadTaxDocument` now delegate to the same shared helper. This closes a second,
  previously-unflagged instance of the identical bug (I had only traced `ViewLink`'s path
  last time; the Coder correctly extended the fix to this file's reads too, which the
  original finding's "everywhere `Document.fileKey` is used" framing already called for).
- Read `lib/__tests__/supabase-storage.test.ts` in full: 6 tests, mocking only
  `global.fetch` (the real network boundary), asserting for each of the three prefixes which
  bucket segment appears in the constructed request URL and whether the prefix is stripped.
  This is a genuine regression test for the crash scenario, not a tautology — it would fail
  if the dispatch logic regressed in either direction (wrong bucket, or wrong
  stripped/unstripped key causing a doubled-prefix 404).
- `retryStatementExtraction` in `actions/bank-statements.ts` was correctly left calling
  `downloadTaxFile(doc.fileKey)` directly (confirmed via `git diff` — this file has no diff
  from the prior review at all; it's untouched). It only ever handles keys it created itself
  (`statements/` prefix, always unstripped), so there's no routing ambiguity there and no
  reason to route it through the shared helper. Correct call by the Coder to leave it and to
  say so explicitly rather than silently leaving an inconsistency.
- `git status` shows no unexpected files touched — the diff is scoped to
  `lib/supabase-storage.ts`, `actions/documents.ts`, `actions/tax-planning.ts`, plus the
  should-fix/nit cleanups in `lib/period-balance-sheet.ts`,
  `components/bank-statements/statements-table.tsx`,
  `components/bank-statements/statement-upload-form.tsx`, and
  `app/business/[slug]/balance-sheet/page.tsx`. `git diff --stat HEAD` totals 7 files /
  366 insertions / 47 deletions, consistent with a bounded, mechanical fix plus cleanups —
  no scope creep.
- Independently re-ran, from a clean shell:
  - `pnpm typecheck` → clean, exit 0.
  - `pnpm lint` → `0 errors, 43 warnings` — identical warning set/count to every prior run
    this task, all in pre-existing files this task doesn't touch (spot-checked the file list
    against the diff above; no touched file appears in the warning output).
  - `pnpm test` → `37 passed (37)` files / `427 passed (427)` tests — matches both the
    Coder's and Tester's reported counts exactly.
- Spot-checked the should-fix/nit cleanups: the redundant `db.account.findMany` query in
  `app/business/[slug]/balance-sheet/page.tsx` is gone (replaced with
  `liveAssets.length + liveLiabilities.length`, derived from already-fetched data), and the
  file ends with a proper trailing newline. Did not find these load-bearing either way, but
  they're real and correctly done.

## On the separately-flagged tax-document upload/read path issue

The Coder's implementation notes and the Tester's re-verification both surface what looks
like a genuine, pre-existing, production-live bug in `actions/tax-planning.ts`'s tax-document
upload (`uploadTaxDocumentCore`, unstripped `taxes/` key) vs. its (pre-existing, preserved)
read path (strips `taxes/` before requesting). Per this task's instructions, that is out of
scope here — it predates this task, this task's code doesn't cause it, and it's being handled
directly with the user as an urgent follow-up. I did not factor it into this verdict. I did
confirm the Coder made the right call in *not* silently "fixing" it as a drive-by inside this
change: reconciling which side is correct requires inspecting the real Supabase bucket
contents, which no pipeline agent has access to, and guessing wrong risks breaking whichever
side currently happens to work for real, already-uploaded tax documents.

## Final disposition

All findings from the original review are resolved:
- Finding 1 (blocking) — fixed, verified independently above. **Closed.**
- Should-fix items — all addressed (stale comment, unconditional liability caption fixed
  conditionally, redundant DB query removed, copy inaccuracy fixed) except the sidebar/Mezzo
  nav inconsistency, correctly left as a named, deliberate product-decision deferral rather
  than an oversight.
- Nits — both fixed (trailing newline, copy).

Full suite is genuinely green under my own independent run, not just the write-ups. This
feature (bank statements + period balance sheet, plus the bucket-routing regression it
introduced and has now fixed) is ready to ship.

## What's good (this pass)

- The fix is exactly scoped to what was asked: one shared helper, both originally-flagged
  call sites fixed, plus a second latent instance of the same bug in `tax-planning.ts`
  proactively found and fixed under the same root-cause umbrella rather than narrowly
  patching only the two lines named in the original finding.
- The regression test exercises the actual crash mechanism (bucket/prefix resolution) via the
  real network-boundary mock, not a superficial "does it not throw" check.
- Good judgment on what *not* to touch: preserved the existing `taxes/`-prefix
  stripping behavior rather than "fixing" it without live-bucket verification, and correctly
  surfaced (rather than silently ignored or silently fixed) the separate pre-existing bug it
  ran into along the way.
- Should-fix/nit cleanups were done cleanly and precisely as specified, with no unrelated
  changes riding along.
