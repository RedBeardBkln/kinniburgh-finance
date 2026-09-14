# Review — tax-document-bucket-path-fix

## Verdict: APPROVED

## What was checked

- Read `00-request.md`, `02-implementation.md`, `03-test-report.md` (verdict PASS, including live production Supabase Storage round-trip: sign + GET on the real object, exact `content-length` match against Storage metadata).
- Read the current `lib/supabase-storage.ts` in full (not just the diff) and `lib/__tests__/supabase-storage.test.ts` in full.
- Ran `git diff` against HEAD for `lib/supabase-storage.ts` and `actions/tax-planning.ts` to see the real change, not just the summary.
- Independently re-ran `pnpm typecheck`, `pnpm lint`, `pnpm test` from a clean shell.
- Grepped the whole repo for any other `.slice("taxes/"...)`/prefix-stripping pattern outside the shared helper.

## Correctness

Confirmed directly in `lib/supabase-storage.ts:264-274`:

```ts
export async function getDocumentFileSignedUrl(fileKey: string): Promise<string> {
  if (fileKey.startsWith("taxes/")) return getTaxSignedUrl(fileKey);
  if (fileKey.startsWith("statements/")) return getTaxSignedUrl(fileKey);
  return getReceiptSignedUrl(fileKey);
}

export async function downloadDocumentFile(fileKey: string): Promise<Buffer> {
  if (fileKey.startsWith("taxes/")) return downloadTaxFile(fileKey);
  if (fileKey.startsWith("statements/")) return downloadTaxFile(fileKey);
  return downloadReceiptFile(fileKey);
}
```

No `.slice(` remains in the routing helpers. The `taxes/` and `statements/` branches are now textually identical (both pass the key through unstripped to the taxes bucket), and the default/receipts branch is untouched. This matches the write side: `uploadTaxDocumentCore` (`actions/tax-planning.ts:169`, unchanged by this diff) calls `uploadTaxFile(buffer, \`taxes/${entityId}/${docId}.${ext}\`, ...)` with the full unstripped key, which `uploadTaxFile` forwards straight to the `taxes` bucket — so the object really does live at the nested `taxes/taxes/{entityId}/{docId}.ext` path, and the fixed read side now requests exactly that path. This is corroborated by the Tester's live signed-URL + GET round-trip (exact byte-size match), which is about as strong a confirmation as is available for a Storage-REST-level fix.

Checked composition with the sibling `bank-statements-period-balance-sheet` fix (also touching this file today, uncommitted): the `statements/` branch was already correct/unstripped before this task started and is byte-for-byte unchanged by this diff — the two fixes touch disjoint `if` arms and compose cleanly. `actions/tax-planning.ts`'s `getTaxDocumentSignedUrl`/`downloadTaxDocument` already route through the shared helpers (that indirection was introduced by the sibling task, not this one) — this task correctly recognized that and touched only the helper, not the call site, which is the minimal fix.

## Scope discipline

`git status`/`git diff` confirm this task's actual footprint is exactly `lib/supabase-storage.ts` (append-only: new routing block, no existing lines touched other than the two `.slice(...)` removals) and `lib/__tests__/supabase-storage.test.ts` (new file, added earlier today by the sibling task, with the two `taxes/` test cases updated). `actions/tax-planning.ts` shows as modified in `git status`, but `git diff` confirms that change belongs to the sibling task (the `getTaxSignedUrlSafe` → shared-helper refactor) and was not touched further by this task, consistent with the implementation notes ("no other call site needed touching"). No storage-side mutation was performed — confirmed by the request doc's explicit prohibition and the Tester's methodology section (read-only `list`/`sign`/`GET` calls only, throwaway verification script deleted afterward).

## Test quality

Read `lib/__tests__/supabase-storage.test.ts` in full. The two updated `taxes/`-prefix tests correctly assert the doubled `taxes/taxes/{entityId}/{docId}.ext` segment (not a weakened "contains taxes bucket" assertion), with comments explaining exactly why the doubling is correct and warning against reintroducing the strip. The `statements/` and `documents/`-prefix tests are unmodified and still pass, providing adjacent-behavior regression coverage for the two branches this task didn't intend to touch. Tests mock only `global.fetch` (the real network boundary), exercising the actual URL-building logic rather than a stub of the helper itself — this is the right level to catch exactly this class of bug in the future.

## Independent verification results

- `pnpm typecheck` — clean, 0 errors (matches report).
- `pnpm lint` — 0 errors, 43 warnings, none in `lib/supabase-storage.ts` or the test file (matches report; spot-checked the warning list, all pre-existing/unrelated).
- `pnpm test` — 37 files, 427 tests, all passed (matches report exactly).
- Grepped repo-wide for `.slice("taxes/"...)`, `startsWith("taxes/")`, and similar prefix patterns: the only two occurrences are the two branches inside `lib/supabase-storage.ts` itself; `actions/documents.ts` and `actions/tax-planning.ts` both call the shared `getDocumentFileSignedUrl`/`downloadDocumentFile` helpers with no local prefix logic of their own. No duplicated/bypassing stripping logic exists elsewhere in the repo.

## Findings

None blocking. One nit, not worth a round-trip:

- **nit** — `getTaxSignedUrl`/`downloadFile` (both pre-existing, unchanged by this diff) build the request path with `encodeURIComponent(fileKey)`, which encodes the `/` separators in a multi-segment key as `%2F`, while `uploadFile`'s POST path does not encode at all. This asymmetry predates this task and is outside its scope, but it's worth a mental note: the fact that it demonstrably works (per the Tester's live sign+GET round-trip) means Supabase's storage API is decoding `%2F` before matching object keys, at least for the `sign` endpoint. Not verified live for the raw `GET /object/...` download endpoint (`downloadTaxFile`/`downloadDocumentFile`), only for `sign`. If a future document ever fails specifically via "Download" (not "View"/signed URL), this asymmetry is the first place to look. No action needed now — not part of this diff, and the encoding pattern is shared with the already-working `receipts` bucket path.

## What's good

- The Coder correctly resisted the temptation to "fix" this by touching the write side or migrating storage objects — recognized the write side was already correct and left it alone, exactly per the request doc's constraint.
- The routing comment block added above `getDocumentFileSignedUrl`/`downloadDocumentFile` is genuinely useful: it documents the physical path convention per prefix, cites the grep command used to find all `fileKey =` call sites, and explicitly warns against reintroducing the strip — this is exactly the kind of comment that prevents this bug's fourth recurrence.
- Diff is minimal and legible: two one-line branch changes plus a comment update, no drive-by refactoring.
- Tester's live-verification methodology (real `list`/`sign`/`GET` against production, comparing old vs. new path, byte-size match, then deleting the throwaway script and confirming `git status` parity) is the strongest form of evidence reasonably available for a Storage-REST bug and gives real confidence beyond "tests pass."

## Memory updates

Updated `document-filekey-bucket-routing.md` (coder memory) already reflects the resolution — no reviewer-memory change needed for that. No new recurring pattern to record beyond what's already tracked; the `encodeURIComponent`/upload-vs-download encoding asymmetry noted above is speculative and unconfirmed as an actual bug, so it doesn't meet the bar for a new memory entry yet — will record it if it ever actually manifests.
