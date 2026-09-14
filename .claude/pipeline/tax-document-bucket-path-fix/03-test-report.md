# Test Report — tax-document-bucket-path-fix

## Verdict: PASS

## Acceptance criteria checklist

1. **`lib/supabase-storage.ts` genuinely no longer strips `taxes/` prefix; `statements/`/`receipts` cases untouched — PASS.**
   Read the current file directly. `getDocumentFileSignedUrl`/`downloadDocumentFile` now read:
   ```ts
   if (fileKey.startsWith("taxes/")) return getTaxSignedUrl(fileKey);       // was: fileKey.slice("taxes/".length)
   if (fileKey.startsWith("statements/")) return getTaxSignedUrl(fileKey);  // unchanged
   return getReceiptSignedUrl(fileKey);                                     // unchanged default
   ```
   Same pattern in `downloadDocumentFile`. No `.slice(` call remains anywhere in the routing helpers. `statements/` and default/`receipts` branches are byte-identical to the pre-fix version (confirmed by inspection — the diff is isolated to the two `taxes/` lines and the comment block above them).

2. **Live production DB: same ~10 `Document` rows with `fileKey` starting `taxes/` — PASS.**
   Ran a read-only Prisma query against the live DB. Found exactly **10** non-archived `Document` rows with `fileKey` starting `taxes/`, all under the same `entityId` (`6f55fa50-9d94-47a8-92d6-2cc5abeac714`), `fileKey` values of the form `taxes/{entityId}/{docId}.pdf`, `createdAt` spanning 2026-08-31 19:48–19:52 and one at 2026-09-01 12:25 — matches the request doc's "10 real rows, 2026-08-31 through 2026-09-01" claim exactly.

3. **Live Supabase Storage `list` call confirms objects physically live at the nested unstripped path — PASS.**
   `POST /storage/v1/object/list/taxes` with `prefix="taxes/{entityId}"` (the fixed code's effective read path) returned all 10 real objects (`0cc0dce2-...pdf`, `2a1d0abc-...pdf`, etc., with real sizes/etags/timestamps). The same `list` call with `prefix="{entityId}"` (the **old**, buggy stripped path) returned `[]` for all three sampled entity IDs — directly reproducing the described 404 root cause.

4. **End-to-end real signed-URL verification (strongest evidence) — PASS.**
   For document `ecca3a6a-624d-4bd0-9ee2-976d066e8aa3` (`fileKey = taxes/6f55fa50.../ecca3a6a....pdf`):
   - Signing at the **fixed** (unstripped) path — `POST /storage/v1/object/sign/taxes/taxes/{entityId}/{docId}.pdf` — returned `200` with a real signed URL. Following that signed URL with a `GET` returned `200`, `content-length: 212789`, `content-type: application/pdf` — an exact byte-size match to the object's stored Storage metadata (`"size":212789` from the `list` call). This is a real, working document download, not just a non-error response.
   - Signing at the **old** stripped path (`{entityId}/{docId}.pdf`, what pre-fix code requested) returned `400` / `{"statusCode":"404","error":"not_found","code":"NoSuchKey"}` — confirming the bug was real and is now resolved by this fix.

5. **Updated tests assert the correct unstripped nested path, not weakened — PASS.**
   Read `lib/__tests__/supabase-storage.test.ts` in full. Both `taxes/`-prefix tests (`getDocumentFileSignedUrl`, `downloadDocumentFile`) assert `decoded.toContain("/object/sign/taxes/taxes/e1/d1.pdf")` and `.toContain("/object/taxes/taxes/e1/d1.pdf")` respectively — the doubled `taxes/taxes/` segment is explicitly asserted, with comments explaining why. Not a loosened assertion (e.g. not just checking bucket membership) — it pins the exact nested key. The `statements/` and `documents/`-prefix tests are unmodified and still assert their existing (correct) unstripped/receipts-routed behavior.

6. **`pnpm typecheck && pnpm lint && pnpm test` clean — PASS.**
   See "Tests run" below for full output. `typecheck`: 0 errors. `lint`: 0 errors, 43 warnings, none touching `lib/supabase-storage.ts` or the test file (all pre-existing, unrelated files — `retroactive-rule-modal.tsx`, `vault-verify-client.tsx`, `doc-extract.test.ts`, etc.). `test`: 37 files, 427 tests, all passed.

7. **No regression to `statements/`/`receipts` cases from the sibling task fixed earlier today — PASS.**
   Code inspection confirms those two branches are textually unchanged (only the `taxes/` branch's strip was removed). `lib/__tests__/bank-statement-extract.test.ts` and `lib/__tests__/period-balance-sheet.test.ts` (sibling task's tests) both still pass (6 and 16 tests respectively), and the `statements/`-prefix tests inside `supabase-storage.test.ts` itself still pass unchanged. Did not re-run a second live signed-URL round-trip specifically for `statements/` in this session — not needed, since (a) it was already live-verified in the sibling task earlier today per Tester memory, and (b) this diff cannot affect that branch (separate `if` arm, zero lines changed in it).

## Tests run

```
$ pnpm typecheck
> tsc --noEmit
(no output — 0 errors)

$ pnpm lint
...
✖ 43 problems (0 errors, 43 warnings)
  0 errors and 1 warning potentially fixable with the `--fix` option.
(all 43 warnings in unrelated pre-existing files; none in lib/supabase-storage.ts or lib/__tests__/supabase-storage.test.ts)

$ pnpm test
 Test Files  37 passed (37)
      Tests  427 passed (427)
   Duration  2.07s
(includes lib/__tests__/supabase-storage.test.ts: 6/6 passed)
```

## Live verification methodology (per task instructions)

Wrote a throwaway read-only script `_tester_verify_tax_fix.mjs` in the repo root (per prior Tester memory on Prisma module resolution), run with `node --import tsx`, that:
1. Queried live `Document` rows via Prisma (read-only, no auth bypass needed since it's a direct `db.*` call, not a server action).
2. Called the real Supabase Storage REST `list` endpoint directly (same request shape `uploadFile`/`getTaxSignedUrl` use) to confirm physical object existence at both the fixed and old paths.
3. Called the real Storage `sign` endpoint at the exact URL the fixed `getTaxSignedUrl(fileKey)` call now constructs, and followed the resulting signed URL with a real `GET` to confirm actual bytes are served.
4. Deleted the script immediately after (confirmed via `git status --porcelain` matching the pre-verification baseline exactly — no leftover files).

No data was mutated; all calls were `GET`/`list`/`sign` (sign does not mutate the object, only issues a token).

## Tests added

None needed — the Coder's two updated `taxes/`-prefix test cases already assert the exact corrected nested path with clear justifying comments, and the existing `statements/`/`documents/`-prefix tests already provide adjacent-behavior regression coverage. No missing edge case identified (e.g. no other prefix conventions exist per the routing comment block, which was cross-checked against a grep for `fileKey = \`` call sites named in the comment).

## Defects found

None.

## Not tested

- Did not re-run a live signed-URL round-trip specifically for the `statements/` prefix in this session (see criterion 7 above for why this is a deliberate, justified omission, not an oversight).
- Did not test the actual Next.js server action call path (`getTaxDocumentSignedUrl`/`downloadTaxDocument` in `actions/tax-planning.ts`) end-to-end through a real HTTP request to the running app, since `requireAuth()` cannot be exercised outside a real Next.js request scope from a script (consistent with prior Tester memory on this exact constraint). Mitigated by verifying the exact underlying Storage REST call those actions delegate to (via `getDocumentFileSignedUrl` → `getTaxSignedUrl`) end-to-end instead, which is the strongest available substitute and directly confirms the real object resolves and downloads.
- Did not attempt to reproduce the bug against a non-`taxes/`-prefixed, non-`statements/`-prefixed Document row (e.g. a receipts-bucket row) live, since the code path for that branch is provably unchanged by this diff and already covered by passing pre-existing tests.
