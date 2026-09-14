# Request — URGENT production bug fix

The user has confirmed real tax documents are currently broken in production and asked to fix it now.

## Confirmed facts (independently verified by the Tester on the `bank-statements-period-balance-sheet` task, not re-derive-needed, but DO verify yourself before touching code since you're fixing live data access)

- `actions/tax-planning.ts`'s tax-document upload flow (introduced in commit `c97fc9c`, "Add prior-year tax document upload, batch upload, and reference view") writes files via `uploadTaxFile` with an **unstripped** `taxes/{entityId}/{docId}.ext` key, which — combined with however `uploadTaxFile` itself prefixes the physical object path inside the `taxes` Supabase bucket — results in the actual object being stored at the nested path `taxes/{entityId}/{docId}.ext` *inside* the `taxes` bucket (i.e., there's a redundant `taxes/` folder segment inside the bucket that's already named `taxes`).
- The read path (`getTaxDocumentSignedUrl`/`downloadTaxDocument` in `actions/tax-planning.ts`, now going through the shared `getDocumentFileSignedUrl`/`downloadDocumentFile` helpers in `lib/supabase-storage.ts` after today's bank-statements bucket-routing fix) **strips** the `taxes/` prefix before signing, requesting `{entityId}/{docId}.ext` — which does not exist at that path.
- Verified directly against live production: a real Supabase Storage `list` call confirmed the objects physically exist at `taxes/{entityId}/{docId}.ext` (nested), while the read path requests the stripped `{entityId}/{docId}.ext` (returns `[]` / not found).
- **10 real, non-archived `Document` rows** in production currently have `fileKey` starting with `taxes/` (real W-2s/1099s uploaded 2026-08-31 through 2026-09-01) and are all currently unreadable (404) via "View"/download in the app.
- The `statements/`-prefix path (from today's bank-statements feature) does NOT strip its prefix before signing/reading, and is self-consistent (upload and read agree) — this is the working pattern to match.

## The fix

Per the Tester's recommendation: stop stripping the `taxes/` prefix on read, matching the `statements/` pattern — since the objects already exist at the nested path, this requires **no data migration**, just correcting the read-side path construction (and confirming the write-side is left alone, since the objects are already physically there and correct).

**Do not attempt to fix this by moving/renaming objects in Supabase Storage** (this would be a live data-mutation against production storage and is out of scope for a code-only pipeline task — if you determine a storage-side fix is actually required instead of a code-side one, stop and flag it rather than performing storage mutations yourself).

## Ground rules

CLAUDE.md: never fabricate data, tax records archive-only, security first, TypeScript strict. This task touches real production document access for two households' real income tax paperwork — be precise, verify against actual code (`lib/supabase-storage.ts`'s `getDocumentFileSignedUrl`/`downloadDocumentFile`, `uploadTaxFile`, and `actions/tax-planning.ts`'s upload functions) rather than assuming, and make sure the fix doesn't regress the now-passing `statements/` or `receipts/` cases (both were just fixed/verified today in the sibling `bank-statements-period-balance-sheet` task — this fix touches the same shared helper file, so re-run its existing tests too, not just new ones).

## Your job

1. Read `lib/supabase-storage.ts`'s current `getDocumentFileSignedUrl`/`downloadDocumentFile` (added earlier today) and `uploadTaxFile` in full to understand exactly how bucket-relative paths are constructed on write vs. read for each prefix.
2. Read `actions/tax-planning.ts`'s upload functions (`uploadTaxDocumentCore` or equivalent) to confirm exactly what `fileKey` value gets stored in the `Document` row and exactly what path `uploadTaxFile` writes to inside the `taxes` bucket, for a `taxes/`-prefixed key.
3. Fix the read-side stripping logic in the shared helper so `taxes/`-prefixed keys resolve to the same physical path the write side actually used — confirm this fix doesn't touch or break the `statements/` (unstripped) or default/`receipts/` (unstripped) cases, which are correct as-is.
4. Update/add unit tests in `lib/__tests__/supabase-storage.test.ts` (the file added earlier today for this exact helper) proving the `taxes/` case now resolves to the correct nested path, alongside the existing passing tests for the other two prefixes.
5. Run `pnpm typecheck && pnpm lint && pnpm test` (full suite) and confirm clean.
6. Write your implementation notes to `.claude/pipeline/tax-document-bucket-path-fix/02-implementation.md`.

This is a live, high-severity but low-risk, narrowly-scoped bug fix — proceeding straight to Coder without a separate Planner stage, matching how the sibling bucket-routing fix was handled earlier today.
