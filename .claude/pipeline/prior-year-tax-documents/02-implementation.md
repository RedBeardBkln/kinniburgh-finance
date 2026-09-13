# Implementation — Prior-year tax document upload

## Summary of changes

**New files:**

- `lib/tax-year-range.ts` — `MIN_TAX_YEAR = 2000` and `isValidPriorYear(year, currentYear)`, pure integer-bounds check.
- `lib/tax-doc-batch.ts` — `MAX_BATCH_FILES = 25`, `summarizeUploadBatch(results)`, and the `UploadBatchResult`/`UploadBatchSuccess`/`UploadBatchFailure` discriminated-union types shared between the server action and the client component.
- `lib/__tests__/tax-year-range.test.ts` — 7 tests (below `MIN_TAX_YEAR`, at `MIN_TAX_YEAR`, at `currentYear`, one above `currentYear`, an ordinary prior year, a non-integer year, `NaN`).
- `lib/__tests__/tax-doc-batch.test.ts` — 7 tests (`MAX_BATCH_FILES` value, empty array, all-success plural, all-success singleton-by-name, all-failure, mixed success/failure, multiple failures all named).
- `components/tax/tax-document-upload.tsx` — new shared `"use client"` component (multi-file upload form + document table with rename/retype), used by both the personal and business workspace clients. Exports `DocumentRow` type.
- `components/tax/add-prior-year-form.tsx` — collapsed-by-default entity + year form on `/tax`, client-validates with `isValidPriorYear` before calling `ensureTaxWorkspace` directly (no new server action).
- `components/tax/other-year-documents.tsx` — collapsed, read-only "Other years" section grouped by year descending, each row with a "View" button that calls `getTaxDocumentSignedUrl` on click and reports failure inline (never a silent no-op). Exports `OtherYearDocument` type.

**Edited files:**

- `actions/tax-planning.ts`:
  - Extracted `uploadTaxDocument`'s body into an unexported `uploadTaxDocumentCore(input)` helper (validated primitives in, `{ documentId, documentName, extraction }` out). `uploadTaxDocument(formData)` is now a thin FormData-parsing wrapper around it — its exported signature, return shape, and error behavior are unchanged (only removed an unused `const user =` binding that was never referenced).
  - Added `uploadTaxDocuments(formData)` (plural): validates shared fields (`entityId`/`taxYear`/`docType`/`notes`) once, rejects the whole batch only if zero files or more than `MAX_BATCH_FILES`, then loops per-file with its own try/catch so one bad file doesn't abort the batch. Returns `UploadBatchResult[]`; same `revalidatePath("/documents")` / `revalidatePath("/tax")` calls as the singular version.
  - Fixed `getTaxDocumentSignedUrl`'s bucket routing (`getTaxSignedUrlSafe`): `fileKey` starting with `"taxes/"` still signs against the taxes bucket (unchanged); anything else now signs against the receipts bucket via `getReceiptSignedUrl`, matching how `actions/documents.ts#uploadDocument` stores `documents/{entityId}/...` keys. This was a documented pre-existing bug with zero call sites before this task — it now has its first real call site (`OtherYearDocuments`'s "View" button), so the fix is exercised for the first time.
- `components/tax/personal-tax-client.tsx` — removed the inline upload card, `handleUpload`, upload-related state, `DOC_TYPE_OPTIONS`, and the local `DocumentRowEditable`/`DocumentRow` (now imported from `tax-document-upload.tsx`); renders `<TaxDocumentUpload>` and `<OtherYearDocuments>` in their place. Added `otherYearDocs` to `Props`.
- `components/tax/tax-workspace-client.tsx` — replaced the read-only "Related Documents" card with `<TaxDocumentUpload entityId taxYear documents={relatedDocuments} />` and added `<OtherYearDocuments documents={otherYearDocs} />`. `relatedDocuments`'s prop type is now `DocumentRow` (from `tax-document-upload.tsx`, adding `documentName`/`extractionStatus`, both already Document columns). Added `entityId` to the destructured props (was in `Props` but unused before) and `otherYearDocs` to `Props`. Removed the now-unused local `Document` interface and `DOC_TYPE_LABELS` map.
- `app/tax/personal/[year]/page.tsx` — the `db.document.findMany` call drops its `taxYear: year` filter (keeps `entityId`/`archivedAt: null`); results are split in-page into `docs` (this year) and `otherYearDocs` (every other year), both passed to `PersonalTaxClient`.
- `app/tax/[workspaceId]/page.tsx` — `listDocuments({ entityId: workspace.entityId, taxYear: workspace.taxYear })` → `listDocuments({ entityId: workspace.entityId })`, split in-page into `relatedDocs`/`otherYearDocs`; `relatedDocuments` mapping now includes `documentName`/`extractionStatus`; `otherYearDocs` mapped and passed to `TaxWorkspaceClient`.
- `app/tax/page.tsx` — renders `<AddPriorYearForm entities={allEntities} />` next to the page header.

**Not touched (confirmed per plan):**
- `prisma/schema.prisma` — no changes, no migration.
- `lib/doc-extract.ts` — untouched, only reused (and type-only imported into `lib/tax-doc-batch.ts` via `import type`, so it doesn't pull the Anthropic SDK into the pure module at runtime).
- `actions/documents.ts#getDocumentSignedUrl` / `/documents` vault page — left as-is; the pre-existing bug there (always signs against the receipts bucket regardless of `fileKey` prefix) is a distinct, already-documented issue from the one fixed in `getTaxDocumentSignedUrl`. See Open items.

## Deviations from the plan

- **Upload card title loses its "1 ·" numbering.** The shared `<TaxDocumentUpload>` component's title is "Upload {taxYear} tax documents" without a leading step number, whereas the original personal-workspace card was titled "1 · Upload...". The business workspace has no numbered-step convention, so a shared component can't carry personal-specific numbering without an unused prop. This is a minor, deliberate visual difference from the plan's "no visible UX change" note — flagging it explicitly since the plan called that out as a goal, though functionally nothing changed.
- **Success-banner text for a single-file batch is shorter than the original single-upload message.** The original per-file message included the extraction summary text (e.g. "... ${result.extraction.summary}"); `summarizeUploadBatch`'s all-success message (single or plural) does not surface each file's extraction summary, only the count/name, matching the plan's own example message format ("4 uploaded & parsed, 1 failed: ..."), which likewise omits extraction summaries. This is a reasonable reading of the plan's spec for `summarizeUploadBatch`, not an oversight, but worth noting since it's a small loss of detail from the pre-existing single-file UX.
- No other deviations. The core refactor (`uploadTaxDocumentCore`) preserves `uploadTaxDocument`'s exact exported behavior; nothing in its validation, storage, or extraction logic changed.

## Commands run and their results

- `pnpm typecheck` (`tsc --noEmit`) — clean, no output, exit 0.
- `pnpm lint` — 0 errors, 43 warnings, all pre-existing and in files I did not touch (spot-checked the full warning list against my edited/new file paths — none appear). Same pre-existing-warning baseline described in agent memory (`commands.md`).
- `pnpm test` (`vitest run`, full suite) — **395 passed / 395, across 35 files** (up from the stated baseline of 381/33). Net addition: **14 new tests across 2 new files** (`tax-year-range.test.ts`: 7, `tax-doc-batch.test.ts`: 7) — within the plan's estimated 8–12 range for "roughly," slightly above but reflecting one extra defensive case each (`NaN` for `isValidPriorYear`, "multiple failures all named" for `summarizeUploadBatch`) that seemed worth covering given ground rule 1 (never silently drop a failure). Zero regressions — all 381 pre-existing tests still pass unchanged.

Not run: `pnpm build` (not listed in this task's Definition of Done, and this repo's build path touches Prisma generate + a live DB during static generation for some routes — out of scope to attempt without confirming DB access).

## Fix (post-Tester)

**Defect #1 from `03-test-report.md`:** `components/tax/add-prior-year-form.tsx` wrapped
`await ensureTaxWorkspace(formData)` in a `try/catch`. `ensureTaxWorkspace` (`actions/tax.ts`)
has no success path that doesn't end in `redirect(...)`, and Next.js 15 implements
server-action redirects by rejecting the caller's promise with an error whose `.message` is
literally `"NEXT_REDIRECT"`. The local `try/catch` intercepted that rejection on every
*successful* submission and rendered `"NEXT_REDIRECT"` in the form's error slot instead of
letting the app navigate to the new workspace.

**Fix applied:** removed the `try/catch` around the `ensureTaxWorkspace` call, matching the
existing working precedent in `components/tax/tax-entity-widget.tsx`'s `handleCreate` (which
calls the same action, unguarded, inside `startTransition`). All genuine client-side
validation (`isValidPriorYear` bounds check, entity-selected check) already ran synchronously
in `submit()` *before* `startTransition` is invoked — that validation was never inside the
removed `try/catch`, so no error-handling behavior was lost; only the redirect-swallowing
wrapper around the action call itself was removed.

```js
// Before
startTransition(async () => {
  try {
    await ensureTaxWorkspace(formData);
  } catch (err) {
    setError(err instanceof Error ? err.message : "Couldn't open that workspace.");
  }
});

// After
startTransition(async () => {
  await ensureTaxWorkspace(formData);
});
```

**Re-verification after the fix:**
- `pnpm typecheck` — clean, exit 0.
- `pnpm lint` — 0 errors, 43 warnings (identical pre-existing baseline; none in the touched
  file).
- `pnpm test` — **395 passed / 395 across 35 files**, same counts as before the fix (this was a
  UI control-flow bug fix, not new testable logic, so no test count change was expected).

Not re-verified: live-browser confirmation that the form now navigates cleanly on submit (no
running dev server + Supabase credentials in this environment, same constraint noted in the
original "Open items" below).

## Open items

- **Manual/visual verification** (per the plan's own "Test expectations" section) is still required and was not performed here: opening `/tax`, using "Add a prior year" for both a personal and business entity, uploading a multi-file batch with one deliberately bad file, and confirming the "Other years" View link opens a real file end-to-end. This needs a running dev server + live Supabase storage credentials, which I don't have in this environment.
- **`actions/documents.ts#getDocumentSignedUrl` bug remains unfixed**, exactly as the plan scoped it out — it still always signs against the receipts bucket regardless of `fileKey` prefix, so a tax-flow-uploaded document's "View" link on the generic `/documents` vault page is still broken. The plan explicitly recommends this as a follow-up; not done here.
- **No queueing/background-job system** — batches still extract serially, in-request, exactly as the plan accepted. `MAX_BATCH_FILES = 25` bounds but doesn't eliminate the request-timeout risk for a large batch of extractable file types.
- **`MIN_TAX_YEAR = 2000` and `MAX_BATCH_FILES = 25`** are both carried over from the plan as documented, sourced-from-precedent-but-unconfirmed assumptions (2000 matches `ensureTaxWorkspace`'s existing zod bound; 25 is a new, deliberately conservative constant). Flagging per the plan's own request for confirmation, not changing.
