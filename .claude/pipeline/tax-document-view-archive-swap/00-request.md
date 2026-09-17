# Request: View, Archive, and Swap for current-year tax documents

Eric confirmed the "Rename / retype" control on the current-year tax document table already works. What's
actually missing, and directly blocking him from identifying/fixing the real mistagged 2025 PennyMac 1098
(uploaded as `docType: "w2"`): **no way to view the actual file** to confirm which document is which, and
**no way to delete or swap the underlying file** if the wrong one got attached.

## What exists today (read before starting)

- `components/tax/tax-document-upload.tsx`'s `DocumentRowEditable` (the current-year table) has only
  "Rename / retype", wired to `updateTaxDocument` (`actions/tax-planning.ts`) — updates `documentName`/
  `docType` only, **never re-triggers extraction**. So even after correctly retyping a document, its
  `extractionData` stays stale (extracted under the wrong docType's prompt) until something re-runs it.
- `components/tax/other-year-documents.tsx` (the sibling "Other years" section, same page) already has a
  working "View" pattern: `getTaxDocumentSignedUrl(documentId)` (`actions/tax-planning.ts`) fetched
  client-side on click, opened via `window.open(url, "_blank", "noopener,noreferrer")`. Reuse this exact
  pattern for the current-year table rather than inventing a new one.
- `actions/documents.ts#archiveDocument(documentId)` already exists (soft-delete only —
  `archivedAt: new Date()` — matches CLAUDE.md ground rule 7, tax records are never hard-deleted). Not
  currently wired to any tax-page UI.
- `actions/documents.ts#triggerExtraction(documentId)` already exists and re-runs extraction using the
  document's *current* `docType` (via `classifyDocType`) — this is exactly what's needed after a retype,
  but nothing calls it from the tax UI today.
- The 3-step upload flow (`requestTaxDocumentUploadSlot` → client PUT to storage → `finalizeTaxDocumentUpload`)
  already exists and is what `TaxDocumentUpload`'s top-of-page upload form uses.

## What to build

1. **View** — add a "View" action to `DocumentRowEditable` (current-year table), same pattern as
   `other-year-documents.tsx`'s `handleView`. Opens the real file so Eric can visually confirm what a
   document actually is before deciding to retype/archive/swap it.
2. **Archive ("Delete")** — add an "Archive" action wired to the existing `archiveDocument`. This is soft-
   delete only, per ground rule 7 — do not build or expose anything that hard-deletes a `Document` row.
   Needs a confirm step (even a simple native `confirm()` or equivalent) since it removes the document
   from the active list.
3. **Re-extract** — add a "Re-extract" action wired to the existing `triggerExtraction`, so after
   correcting a docType via retype, Eric can force a fresh extraction pass under the now-correct prompt
   without needing to archive/re-upload. Decide (and state in the plan) whether this should also
   auto-offer/auto-run right after a successful retype, or stay a separate always-available button — your
   call, but the mistagged-1098 fix path must not require the user to somehow know extraction needs
   re-running.
4. **Swap ("replace the wrong file")** — the case where the docType/name are already correct but the
   *actual uploaded file* is wrong (e.g. two documents got mixed up during a batch upload). Design this
   as a single guided action from the user's perspective, built on top of the existing safe primitives:
   archive the current `Document` row (ground rule 7 — never hard-delete) + upload a new file via the
   existing 3-step flow, carrying over the original's `docType`/`documentName`/`notes`/`taxYear` so the
   user doesn't have to re-enter them, then auto-trigger extraction on the new file. Justify in the plan
   whether this needs its own dedicated action/component or can compose the existing upload-slot flow +
   `archiveDocument` + `triggerExtraction` from the UI layer without new server-side logic.

## Ground rules

- Tax documents are never hard-deleted — archive only (`archivedAt`), per CLAUDE.md ground rule 7. This
  applies to every part of this task, including "swap" (the old file's `Document` row must be archived,
  never removed).
- `requireAuth()` first line of any new/changed server action.
- `Decimal`/cents N/A here (no money math in this task) but follow every other repo convention:
  TypeScript strict, no `any`.
- Don't touch `lib/tax-compute.ts`, `lib/tax-compute-build.ts`, or the bank-statement transaction-import
  feature — unrelated to this task.
- No financial/tax advice framing changes needed here — this is a document-management UX fix.

## Required findings section

Confirm explicitly in the plan: does this fully unblock Eric from fixing the real mistagged 2025 1098 in
production today (view it → confirm it's the PennyMac statement → retype to "Form 1098 (mortgage
interest)" → re-extract), or is there still a gap? If a gap remains, name it precisely.
