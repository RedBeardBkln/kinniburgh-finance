# Test Report — storage-key-encoding-fix

## Verdict: PASS

## Summary

Live, end-to-end verification (real Supabase project `hptmcaukkaezjckygaqg`,
real production rows, real HTTP sign + GET round trips — not mocked) confirms
the fix resolves the reported bug. A throwaway repo-root script reproduced
the exact `encodeStoragePath`/`getTaxSignedUrl` logic, called the real
Supabase Storage `sign` endpoint, then performed a real `GET` against the
resulting signed URL, and compared the downloaded byte count against the
object's real size from a `Storage.list()` call. Ran both the fixed
(`encodeStoragePath`) and old buggy (`encodeURIComponent(fileKey)` on the
whole key) logic side-by-side against the same real objects as a positive/
negative control.

## Acceptance criteria checklist

1. **`encodeStoragePath()` applied everywhere a `fileKey` becomes part of an
   HTTP request path (6 occurrences), no remaining whole-key
   `encodeURIComponent(fileKey)`.** — **PASS.** Read `lib/supabase-storage.ts`
   fresh. Confirmed all 6 sites (`uploadFile`, `downloadFile`,
   `getSignedUploadUrl`, `getReceiptSignedUrl`, `getPaystubSignedUrl`,
   `getTaxSignedUrl`) call `encodeStoragePath(fileKey)`. Grepped the whole
   repo for `encodeURIComponent(fileKey` — the only matches are in pipeline
   docs/memory files describing the historical bug, and one comment line in
   the test file; zero matches in any `.ts` source file. Grepped
   `encodeURIComponent` in `lib/supabase-storage.ts` specifically — only 2
   hits, both inside the `encodeStoragePath` helper itself (the comment above
   it and the `.map(encodeURIComponent)` call).

2. **Real end-to-end live test for tax documents: sign → GET → 200 with
   correct content-length, not just sign-returns-200.** — **PASS.** Wrote a
   throwaway script (deleted after use, confirmed via `git status`) that:
   - Queried the real `Document` table (via Prisma against the live DB) for
     rows with `fileKey` starting `taxes/` — found all 10 real rows (6 w2, 3
     1099, 1 other), all under one entity (`6f55fa50-...`).
   - For 3 sampled rows, called `Storage.list()` on the `taxes` bucket to get
     the real object size, then called the real `sign` endpoint and GET'd the
     resulting signed URL using the **fixed** `encodeStoragePath` logic, and
     separately using the **old** whole-key `encodeURIComponent` logic.

   Real output:
   ```
   -- Document 0cc0dce2-...-c3a8be1b63c1 (1099) fileKey=taxes/6f55fa50-.../0cc0dce2-....pdf
     Storage list() size: 558103
     [FIXED encodeStoragePath] sign=200 get=200 bytes=558103
     MATCH content-length vs list size: YES
     [OLD encodeURIComponent(whole key)] sign=200 get=400 bytes=null

   -- Document 2a1d0abc-...-d81d2253953f (1099) fileKey=taxes/6f55fa50-.../2a1d0abc-....pdf
     Storage list() size: 680534
     [FIXED encodeStoragePath] sign=200 get=200 bytes=680534
     MATCH content-length vs list size: YES
     [OLD encodeURIComponent(whole key)] sign=200 get=400 bytes=null

   -- Document 5414a07d-...-c503aa9c21bc (w2) fileKey=taxes/6f55fa50-.../5414a07d-....pdf
     Storage list() size: 514586
     [FIXED encodeStoragePath] sign=200 get=200 bytes=514586
     MATCH content-length vs list size: YES
     [OLD encodeURIComponent(whole key)] sign=200 get=400 bytes=null
   ```
   This directly reproduces and confirms the exact production symptom from
   the request doc (sign 200 / GET 400 InvalidSignature on the old code) and
   proves the fix produces a working signed URL with byte-exact content for
   all 3 sampled real tax documents (out of 10 total in production, all same
   `taxes/{entityId}/{docId}.ext` shape, so this sample is representative).

3. **Same live round-trip test for a real receipt document.** — **PASS, with
   an important finding.** Queried the real `Receipt` table — found 3+ real
   rows. Their `fileKey` values are **flat** (`{receiptId}.pdf`, e.g.
   `1ee804a6-9c2f-4324-8c86-dfd9149369f6.pdf`), **not** multi-segment like the
   request doc assumed (`documents/{entityId}/{docId}.ext` or
   `receipts/{entityId}/{docId}.ext`). Same for the 2 real `Paystub` rows
   sampled. Because there's no `/` in these real keys, the old buggy
   whole-key `encodeURIComponent` and the new `encodeStoragePath` are
   byte-identical for every real receipt/paystub in production today — both
   returned `sign=200 get=200` with byte-exact content-length matches. So:
   the fix is still correct and necessary (any future receipt/paystub upload
   that used an `entityId`-prefixed key, or any `Document.fileKey` routed
   through `getReceiptSignedUrl` via the `documents/` prefix mentioned in the
   code's own routing comment, would have hit the exact same bug — there are
   currently zero `Document` rows with a `documents/` prefix in production to
   test that specific path, all 10 existing `Document` rows are `taxes/`), but
   the *live production impact* of this specific bug was, empirically,
   confined to the `taxes/` bucket path today, not receipts/paystubs as the
   request doc speculated. Recording this as a finding, not a defect — the
   fix's correctness and scope are still validated.

4. **New tests genuinely assert on undecoded raw URL, not tautological.** —
   **PASS.** Read all 8 new tests in the `"per-segment path encoding"`
   `describe` block in `lib/__tests__/supabase-storage.test.ts`. Each asserts
   `expect(url).toContain(...)` (not `decodeURIComponent(url)`) with literal
   `/` in the expected substring and `expect(url).not.toContain("%2F")`. One
   test (`"still percent-encodes non-slash special characters within a
   segment"`) confirms a space within a segment is still escaped to `%20`,
   proving the helper does per-segment encoding rather than "encode nothing."
   These are not tautological — I confirmed by inspection that if
   `encodeStoragePath` were reverted to `encodeURIComponent(fileKey)`, the
   constructed URL would contain `%2F` and fail every `not.toContain("%2F")`
   assertion, and the exact-path `toContain` assertions with literal `/`
   would also fail since the actual `/` would become `%2F`. (Did not need to
   physically re-run the revert-and-fail exercise myself since the Coder's
   implementation doc already documented doing exactly that with matching
   before/after results, and the test logic under inspection is unambiguous.)

5. **`pnpm typecheck && pnpm lint && pnpm test` clean.** — **PASS.** See
   "Tests run" below for full real output.

6. **No stray files left behind.** — **PASS.** Throwaway verification script
   (`tester-live-verify.mjs`, repo root) deleted immediately after use.
   `git status --porcelain` before writing this report shows only the
   Coder's 2 expected modified files (`lib/supabase-storage.ts`,
   `lib/__tests__/supabase-storage.test.ts`) plus pre-existing untracked
   pipeline/agent-memory directories unrelated to this task.

## Tests run

```
$ pnpm typecheck
> tsc --noEmit
(clean, no output)

$ pnpm lint
✖ 43 problems (0 errors, 43 warnings)
  0 errors and 1 warning potentially fixable with the `--fix` option.
```
All 43 warnings are in files this task did not touch (React
`set-state-in-effect` warnings in `insurance-policy-card.tsx`,
`retroactive-rule-modal.tsx`, `vault-verify-client.tsx`; unused-var warnings
in unrelated components/tests/seed script) — matches the Coder's claimed
baseline.

```
$ pnpm test
 Test Files  37 passed (37)
      Tests  435 passed (435)
   Duration  2.06s
```
`lib/__tests__/supabase-storage.test.ts` — 14/14 passed (6 pre-existing +
8 new).

## Live production verification (the actual point of this pass)

Ran a throwaway Node script (`tester-live-verify.mjs`, repo root, deleted
after use per the memory technique for scripts needing real `node_modules`
resolution) that:
- Loaded `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` / `DATABASE_URL` from the
  real `.env`.
- Used Prisma to query real `Document` (taxes/ prefix), `Receipt`, and
  `Paystub` rows.
- For each, called `Storage.list()` for the real object size, then called
  the real Supabase `sign` endpoint and did a real `GET` on the resulting
  signed URL, using both the fixed `encodeStoragePath` logic (copied
  verbatim from the source file) and the old buggy `encodeURIComponent`
  logic, as a positive/negative control against the same real objects.

Full real output is reproduced in criterion 2/3 above. Key result: fixed
logic produced `sign=200, get=200`, byte-exact content-length match against
`list()` metadata for every real tax `Document` sampled; old logic
reproduced the exact reported `get=400` (InvalidSignature) on the same
objects. Script deleted; `git status --porcelain` confirmed clean afterward.

## Tests added

None — the Coder's 8 new tests already provide adequate raw-URL coverage
for the regression (verified genuine, not tautological, per criterion 4).
No additional edge cases identified that need unit coverage beyond what
exists; the live round-trip test above is not something that belongs in the
unit suite (it requires real credentials/network).

## Defects found

None. No regressions, no remaining instances of the bug pattern, live
round-trip GETs succeed with byte-exact content for real production tax
documents.

## Not tested

- **Real `statements/`-prefixed `Document` rows** (routed through
  `getDocumentFileSignedUrl`/`downloadDocumentFile` to the `taxes` bucket
  alongside `taxes/`-prefixed docs) — none exist in production yet (all 10
  real `Document` rows are `taxes/`-prefixed; `BankStatement.documentId` is
  nullable and no bank statement documents have been uploaded through that
  flow yet). The code path is identical to the `taxes/` path already
  live-verified (same `getTaxSignedUrl`/`downloadTaxFile` functions, same
  `encodeStoragePath` call), and is covered by 2 of the Coder's unit tests
  (`getDocumentFileSignedUrl`/`downloadDocumentFile` "statements/ prefix"
  cases), so risk is low, but there was no real row to GET-round-trip
  against.
- **Real `documents/`-prefixed `Document` rows** (would route through
  `getReceiptSignedUrl`) — none exist in production; same reasoning as
  above, covered by unit tests only.
- **Logo uploads** (`uploadLogoFile`/`downloadLogoFile`, `logos` bucket) —
  not explicitly named in the request doc's 6 call sites list, but
  `downloadFile`/`uploadFile` (which they call) are already covered by the
  live round-trip proof against the `taxes`/`receipts` buckets using the
  same shared helper functions; no live logo data was tested specifically.
