# Plan — Prior-year tax document upload

## Restated goal

Let the household upload prior-year tax documents — including several at once —
into any tax workspace (personal or business), be able to open a workspace for a
year that has never existed in the system before, and see a prior year's documents
for reference while working a later year's return. Build entirely on the existing
`Document` model and upload primitives; no schema changes.

## Scope

**In scope (all four sub-features, one pass — see "Why one pass, not split" below):**

1. A manual "Add a prior year" entry point on `/tax` that calls the existing
   `ensureTaxWorkspace` action directly, for years with zero `TaxWorkspace` rows
   anywhere in the system (so they don't show up in the auto-derived `years` list).
2. Multi-file upload (native `<input type="file" multiple>`) — one shared
   `docType`/`taxYear` applied to every file in a batch, one `Document` row created
   per file, partial-failure-tolerant (one bad file in a batch of 10 doesn't kill
   the other 9).
3. The business workspace (`/tax/[workspaceId]`) gets the same upload capability
   the personal workspace already has, via a new shared upload component (not a
   copy-pasted one) so both surfaces can never drift apart.
4. A collapsed "Other years" section inside every workspace (personal and
   business) showing that entity's documents from every *other* tax year, each
   with a working "View" link (signed URL).

**Out of scope (explicitly not doing):**

- `webkitdirectory`/folder-tree upload — multi-file select covers this.
- Per-file docType selection within one multi-file submission.
- Any change to `lib/doc-extract.ts` extraction logic itself.
- Any Prisma schema/migration change — confirmed not needed (see "Affected
  files/modules").
- Fixing the pre-existing, unrelated signed-URL bucket-routing bug in
  `actions/documents.ts#getDocumentSignedUrl` (see Risks/unknowns) — flagged as a
  discovered issue, not fixed here, because it's outside what was asked and touches
  the already-shipped `/documents` vault page.
- A queueing/background-job system for extraction — batches still extract
  serially, in-request (see Risks/unknowns on timeout exposure).

### Why one pass, not split

All four pieces share one foundation (the multi-file batch action + one shared
upload component) and touch the same three files (`actions/tax-planning.ts`,
`components/tax/personal-tax-client.tsx`, `components/tax/tax-workspace-client.tsx`).
Splitting business-parity (#3) into a follow-up would mean building the shared
upload component twice — once for personal only, then re-touching it — for no
reduction in real risk (no schema change, no new external dependency, no cross-team
coordination). Recommend building all four now. The one piece worth calling out as
independently deferrable if time runs short is **#4 (prior-year reference view)** —
it's the only purely additive, purely read-only piece with no dependency from #1–#3
and could ship a sprint later with zero rework. But there's no reason found in the
investigation to actually defer it.

## Affected files/modules

**New files:**
- `lib/tax-year-range.ts` — pure: prior-year input validation (min/max bounds).
- `lib/__tests__/tax-year-range.test.ts`
- `lib/tax-doc-batch.ts` — pure: batch-upload result summarization (success/failure
  counts + honest per-file failure reasons) and the batch file-count cap constant.
- `lib/__tests__/tax-doc-batch.test.ts`
- `components/tax/tax-document-upload.tsx` — new shared `"use client"` component:
  multi-file upload form + document table (upload UX, extraction status, rename/
  retype), used by both personal and business workspace clients.
- `components/tax/add-prior-year-form.tsx` — new small client component for the
  `/tax` index page entry point.
- `components/tax/other-year-documents.tsx` — new shared `"use client"` component:
  collapsed "Other years" read-only document list with per-row "View" (signed URL).

**Edited files:**
- `actions/tax-planning.ts` — extract `uploadTaxDocument`'s body into an
  unexported, non-`"use server"` core function; add exported `uploadTaxDocuments`
  (plural) for the batch case; extend `getTaxDocumentSignedUrl`'s bucket routing
  (see Risks/unknowns) so it works correctly for both `taxes/`- and `documents/`-
  prefixed `fileKey`s, since the prior-year view needs it and it currently has zero
  call sites (safe to correct).
- `components/tax/personal-tax-client.tsx` — replace the inline "1 · Upload" card
  and its `DocumentRowEditable` helper with `<TaxDocumentUpload>`; add
  `<OtherYearDocuments>`.
- `components/tax/tax-workspace-client.tsx` — replace the read-only "Related
  Documents" card with `<TaxDocumentUpload>`; add `<OtherYearDocuments>`.
- `app/tax/personal/[year]/page.tsx` — drop the `taxYear` filter on the
  `db.document.findMany` call (fetch all of that entity's non-archived docs), split
  in-page into `docs` (this year) and `otherYearDocs` (everything else), pass both
  down.
- `app/tax/[workspaceId]/page.tsx` — same change, but via `listDocuments({entityId})`
  (drop the `taxYear` filter from that call), split in-page.
- `app/tax/page.tsx` — render `<AddPriorYearForm entities={allEntities} />` near
  the page header.

**Not touched (confirmed, stated explicitly):**
- `prisma/schema.prisma` — `Document` model already has everything needed
  (`taxYear` nullable, `entityId`, `docType`, `fileKey`). No migration.
- `lib/doc-extract.ts` — extraction logic itself is untouched; only reused.
- `actions/documents.ts#getDocumentSignedUrl` / `/documents` vault page — left
  as-is (see Risks/unknowns).

## Approach

Ordered for the Coder — note the build order differs slightly from the task's
stated priority order because #2's batch primitive is a dependency of #3's parity
work, so it's built first:

1. **Extract the shared upload core** in `actions/tax-planning.ts`. Pull
   `uploadTaxDocument`'s body (validation, storage upload, `Document` create,
   conditional extraction, name generation) into an unexported async helper that
   takes already-validated primitives (`buffer`, `mimeType`, `entityId`, `taxYear`,
   `docType`, `notes`) and returns `{ documentId, documentName, extraction }`,
   throwing on validation/storage failure exactly as today. Reimplement the
   existing exported `uploadTaxDocument(formData)` as a thin FormData-parsing
   wrapper around it — **its exported signature, return shape, and error behavior
   must not change** (nothing else calls it today, but this keeps the diff a true
   refactor, not a behavior change, per the task's instruction not to touch the
   single-document logic unless necessary).

2. **Add `uploadTaxDocuments(formData)`** (plural) in `actions/tax-planning.ts`:
   - Shared fields (`entityId`, `taxYear`, `docType`, `notes`) parsed and validated
     once, up front, since they apply to the whole batch.
   - `formData.getAll("file")` for the files; reject the whole batch only if zero
     files are present, or if the count exceeds `MAX_BATCH_FILES` (from
     `lib/tax-doc-batch.ts`, recommend 25 — bounds worst-case serial extraction
     time per submission; document this as a deliberate, arbitrary-but-reasonable
     cap in a code comment).
   - Loop over files; for each, run the same per-file validation the single-file
     path already runs (MIME type, 20MB size) inside its own try/catch, so **one
     bad file does not abort the batch** — collect a discriminated-union result
     per file: `{ fileName, success: true, documentId, documentName, extraction }`
     or `{ fileName, success: false, error }`.
   - Return the full per-file result array. Do not throw for partial failures —
     only throw if the shared fields themselves are invalid (nothing to salvage)
     or the batch is empty/oversized.
   - `revalidatePath` calls match the singular version's (`/documents`, `/tax`).

3. **Pure helpers:**
   - `lib/tax-doc-batch.ts`: export `MAX_BATCH_FILES = 25` and
     `summarizeUploadBatch(results)` — takes the discriminated-union array from
     step 2 and returns a short, honest, human-readable string (e.g. `"4 uploaded
     & parsed, 1 failed: bad-scan.pdf (Unsupported file type)."`), used directly
     by the new upload component so the UI never silently drops a per-file failure
     (ground rule 1). Cover in `lib/__tests__/tax-doc-batch.test.ts`: all-success,
     all-failure, mixed, empty-array (should not happen given the action's own
     guard, but the pure function should handle it without throwing).
   - `lib/tax-year-range.ts`: export `MIN_TAX_YEAR = 2000` and
     `isValidPriorYear(year, currentYear)` (integer, `>= MIN_TAX_YEAR`, `<=
     currentYear` — the "add a prior year" form's job is specifically for years
     that aren't already visible, not for future years, which the existing
     "Create Workspace" widget already covers for the current year). Cover in
     `lib/__tests__/tax-year-range.test.ts`: boundary years, non-integer, year
     equal to `currentYear` (valid, edge case), year one above `currentYear`
     (invalid).

4. **`components/tax/tax-document-upload.tsx`** — new shared client component.
   Props: `entityId`, `taxYear`, `documents` (existing `DocumentRow[]` shape from
   `personal-tax-client.tsx`). Behavior, lifted verbatim from
   `personal-tax-client.tsx`'s existing upload card:
   - File input gets the `multiple` attribute; `docType` select and hidden
     `entityId`/`taxYear` fields unchanged.
   - On submit, calls `uploadTaxDocuments` (not the singular action), then renders
     `summarizeUploadBatch`'s message in the same success/error banner styling
     already used.
   - Keeps the existing document table + `DocumentRowEditable` (rename/retype via
     `updateTaxDocument`) moved in verbatim — entity-agnostic already, no changes
     needed to `updateTaxDocument`.
   - Same loading/disabled-button states as today's `handleUpload`.

5. **Wire personal workspace to the shared component.** In
   `personal-tax-client.tsx`, delete the inline upload card, `handleUpload`, the
   local `DocumentRowEditable`, and `DOC_TYPE_OPTIONS` (all move into
   `tax-document-upload.tsx`); render `<TaxDocumentUpload entityId={...}
   taxYear={...} documents={...} />` in their place. No visible UX change other
   than "select multiple files" now being possible and the success message
   reflecting a batch.

6. **Business workspace parity.** In `tax-workspace-client.tsx`, replace the
   existing read-only "Related Documents" card (which currently only links out to
   `/documents`) with `<TaxDocumentUpload entityId={entityId} taxYear={taxYear}
   documents={relatedDocuments} />`. Note `relatedDocuments`'s current shape
   (`docType`, `notes`, `taxYear`, `createdAt`, no `documentName`/
   `extractionStatus`) is a subset of what `TaxDocumentUpload` needs — the page
   query in `app/tax/[workspaceId]/page.tsx` must select `documentName` and
   `extractionStatus` too (both already columns on `Document`; this is a `select`/
   mapping change only, not a schema change).

7. **Arbitrary-year entry point.** `components/tax/add-prior-year-form.tsx`:
   small collapsed-by-default form (same open/close pattern as
   `AddDeadlineForm`) with an entity `<select>` and a year `<input type="number">`,
   client-validated with `isValidPriorYear` before submit for immediate feedback.
   On submit, builds a `FormData` and calls the existing `ensureTaxWorkspace`
   (`actions/tax.ts`) directly — no new server action needed, since it already
   accepts arbitrary `entityId` + `taxYear` (2000–2100) and redirects to the new
   workspace. Render it in `app/tax/page.tsx`'s header area, next to the page
   title. Only years with **zero** workspaces anywhere need this entry point in
   practice (years already in the auto-derived list already show the existing
   "Create Workspace" button per-entity) — but there's no harm in the form
   accepting any year, including ones that already have a workspace; the action is
   already idempotent (finds-or-creates), so worst case it just navigates you to
   the existing workspace.

8. **Prior-year reference view.** `components/tax/other-year-documents.tsx`: a
   collapsed (`<details>` or simple `useState` toggle, closed by default) section
   listing every other-year document for the entity, grouped by year (descending),
   each row showing docType, name/notes, upload date, and a "View" button that
   calls `getTaxDocumentSignedUrl(documentId)` on click and opens the result via
   `window.open(url, "_blank", "noopener,noreferrer")`, with an inline error
   message on failure rather than a silent no-op (ground rule 1 — a broken link
   must say so, not pretend to work). This is the first click-to-fetch-signed-URL
   pattern in this codebase (existing "View" links are all server-rendered inside
   Server Components) — keep it deliberately minimal, no extra abstraction.
   Wire into both `personal-tax-client.tsx` and `tax-workspace-client.tsx` fed by
   the `otherYearDocs` data described below. Show **all** other years found (no
   cap) — a household's own document count is inherently small, and collapsing by
   default already keeps it out of the way.

9. **Page-level data wiring for step 8:**
   - `app/tax/personal/[year]/page.tsx`: broaden the existing
     `db.document.findMany` call to drop its `taxYear: year` filter (keep
     `entityId`/`archivedAt: null`), then in the page body split the results into
     `docs = all.filter(d => d.taxYear === year)` and
     `otherYearDocs = all.filter(d => d.taxYear !== year)`.
   - `app/tax/[workspaceId]/page.tsx`: change `listDocuments({entityId,
     taxYear: workspace.taxYear})` to `listDocuments({entityId})`, then split the
     same way in-page.

10. **Fix `getTaxDocumentSignedUrl`'s bucket routing** in `actions/tax-planning.ts`
    so it works for both origins of a `Document` row: `fileKey` starting with
    `"taxes/"` → sign against the tax bucket (as today); otherwise → sign against
    the receipts bucket (reuse `getReceiptSignedUrl` from
    `lib/supabase-storage.ts`, matching the fact that the *other* document-creation
    path, `actions/documents.ts#uploadDocument`, writes `documents/{entityId}/...`
    keys into the receipts bucket and also accepts an optional `taxYear`). This
    function currently has zero call sites, so widening it is a safe, contained
    fix — not a change to any currently-exercised behavior.

## Risks/unknowns

- **Pre-existing, unrelated bug found during investigation:**
  `actions/documents.ts#getDocumentSignedUrl` (used by the generic `/documents`
  vault page's "View" link) always signs against the `"receipts"` bucket
  regardless of the document's actual `fileKey` prefix. Any document created via
  the tax-specific upload path (`taxes/{entityId}/...` keys, stored in the
  `"taxes"` bucket) will produce a broken "View" link on `/documents` today. This
  is a real, currently-live bug, but it predates this task and is outside its
  scope — flagging it explicitly rather than silently fixing it. **Recommend a
  follow-up** applying the same prefix-aware branch this plan adds to
  `getTaxDocumentSignedUrl` (step 10) to `getDocumentSignedUrl` as well.
- **No queueing/background-job system exists in this codebase.** A multi-file
  batch extracts documents serially, in the same server-action invocation, exactly
  as the single-file path already does. A large batch of large, extractable
  (w2/1099/k1/etc.) files could approach a platform request-timeout — the
  `MAX_BATCH_FILES = 25` cap bounds this somewhat but doesn't eliminate the risk.
  No existing precedent in this repo for background processing of AI extraction,
  so this plan does not attempt to add one — flagging as a known limitation, not
  fixing it.
- **Assumption: `MIN_TAX_YEAR = 2000`.** No document in `data/*.csv`,
  `specs/07-source-data-notes.md`, or elsewhere in the repo states when the
  household's financial history begins. `2000` mirrors the bound already baked
  into `ensureTaxWorkspace`'s zod schema and `uploadTaxDocument`'s existing
  taxYear check, so it's consistent with prior decisions rather than a new
  invented number — but it is still a guess, not a sourced fact. If the actual
  earliest relevant year is known (e.g. when Eric/Eva started filing jointly, or
  when EK Consulting/Sudden Valley were formed), the form's lower bound should be
  tightened accordingly — flagging for confirmation rather than guessing further.
- **Assumption: `MAX_BATCH_FILES = 25`.** Not sourced from any spec — a
  deliberately conservative, documented guess balancing "a folder full of
  documents" against serial in-request extraction time. Easy to change later
  (single constant).
- **Scope call:** the business workspace's checklist/status/notes card (top of
  `tax-workspace-client.tsx`) is left completely untouched — only the "Related
  Documents" card is replaced. Confirmed by reading the full file that no other
  part of that component references documents.
- **`relatedDocuments` prop shape change** in `TaxWorkspaceClient` (adding
  `documentName`/`extractionStatus`) is additive only — no existing consumer of
  that prop shape breaks, since `TaxWorkspaceClient` is only rendered from
  `app/tax/[workspaceId]/page.tsx`.

## Acceptance criteria

1. From `/tax`, a year with zero existing `TaxWorkspace` rows anywhere (e.g. 2019)
   can be entered via the new "Add a prior year" form and results in a real
   workspace being created and opened, for both a personal and a business entity.
2. From an open personal or business tax workspace, selecting multiple files in
   one upload submission creates one `Document` row per file, all sharing the
   submitted `docType`/`taxYear`, with per-file extraction attempted exactly as
   the existing single-file flow does for extractable types.
3. A batch containing one invalid file (wrong MIME type or oversized) among
   otherwise-valid files still creates `Document` rows for the valid files; the
   UI reports which file(s) failed and why, in the same success/error banner
   style already used, and never silently drops a failure.
4. `/tax/[workspaceId]` (a business entity) now has a working upload form
   producing the same result shape/UX as the personal workspace's upload flow.
5. Opening any workspace shows a collapsed "Other years" section listing that
   entity's documents from every year other than the one currently open; each has
   a working "View" link that opens the correct file (not a broken signed URL),
   regardless of whether the document was originally uploaded via the tax-specific
   flow or the generic document-vault flow.
6. No changes to `prisma/schema.prisma`; no new migration.
7. `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass clean.

## Test expectations

- **Unit (pure, Vitest, matching this repo's `lib/__tests__/*.test.ts` pattern):**
  - `lib/tax-doc-batch.ts` — `summarizeUploadBatch`: all-success, all-failure,
    mixed success/failure, singleton batch, and the (defensive) empty-array case.
  - `lib/tax-year-range.ts` — `isValidPriorYear`: below `MIN_TAX_YEAR`, at
    `MIN_TAX_YEAR`, at `currentYear`, one above `currentYear`, non-integer input.
  - Expected new count: **2 new test files, roughly 8–12 new test cases total** —
    baseline goes from 381/33 to approximately **391–393 tests across 35 files**
    (exact count depends on how many cases the Coder writes per edge case above;
    state the actual final count in the handoff, don't just assume this estimate).
- **Not unit-tested, consistent with this repo's established convention** (DB- or
  network-touching code lives beside pure helpers but isn't directly tested; see
  `lib/notifications.ts`'s check functions for precedent): `uploadTaxDocuments`,
  the extracted single-file core, `getTaxDocumentSignedUrl`'s bucket-routing fix,
  and `ensureTaxWorkspace` (already untested, unchanged). These are exercised
  through manual/visual verification instead (see below), not new automated
  coverage — do not add DB-mocking test scaffolding that doesn't already exist in
  this repo for this style of function.
- **No e2e test suite exists in this repo** (confirmed: only Vitest unit tests
  under `lib/__tests__/`) — none added here, consistent with existing convention.
- **Manual/visual verification required (UI-touching task):** a human must open
  `/tax`, use the new "Add a prior year" form, open both a personal and a
  business workspace, upload a multi-file batch (including one deliberately bad
  file to confirm partial-failure messaging), and expand "Other years" to confirm
  the View link opens a real file. This cannot be fully confirmed by the test
  suite alone.

## Handoff notes for the Coder

- Read `components/tax/personal-tax-client.tsx` in full before starting step 4 —
  the shared component's upload card, banner styling, and `DocumentRowEditable`
  should be lifted with minimal changes, not redesigned.
- Re-run `pnpm test` after adding the two new pure-logic files and report the
  actual final test/file count in your handoff — don't assume the estimate above
  is exact.
- If, while extracting the shared upload core in step 1, anything about
  `uploadTaxDocument`'s existing behavior looks like it needs to change (not just
  move), stop and flag it rather than changing it silently — the task is explicit
  that this logic should only be touched if genuinely necessary.
