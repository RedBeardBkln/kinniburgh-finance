# Plan: View, Archive, Re-extract, and Swap for current-year tax documents

## Restated goal

`DocumentRowEditable` (the current-year document table inside `TaxDocumentUpload`,
`components/tax/tax-document-upload.tsx`) today only supports "Rename / retype." Add three more
row-level actions — **View** the actual file, **Archive** (soft-delete) it, and **Re-extract** its
data — plus a **Swap** flow (replace the underlying file while keeping the same docType/name/
notes/taxYear), all built on existing server actions with no unproven new server-side logic. This
directly unblocks fixing a real, currently-live mistagged document.

## Live grounding (read, not assumed)

Queried the production DB directly (read-only, `db.document.findMany`, no writes) for
`docType: "w2", taxYear: 2025, archivedAt: null`. Five documents exist; four are genuine W-2s with
clean structured extractions. The fifth — **id `cfeeec59-ea6c-4036-a10b-7fab323cff0c`**,
`entityId 6f55fa50-9d94-47a8-92d6-2cc5abeac714`, `fileKey taxes/6f55fa50-.../cfeeec59-....pdf`,
`documentName: null`, `notes: null`, `extractionStatus: "complete"` — is the real mistagged
document. Its `extractionData.data.raw` field literally contains Claude's own refusal text: *"This
document is a Form 1098 (Mortgage Interest Statement)... issued by Pennymac Loan Services, LLC for
tax year 2025... none of which maps to W-2 fields,"* with `extractionData.summary` set to the exact
string `"Could not parse extraction response."` — this is precisely what
`lib/tax-compute-build.ts#findUnparseableExtractions` (line ~153-155) filters on, so this document
is already being surfaced by `app/tax/personal/[year]/page.tsx`'s `mistaggedDocs` → the amber
"⚠ check type" badge already visible in `DocumentRowEditable` (via its existing `flagged` prop) is
already pointing at this exact row today. No new detection logic is needed — the gap is purely
"can't view/fix it," which is exactly this task's scope.

## Scope

**Will change:**
- `components/tax/tax-document-upload.tsx` — `DocumentRowEditable` gets four new/changed actions:
  View, Archive, Re-extract, Swap. Auto re-extract wired into the existing Save/retype flow.
- No changes to any server action's core logic. `actions/documents.ts#archiveDocument` and
  `#triggerExtraction` are called as-is, unmodified. `actions/tax-planning.ts#updateTaxDocument`,
  `#requestTaxDocumentUploadSlot`, `#finalizeTaxDocumentUpload`, `#getTaxDocumentSignedUrl` are
  called as-is, unmodified.

**Will NOT change:**
- `lib/tax-compute.ts`, `lib/tax-compute-build.ts`, `lib/doc-extract.ts`, bank-statement
  transaction import — all out of scope per the request doc, and none need touching for this UI-only
  work.
- `components/tax/other-year-documents.tsx` — read for its View pattern, not modified (it's
  correctly read-only/reference-only by design; View/Archive/Swap only matter for the *current*
  year's active editing workflow).
- No schema changes. `Document` already has every field this task needs (`fileKey`, `archivedAt`,
  `documentName`, `notes`, `taxYear`, `docType`, `extractionStatus`).
- No new server actions. Everything composes existing primitives from the client component (see
  "Swap design" below for the explicit justification).

## Affected files/modules

- `components/tax/tax-document-upload.tsx` (primary — all UI changes)
- Reused, unmodified: `actions/documents.ts` (`archiveDocument`, `triggerExtraction`),
  `actions/tax-planning.ts` (`getTaxDocumentSignedUrl`, `requestTaxDocumentUploadSlot`,
  `finalizeTaxDocumentUpload`, `updateTaxDocument`)

## Approach

### 1. View action

Add a "View" button to `DocumentRowEditable`'s non-editing action cell, before "Rename / retype."
Copy `other-year-documents.tsx`'s `handleView` pattern exactly: own `loading`/`error` local state,
`await getTaxDocumentSignedUrl(doc.id)` then `window.open(url, "_blank", "noopener,noreferrer")`,
catch block sets a generic "Couldn't open this document..." message (never surface the raw server
error — matches the existing precedent's own comment about sanitized production error messages).

### 2. Archive ("Delete") action

Add an "Archive" button (styled `text-destructive`, matching the `text-red-600`/`text-destructive`
convention used for other destructive row actions in this repo, e.g.
`components/accounts/accounts-page-client.tsx`). On click:
```
if (!confirm(`Archive "${displayName}"? It will no longer appear in this document list.`)) return;
```
(native `confirm()` — this repo's established pattern for every other single-click destructive
action; no dedicated modal component exists or is needed here). On confirm, call
`archiveDocument(doc.id)`, then `router.refresh()`. No new logic in `archiveDocument` needed — it
already does `archivedAt: new Date()` only (confirmed by reading it), satisfying ground rule 7
as-is.

`archiveDocument`'s own `revalidatePath("/documents")` does not include `/tax`, but that's
immaterial here: the row already calls `router.refresh()` client-side (same pattern
`TaxDocumentUpload`'s upload handler already uses), which forces a fresh Server Component render of
the current route regardless of which paths a given Server Action revalidated. No change to
`archiveDocument` needed.

### 3. Re-extract action

Add a standalone "Re-extract" button, always visible (not gated on docType — `triggerExtraction`
runs `extractDocument` for any docType via `classifyDocType`, with no extractable-type gate, so it's
always safe to call). On click: `await triggerExtraction(doc.id)`, then `router.refresh()`. Own
`loading` state ("Re-extracting…").

**Auto-run after retype — yes, this is the load-bearing decision for the real bug.** In
`handleSave`, after `updateTaxDocument` returns success, compare the *saved* `docType` against
`doc.docType` (the original prop value, i.e., the docType before this edit). If they differ, fire
`triggerExtraction(doc.id)` in the same handler before setting `editing` back to `false` (or
immediately after, non-blocking with its own status text) — the user should never have to
separately notice extraction is stale. If the docType did NOT change (pure rename), do not
re-extract — it would just re-run the same prompt against unchanged data, wasting an API call.
Justification: the request doc is explicit that "the mistagged-1098 fix path must not require the
user to somehow know extraction needs re-running" — auto-firing exactly when docType changes (the
only condition under which the *old* extraction is provably wrong) satisfies this with zero
guesswork, while the always-available manual "Re-extract" button separately covers "extraction
failed, want to retry" or "want to force a redo for some other reason," which retype-driven
auto-run wouldn't catch.

### 4. Swap ("replace the wrong file")

**Design: pure UI-layer composition, no new server-side logic — justified below.**

Add a "Swap file" button to the non-editing action cell. It renders (or reveals) a hidden
`<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp">` and a visible
button that calls the hidden input's `.click()` (standard hidden-file-input pattern — no new
dependency). On file selection:

1. Call the module-scope `uploadFile(file, entityId, taxYear, docType, notes)` helper that
   **already exists** in this same file (used today by the top-of-page upload form) — passing the
   **old document's own current values**: `doc.docType`, the parent's `taxYear` (the table is
   already filtered to one tax year, so this is always correct), and `doc.notes ?? undefined`. This
   requires threading `entityId` down into `DocumentRowEditable` as a new prop (it's already a prop
   one level up on `TaxDocumentUpload`/`PersonalTaxClient`, just not currently passed to the row).
   `uploadFile` already runs the full 3-step flow (`requestTaxDocumentUploadSlot` → direct PUT →
   `finalizeTaxDocumentUpload`), and `finalizeTaxDocumentUpload` **already runs extraction inline**
   for extractable docTypes (w2/1099/k1/mortgage_interest/tax_return/property_tax) — so "auto-
   trigger extraction on the new file" is already satisfied by reusing this helper unmodified for
   those types.
2. If the upload fails, stop — show the error, do NOT touch the old document. The old file stays
   the active one; nothing is lost.
3. If the upload succeeds, explicitly call `triggerExtraction(newDocumentId)` **unconditionally**,
   even for extractable docTypes where `finalizeTaxDocumentUpload` already extracted inline. This is
   a deliberate simplicity-over-efficiency call: `finalizeTaxDocumentUpload`'s "extractable" list is
   a private implementation detail of `tax-planning.ts` (not exported, not meant to be duplicated at
   the UI layer), and swap is a rare, single-document, user-initiated action — not a batch op — so
   guaranteeing a fresh extraction pass unconditionally (accepting one redundant Claude call for the
   6 extractable docTypes) is simpler and more robust than trying to mirror that private gate from
   the client and risking drift if it's ever changed server-side.
4. Only after the new upload has succeeded, call `archiveDocument(doc.id)` on the **old** document
   — never before, and never if the new upload failed. This ordering (new file lands first, old
   file archived second) means a failed swap never leaves the household with the wrong file AND no
   backup: worst case on a partial failure (upload succeeds, archive call itself somehow fails) is
   two active documents with the same docType/name momentarily, trivially fixed with one manual
   Archive click on the stale one — never data loss.
5. `router.refresh()`.

**Why no new action/component:** every primitive needed (request-slot, PUT, finalize-with-inline-
extraction, archive, explicit re-extract) already exists and is already proven (the upload form and
`archiveDocument` are both already live). The only "new" logic is sequencing four already-safe async
calls from a click handler and carrying over four already-available field values (`doc.docType`,
`doc.notes`, the parent's `taxYear`, and `entityId` threaded down as a prop) — this is orchestration,
not new business logic, and doesn't warrant a dedicated server action. Building a single new
`swapTaxDocument` server action was considered and rejected: it would just re-implement the same
upload-then-archive sequence server-side while losing the two-phase direct-to-storage upload's whole
purpose (bypassing the Vercel 4.5MB Server Action body cap — see
`.claude/agent-memory/planner/storage_and_uploads.md`), since a single action can't do the client's
direct PUT step for it.

**documentName is intentionally NOT carried over as the literal old name.** `uploadFile` →
`finalizeTaxDocumentUpload` → `uploadTaxDocumentCore` auto-generates a fresh `documentName` from the
*new* file's real extraction (`generateDocumentName`) for extractable docTypes, which is more
accurate than blindly reusing the old (possibly wrong, e.g. "W-2"-labeled) name — this is correct
behavior, not a gap, and matches how the top-of-page upload form already names every document.

### Ordering of the four actions in the row

Left to right: **View** (always first — "look before you act" per the request's own framing),
**Rename / retype** (existing, unchanged), **Re-extract**, **Swap file**, **Archive** (last,
destructive-styled, visually separated). All five/six controls fit as small `text-xs` inline text
buttons in the same action cell, consistent with this repo's existing dense-table-action convention
(see `accounts-page-client.tsx`).

## Risks / unknowns

1. **Pre-existing UX quirk, not in this task's scope to fix:** in the existing "Rename / retype"
   edit form, the `name` text field's local state is initialized once from the *original* docType
   (`doc.documentName ?? documentTypeLabel(doc.docType)`) and does **not** auto-update when the user
   changes the `docType` `<select>` mid-edit. Practically: if Eric retypes the mistagged doc from
   "W-2" to "Form 1098 (mortgage interest)" without also manually editing the name field, the saved
   `documentName` will be the *old* type's label text ("W-2") rather than "1098." This doesn't block
   the actual fix (docType and extraction — the two things that matter for tax computation — are
   both corrected), and it's visible/editable in the same form, so it's a minor cosmetic gap, not a
   functional one. Flagging rather than silently fixing since it's outside this task's stated scope
   (the request only asks for View/Archive/Re-extract/Swap, not a rename-form behavior change) —
   recommend a follow-up task if it bothers Eric in practice.
2. **`classifyDocType` has no mapping for `property_tax` or `extension`** (confirmed by reading
   `lib/doc-extract.ts`) — both fall through to filename-keyword matching, which will almost always
   miss and default to the generic "other" prompt. This is pre-existing behavior in both the initial
   upload path and `triggerExtraction`, unrelated to and unchanged by this task — Re-extract on a
   `property_tax` or `extension` document will behave exactly as it does today (a generic summary,
   no structured numeric fields), not a regression this task introduces.
3. **`triggerExtraction` re-runs unconditionally with no diffing/dedup** — clicking it twice in a
   row costs two Claude API calls. Acceptable: this is a manual, single-document, user-initiated
   action, not something automated or bulk.
4. **No confirm step on Swap**, unlike Archive. Considered adding one but decided against: the old
   file isn't touched at all until the new upload already succeeded (step 4 above), so an accidental
   file-picker cancel or a bad file selection has zero effect on the existing document — the "point
   of no return" a confirm dialog exists to guard is inherently avoided by the ordering, not by a
   confirmation prompt.
5. **`entityId` must be threaded down as a new prop to `DocumentRowEditable`.** Confirmed it's
   already available one level up (`TaxDocumentUpload`'s own `entityId` prop, sourced from
   `workspace.entityId` in `app/tax/personal/[year]/page.tsx`) — no new data-fetching needed, just a
   prop-drilling addition.

## Acceptance criteria

1. Each row in the current-year document table has working View, Rename/retype (unchanged), Re-
   extract, Swap file, and Archive controls.
2. View opens the real underlying file in a new tab via a signed URL; a storage/network failure
   shows an inline error, never a blank/silent failure.
3. Archive requires a `confirm()` before calling `archiveDocument`; after confirming, the document
   disappears from the current-year list (its `archivedAt` is set — verify no hard delete occurs,
   e.g. the row still exists in the DB with `archivedAt` non-null).
4. Re-extract calls `triggerExtraction` and, after it resolves, the row's Parsed column and
   `extractionStatus` reflect the fresh result (or "Failed" on failure, matching existing badge
   logic — no new badge states needed).
5. Saving a retype where the docType actually changed automatically re-runs extraction with no
   separate user action required; saving a rename where the docType did NOT change does not trigger
   an extra extraction call.
6. Swap: selecting a new file uploads it via the existing 3-step flow, using the OLD document's
   current `docType`/`notes`/the page's `taxYear` (no re-entry required), archives the old document
   only after the new one is confirmed uploaded, and results in exactly one active (non-archived)
   document for that logical slot after a successful swap.
7. If the new file upload during Swap fails for any reason, the old document remains fully intact
   and active (not archived) — verify this by forcing a failure (e.g. an unsupported file type) and
   confirming the original row is unchanged.
8. No code path in this task ever calls `db.document.delete` or otherwise permanently removes a
   `Document` row — archive (`archivedAt`) is the only removal mechanism, everywhere.
9. `pnpm typecheck` and `pnpm lint` pass with no new `any` usage.

## Test expectations

This is UI-heavy work in a repo with **zero DOM/component-test infrastructure** (confirmed:
`vitest.config.ts` uses `environment: "node"`, no `jsdom`/`happy-dom` dependency in `package.json`,
no `__tests__` directory anywhere under `components/`) — this matches the established convention
documented for prior UI-only tasks in this build trail (e.g. `mobile-responsive-nav`,
`entity-tab-navigation`). Do not introduce a first-of-its-kind jsdom/React Testing Library setup for
this task; that would be a deliberate infrastructure addition, not a routine test, and is out of
scope unless explicitly requested.

**What's actually pure/testable here: nothing new of substance.** Every piece of new logic in this
task is either (a) direct 1:1 calls to already-tested/already-proven server actions, or (b)
trivial orchestration (sequencing 2-4 already-safe async calls, comparing two docType strings,
picking 3-4 fields off an existing object) that doesn't rise to the level of a function worth
extracting into `lib/` and unit-testing in isolation — doing so would be test-infrastructure
ceremony for glue code, not genuine coverage of business logic. If the Coder finds the "which
fields carry over on swap" logic growing any real branching (e.g. handling `taxYear: null`
specially), extracting and testing a small pure `buildSwapUploadInput(doc, taxYear)` helper in
`lib/` would become worthwhile — but as designed, it's a plain object literal at the call site.

**Verification path instead:** `pnpm typecheck` (props/types flow correctly through the new
`entityId` prop-drilling and the new button handlers), `pnpm lint`, and manual click-through against
the real dev environment — specifically re-running the exact real-world repro (view the mistagged
doc → confirm PennyMac 1098 → retype → confirm auto re-extraction fires → confirm the amber "⚠ check
type" flag clears on next page load) since that's the concrete, real bug this task exists to fix.
Flag manual verification as required before this ships, consistent with every other UI-only task in
this repo's history (no pipeline agent has browser access — this needs human or Claude-in-Chrome
verification per `.claude/agent-memory/planner/reference_infrastructure.md`).

## Required findings section

**Yes — this fully unblocks Eric from fixing the real mistagged 2025 1098 end-to-end, with no
remaining gap**, given the exact live document confirmed above (id `cfeeec59-ea6c-4036-a10b-
7fab323cff0c`):

1. **View** — Eric clicks View on the already-amber-flagged row, the real PDF opens in a new tab,
   confirms visually it's the PennyMac 1098 (not a W-2).
2. **Retype** — using the already-working Rename/retype control (per his own confirmation), he
   changes docType from `w2` to `mortgage_interest` and saves.
3. **Re-extract** — happens automatically as part of step 2's save (docType changed → auto-fires
   `triggerExtraction`), no separate action needed. `classifyDocType("mortgage_interest", fileKey)`
   correctly maps to the `mortgage_statement` extraction prompt (confirmed by reading
   `lib/doc-extract.ts`'s `mapped` table), which will extract PennyMac's servicer name, real
   mortgage interest paid, escrow, etc. as structured `data` instead of the current garbage
   `{data: {raw: "..."}}` blob.
4. Once re-extracted successfully, `extractionData.summary` will no longer equal the literal string
   `"Could not parse extraction response."`, so `findUnparseableExtractions` will stop flagging this
   document on the next page load — the amber badge clears on its own, no manual "un-flag" step
   needed anywhere.
5. The corrected mortgage-interest figure then becomes available to
   `lib/tax-compute-build.ts`'s mortgage-interest resolver (the one currently emitting the "0
   mortgage_interest documents with usable extraction found" note this exact scenario triggers) for
   the next tax-draft computation.

No fallback (Swap) is actually needed for this specific document — it's a pure mistagging, not a
wrong-file-attached case — but the plan still builds Swap per the request's explicit requirement #4,
since batch-upload mixups are a real, named risk for this household's workflow going forward.
