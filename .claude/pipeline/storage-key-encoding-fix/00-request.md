# Request — URGENT: real, live, production bug (confirmed via browser + direct API test)

## What's broken

Immediately after deploying the `tax-document-bucket-path-fix` (commit `df37a43`), the orchestrator personally tested the "View" link on a real 2025 W-2 document live in the browser at bananastand.ericandeva.com. It failed with a NEW error: Supabase returned `{"statusCode":"400","error":"InvalidSignature","message":"Invalid signature"}` when opening the signed URL — a different failure than the "not found" symptom the prior fix addressed.

## Root cause (independently confirmed by the orchestrator against the live Supabase API, not just reasoning — do not re-derive, but do verify by reading the code yourself)

`lib/supabase-storage.ts` builds signed-URL/download/upload request paths like this (5 occurrences — `downloadFile` line ~93, the upload-sign helper line ~113, `getReceiptSignedUrl` line ~136, `getPaystubSignedUrl` line ~170, `getTaxSignedUrl` line ~216):

```ts
`${url}/storage/v1/object/sign/${BUCKET}/${encodeURIComponent(fileKey)}`
```

`fileKey` is always a multi-segment path like `taxes/{entityId}/{docId}.pdf` or `documents/{entityId}/{docId}.pdf` (2+ `/` separators are structural — real path segments, not literal data). `encodeURIComponent()` encodes those `/` characters as `%2F` too, which breaks Supabase Storage's signature verification on the actual download GET (confirmed: signing itself returns 200 either way, but the follow-up GET against the resulting signed URL returns 400 InvalidSignature when the slashes were percent-encoded).

**Direct proof, run against the real Supabase project** (`hptmcaukkaezjckygaqg`), for the real file `taxes/6f55fa50-9d94-47a8-92d6-2cc5abeac714/c9a9bdf3-2cdc-42b9-81df-91523517bd36.pdf`:

- Current code's approach (`encodeURIComponent(fileKey)` on the whole key) → sign returns 200, but GET on the resulting signed URL returns **400 InvalidSignature**.
- Fixed approach (`fileKey.split("/").map(encodeURIComponent).join("/")` — encode each segment, preserve `/` separators) → sign returns 200, GET on the resulting signed URL returns **200**, downloaded the real PDF, `content-length: 514586` matching Supabase's stored object size.

## Why this wasn't caught by the earlier `tax-document-bucket-path-fix` Tester pass

That Tester's live verification used the Supabase Storage `list`/download API more directly (or a client-library helper) rather than exactly replicating the app's own hand-rolled `fetch`-based `getTaxSignedUrl` function, so it didn't reproduce this specific encoding bug — it verified the *object exists at the right path* but not that *the app's actual signed-URL code correctly generates a working URL for it*. This time, the Tester MUST reproduce the exact code path (or an exact behavioral equivalent) and do a real end-to-end GET against the signed URL it returns — sign-endpoint-returns-200 is NOT sufficient proof, only a successful GET with the correct byte count proves it.

## Scope of impact

This same `encodeURIComponent(fileKey)` pattern exists in all 5 functions in `lib/supabase-storage.ts` mentioned above. Since every `fileKey` in this app is multi-segment (`{prefix}/{entityId}/{docId}.ext`), this most likely also breaks (or has always broken) receipt viewing (`getReceiptSignedUrl`) and paystub viewing (`getPaystubSignedUrl`), not just tax documents — verify this empirically against real data for at least receipts (there should be real receipt `Document`/similar rows in production) rather than assuming; if there's no safe way to test receipts without live user data, at minimum fix the code uniformly since the bug pattern is identical and there's no plausible reason it would behave differently for receipts than it just proved to for tax documents.

## The fix

Fix all 5 occurrences of `encodeURIComponent(fileKey)` (and any other place with the identical pattern you find via a repo-wide search — grep for `encodeURIComponent` in `lib/supabase-storage.ts` and confirm you found every instance) to encode each path segment individually while preserving `/` separators, e.g.:

```ts
function encodeStoragePath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
```

Use this consistently everywhere a `fileKey` is turned into a URL path segment in this file. Do NOT touch the upload side's path *construction* (how `fileKey` strings are built elsewhere in the app) — this is purely about how an already-correct `fileKey` string gets encoded into an HTTP request path.

## Ground rules

CLAUDE.md: security first, never fabricate data, TypeScript strict. This is the third fix to `lib/supabase-storage.ts` today (bucket-routing helper added, then the `taxes/` stripping bug fixed, now this encoding bug) — read the CURRENT state of the file fresh, don't assume you know its shape from memory of the earlier two fixes' descriptions.

## Your job (Coder)

1. Read the current `lib/supabase-storage.ts` in full.
2. Add a shared path-segment-encoding helper and apply it everywhere `encodeURIComponent(fileKey)` (or equivalent) is used to build a Supabase Storage request path.
3. Update/add unit tests in `lib/__tests__/supabase-storage.test.ts` (already exists, touched twice today) proving a multi-segment key is now encoded per-segment (e.g. assert the constructed URL/path contains literal `/` between segments, not `%2F`).
4. Run `pnpm typecheck && pnpm lint && pnpm test` and confirm clean.
5. Write `.claude/pipeline/storage-key-encoding-fix/02-implementation.md`.

Given the severity and that this is the THIRD same-day fix to a live-data-access path, be precise and re-verify your own understanding against the actual current file rather than trusting any prior description (including this one) of what the file currently contains.
