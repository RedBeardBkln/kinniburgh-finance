# Implementation — storage-key-encoding-fix

## Summary of changes

### `lib/supabase-storage.ts`

Read the file fresh (it had been touched twice earlier today, per the request doc). Confirmed the exact set of `encodeURIComponent(fileKey)` occurrences via `grep -n "encodeURIComponent" lib/supabase-storage.ts` before changing anything — found exactly the 5 the request doc named, at the lines it named:

1. `downloadFile` (shared GET helper) — `/storage/v1/object/${bucket}/${encodeURIComponent(fileKey)}`
2. `getSignedUploadUrl` — `/storage/v1/object/upload/sign/${BUCKET}/${encodeURIComponent(fileKey)}`
3. `getReceiptSignedUrl` — `/storage/v1/object/sign/${BUCKET}/${encodeURIComponent(fileKey)}`
4. `getPaystubSignedUrl` — `/storage/v1/object/sign/${PAYSTUB_BUCKET}/${encodeURIComponent(fileKey)}`
5. `getTaxSignedUrl` — `/storage/v1/object/sign/${TAX_BUCKET}/${encodeURIComponent(fileKey)}`

Added a shared helper:

```ts
function encodeStoragePath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
```

placed right after `getStorageConfig()`, with a comment explaining the root cause (whole-key `encodeURIComponent` also escapes `/` as `%2F`, which signs successfully but fails Supabase's signature check on the follow-up GET — the exact production symptom in the request doc). Replaced all 5 named call sites with `encodeStoragePath(fileKey)`.

**One addition beyond the named 5**: `uploadFile` (the shared POST/PUT helper used by `uploadReceiptFile`/`uploadPaystubFile`/`uploadTaxFile`/`uploadLogoFile`) built its request path from the raw `fileKey` with **no encoding at all** — a 6th place a `fileKey` becomes a URL path segment in this file, just with a different (arguably worse) absence-of-encoding bug rather than the double-encoding bug. The request doc's instruction to "use this consistently everywhere a `fileKey` is turned into a URL path segment in this file" covers this case, so I applied `encodeStoragePath` there too. This is behaviorally a no-op for every real `fileKey` in the app (they're all built from UUIDs/ids + a literal prefix + extension — see `app/api/*/upload/route.ts` and `actions/{documents,tax-planching,bank-statements}.ts` — none contain characters that need escaping), so it carries no regression risk, and it closes a latent gap rather than leaving one path inconsistent with the other 5. I did **not** touch how any `fileKey` string is constructed anywhere else in the app, per the request doc's explicit instruction.

Verified no `encodeURIComponent(fileKey)` (or equivalent whole-key encoding) remains anywhere in the file via a final grep.

### `lib/__tests__/supabase-storage.test.ts`

The 6 pre-existing tests all used `decodeURIComponent(url)` to assert the key content, which round-trips `%2F` back to `/` and therefore could **not** have caught this bug (confirmed by temporarily reverting my fix and re-running — those 6 all still passed). Left those tests as-is (still valid bucket-routing coverage) and added a new `describe` block, "per-segment path encoding (fileKey slashes must stay literal)", with 8 tests that assert on the **raw, non-decoded** request URL:

- `getReceiptSignedUrl`, `getPaystubSignedUrl`, `getTaxSignedUrl`, `getSignedUploadUrl`, `downloadReceiptFile` each get a multi-segment key and assert the resulting URL contains the literal unescaped path (e.g. `.../documents/e1/d1.pdf`) and does **not** contain `%2F`.
- `getDocumentFileSignedUrl` and `downloadDocumentFile` (the `Document.fileKey` routing wrappers) get the same treatment end-to-end for the `taxes/` and `statements/` prefixes.
- One additional test confirms non-slash special characters within a segment (a space) are still escaped (`%20`) — proving the fix encodes per-segment, not "don't encode at all."

## Deviations from the plan

- Applied `encodeStoragePath` to the previously-unencoded `uploadFile` path builder (not one of the named 5 `encodeURIComponent` occurrences) — see justification above. No other deviations.

## Verification

**Sanity-checked the new tests actually catch the regression**: temporarily reverted all 6 `encodeStoragePath(fileKey)` call sites back to `encodeURIComponent(fileKey)` via `sed` and re-ran `pnpm vitest run lib/__tests__/supabase-storage.test.ts` — 8 of the 8 new tests failed (with diffs showing `%2F` in the actual output), all 6 pre-existing tests still passed (confirming they would NOT have caught this bug). Then restored the fix via `sed` and re-ran — all 14 tests in the file passed.

## Commands run and their results

- `pnpm vitest run lib/__tests__/supabase-storage.test.ts` — 14/14 passed (after restoring the fix).
- `pnpm typecheck` (`tsc --noEmit`) — clean, no output/errors.
- `pnpm lint` — 0 errors, 43 pre-existing warnings, all in files I did not touch (React `set-state-in-effect` warnings in unrelated components, unused-var warnings in unrelated test/seed files). Matches the repo's known baseline noted in prior sessions.
- `pnpm test` (full `vitest run`) — **435/435 passed across 37 files**, no failures, no regressions.
- `git status` / `git diff --stat` — confirmed only `lib/supabase-storage.ts` and `lib/__tests__/supabase-storage.test.ts` were modified; no unrelated files touched.

## Open items

- Per the request doc, I did not have a way to independently re-run the live Supabase API GET-against-signed-URL proof myself (no live credentials in this session) — I relied on the request doc's already-confirmed root cause and proved the code-level fix is correct and that my new tests would have caught the pre-fix behavior. The Tester should still do a live end-to-end GET against a real signed URL (per the request doc's explicit instruction that "sign-endpoint-returns-200 is NOT sufficient proof"), the same way the orchestrator did for tax documents, and ideally also for at least one receipt to confirm the doc's suspicion that this also broke receipt viewing.
- No data migration is needed — this is a pure read/request-path fix, nothing was written incorrectly to storage.
