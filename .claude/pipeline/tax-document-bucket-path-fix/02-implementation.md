# Implementation — tax-document-bucket-path-fix

## Verification performed before touching code

Confirmed the request doc's diagnosis directly against the current code (not re-derived from memory alone):

- `actions/tax-planning.ts:169` (`uploadTaxDocumentCore`) builds `fileKey = \`taxes/${entityId}/${docId}.${ext}\`` and calls `uploadTaxFile(buffer, fileKey, mimeType)` — i.e. the **full, unstripped** key is passed to the uploader.
- `uploadTaxFile` (`lib/supabase-storage.ts`) forwards straight to `uploadFile(buffer, TAX_BUCKET /* "taxes" */, fileKey, mimeType, false)`, which POSTs to `${url}/storage/v1/object/taxes/${fileKey}`. With the unstripped key this resolves to `.../object/taxes/taxes/{entityId}/{docId}.ext` — a nested `taxes/` folder inside the `taxes` bucket. This is the physical write path.
- Before this fix, `getDocumentFileSignedUrl`/`downloadDocumentFile` (the shared routing helpers added earlier today in the sibling `bank-statements-period-balance-sheet` task) stripped the `taxes/` prefix before calling `getTaxSignedUrl`/`downloadTaxFile`, requesting `.../object/sign/taxes/{entityId}/{docId}.ext` (un-nested) — which does not match where the object actually lives. This is the confirmed root cause of the 404s.
- Both `actions/tax-planning.ts`'s `getTaxDocumentSignedUrl`/`downloadTaxDocument` route through these two shared helpers (`return getDocumentFileSignedUrl(doc.fileKey)` / `return downloadDocumentFile(doc.fileKey)` at lines 359/365) — no other read path bypasses them, so the fix in the shared helper is sufficient; no other call site needed touching.
- Confirmed the write side (`uploadTaxFile`, `uploadTaxDocumentCore`) needed no change — it's already producing the key convention that matches where objects actually got written.

This matches the request doc's assumption exactly (read side was wrong, not the write side), so no storage-side data migration or object move/rename was needed or performed. No live Supabase Storage mutations were made.

## Summary of changes

- **`lib/supabase-storage.ts`** — `getDocumentFileSignedUrl` and `downloadDocumentFile`: removed the `.slice("taxes/".length)` stripping for `taxes/`-prefixed keys so they're now passed through unstripped, exactly like the already-correct `statements/` case. Updated the routing comment block above these functions to document the real (nested, unstripped) physical path convention and explicitly warn against reintroducing the strip. Did not touch the `statements/` or default/`documents/`-prefix (receipts bucket) branches, which were already correct and unchanged.
- **`lib/__tests__/supabase-storage.test.ts`** — updated the two `taxes/`-prefix tests (one for `getDocumentFileSignedUrl`, one for `downloadDocumentFile`) to assert the corrected unstripped behavior: the request URL now contains the doubled `taxes/taxes/{entityId}/{docId}.ext` segment, matching the real physical object path, instead of asserting the (now-wrong) stripped single-`taxes/` path. Left the `statements/` and `documents/`-prefix tests untouched since that behavior didn't change.

## Deviations from the plan

None. Followed the request doc's prescribed fix exactly — no storage mutation, read-side only, matched the `statements/` unstripped pattern.

## Commands run and their results

- `pnpm typecheck` — clean, no output (0 errors).
- `pnpm lint` — 0 errors, 43 warnings, all pre-existing and unrelated to this change (React hooks `set-state-in-effect` warnings in unrelated components, unused-var warnings in unrelated files). Nothing in `lib/supabase-storage.ts` or `lib/__tests__/supabase-storage.test.ts`.
- `pnpm test` (full suite) — 37 test files, 427 tests, all passed, including `lib/__tests__/supabase-storage.test.ts` (6/6, updated) and `lib/__tests__/bank-statement-extract.test.ts` / `period-balance-sheet.test.ts` (sibling task's tests, unaffected). No regressions in the `statements/`/`receipts/` cases.

## Open items

- None outstanding for this fix. The `document-filekey-bucket-routing` coder-memory entry's previously-open item about this exact mismatch is now resolved and updated to reflect the fix.
- Out of scope but worth noting for the user: the 10 real production `Document` rows with `fileKey` starting with `taxes/` (W-2s/1099s from 2026-08-31–09-01) should now resolve correctly once this deploys, since the fix makes the read path match where those objects were already physically written — no backfill/migration needed for them.
