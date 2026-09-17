# Implementation: View, Archive, Re-extract, and Swap for current-year tax documents

## Summary of changes

**`components/tax/tax-document-upload.tsx`** (only file touched — matches plan's stated scope exactly):

- **Imports**: added `getTaxDocumentSignedUrl` to the existing `@/actions/tax-planning` import, and a
  new import `{ archiveDocument, triggerExtraction }` from `@/actions/documents`. Added `useRef` to
  the existing `react` import (needed for the hidden Swap file input).
- **`TaxDocumentUpload`**: the `documents.map(...)` call now passes `entityId` and `taxYear` down to
  each `DocumentRowEditable` (previously only `doc` and `flagged` were passed) — this is the
  prop-drilling the plan flagged as risk #5 (`entityId` was already a prop one level up; no new
  data-fetching needed).
- **`DocumentRowEditable`**: rewritten to accept `entityId: string` and `taxYear: number` as new
  props, alongside the existing `doc`/`flagged`. Added:
  - `handleView` — copied `other-year-documents.tsx`'s `handleView` pattern exactly: own
    `viewLoading`/`viewError` state, `getTaxDocumentSignedUrl(doc.id)` → `window.open(url, "_blank",
    "noopener,noreferrer")`, sanitized catch message ("Couldn't open this document…"), never surfaces
    the raw server error.
  - `handleArchive` — native `confirm("Archive \"${displayName}\"? ...")`, then `archiveDocument(doc.id)`,
    then `router.refresh()`. Styled `text-destructive` per the repo's destructive-action convention.
  - `handleReExtract` — standalone, always-visible button; `triggerExtraction(doc.id)` then
    `router.refresh()`, own `extracting`/`extractError` state, "Re-extracting…" label while pending.
  - **Auto re-extract wired into `handleSave`**: captures `originalDocType = doc.docType` (the prop
    value, i.e. the docType before this edit) before calling `updateTaxDocument`. After a successful
    save, compares the saved `docType` (local state, what was actually submitted) against
    `originalDocType`. If they differ, fires `triggerExtraction(doc.id)` non-blockingly (with its own
    `statusMsg`/`extractError` state) after `setEditing(false)`, matching the plan's explicitly
    permitted alternative ("or immediately after, non-blocking with its own status text"). If the
    docType did NOT change (pure rename), no extra extraction call is made.
  - `handleSwapFileChange` — hidden `<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp">`
    wired via `useRef` + a visible "Swap file" button calling `.click()`. On file selection: calls the
    module-scope `uploadFile(file, entityId, taxYear, doc.docType as TaxDocType, doc.notes ?? undefined)`
    helper already in this file (used unmodified). If the result is a failure, shows the error inline
    and stops — the old document is never touched. If it succeeds, unconditionally calls
    `triggerExtraction(result.documentId)` on the new document (per the plan's explicit
    simplicity-over-efficiency justification — this happens even for extractable docTypes where
    `finalizeTaxDocumentUpload` already extracted inline), then — only after both of those have
    succeeded — calls `archiveDocument(doc.id)` on the OLD document, then `router.refresh()`. Upload
    lands strictly before archive in all cases; a failed upload never touches the old document.
  - Row action cell: non-editing state now renders View → Rename/retype → Re-extract → Swap file →
    Archive (left to right, matching the plan's specified ordering, destructive Archive last and
    visually distinct via `text-destructive`). Editing state (Save/Cancel) is unchanged. Per-action
    error/status lines render below the button row.

No other files were changed. `actions/documents.ts` (`archiveDocument`, `triggerExtraction`) and
`actions/tax-planning.ts` (`getTaxDocumentSignedUrl`, `requestTaxDocumentUploadSlot`,
`finalizeTaxDocumentUpload`, `updateTaxDocument`) were read but not modified, exactly as scoped.

## Deviations from the plan

None. Followed the plan's design for View/Archive/Re-extract/auto-re-extract/Swap ordering and
sequencing as written, including the explicit "unconditional re-extract on swap even though
`finalizeTaxDocumentUpload` may have already extracted inline" call and the "upload new file before
archiving old" ordering for data-loss safety.

## Commands run and their results

- `pnpm typecheck` (`tsc --noEmit`) — ran clean, **zero errors**, no output beyond the command
  banner. Confirms the new `entityId`/`taxYear` props flow correctly through
  `TaxDocumentUpload` → `DocumentRowEditable`, and all new handler/state types check out (no `any`
  introduced).
- `pnpm lint` — **0 errors, 47 warnings**. All 47 warnings are pre-existing and unrelated to this
  task's file (`useEffect`/`set-state-in-effect` warnings in `category-drilldown-modal.tsx`,
  `transfer-history-panel.tsx`, `insurance-policy-card.tsx`, `offline-indicator.tsx`,
  `retroactive-rule-modal.tsx`, `vault-verify-client.tsx`; assorted unused-var warnings in
  `document-review-client.tsx`, `income-sources-card.tsx`, `paystub-confirm-form.tsx`,
  `entities-client.tsx`, `retirement-balance-form.tsx`, `vault-client.tsx`, `lib/__tests__/*`,
  `lib/encrypt.ts`, `lib/plaid-sync.ts`, `lib/transfer-match-runner.ts`, `prisma/seed.ts`). None
  reference `tax-document-upload.tsx` — confirmed by scanning the full lint output for the file
  name. This matches this repo's known-baseline pattern documented in coder memory
  (`.claude/agent-memory/coder/commands.md`).
- `git diff --stat` — confirms exactly one file changed: `components/tax/tax-document-upload.tsx`
  (182 insertions, 8 deletions), matching the plan's stated single-file scope.
- No new Vitest tests were added or run beyond confirming none were warranted (see below) — did not
  run `pnpm test` since nothing in `lib/` changed.

## Test expectations — confirmed no pure-logic helper was warranted

Per the plan's own test-expectations section, checked whether the Swap "which fields carry over"
logic grew any real branching that would justify extracting a `buildSwapUploadInput(doc, taxYear)`
helper into `lib/`. It did not: the actual call site is a flat set of already-existing values
(`doc.docType`, `doc.notes ?? undefined`, the parent's `taxYear`, `entityId`) passed directly into
the pre-existing `uploadFile` helper — no conditional logic, no `taxYear: null` special-casing (the
table this task's Swap button lives on is already filtered to a single non-null tax year). No new
test file was added, consistent with the plan's explicit call and this repo's confirmed lack of
DOM/component-test infrastructure (`vitest.config.ts` uses `environment: "node"`, no jsdom/RTL
dependency, no `__tests__` under `components/`).

## Required findings — restated verdict and trace-through

**Plan's verdict: "Yes — this fully unblocks Eric from fixing the real mistagged 2025 1098
end-to-end, with no remaining gap."** I confirm my implementation actually delivers this, traced
against the real live document (`id cfeeec59-ea6c-4036-a10b-7fab323cff0c`,
`entityId 6f55fa50-9d94-47a8-92d6-2cc5abeac714`):

1. **View** — this document is already in `mistaggedDocs` → `flaggedDocumentIds`, so its row already
   renders with the amber "⚠ check type" badge (pre-existing, unchanged). Clicking the new "View"
   button calls `getTaxDocumentSignedUrl(doc.id)` (unmodified server action) → `window.open(url, ...)`,
   opening the real PennyMac 1098 PDF in a new tab. Confirmed by code trace: `getTaxDocumentSignedUrl`
   looks up `doc.fileKey` and delegates to `getDocumentFileSignedUrl`, which is bucket/prefix-agnostic
   per its own doc comment — no change needed there.
2. **Retype** — clicking "Rename / retype" (unchanged), changing the `docType` `<select>` from `w2`
   to `mortgage_interest`, and clicking Save calls the existing `updateTaxDocument`, persisting the
   new `docType` to the DB row.
3. **Re-extract auto-fires** — in `handleSave`, `originalDocType` (`"w2"`, captured from `doc.docType`
   before the edit) is compared against the saved `docType` (`"mortgage_interest"`). Since they
   differ, `triggerExtraction(doc.id)` fires automatically — no separate user action required. Inside
   `triggerExtraction` (unmodified, `actions/documents.ts`), it re-reads the document fresh from the
   DB (`db.document.findUniqueOrThrow`), so it sees the just-persisted `docType: "mortgage_interest"`,
   then calls `classifyDocType("mortgage_interest", doc.fileKey)`. Traced `lib/doc-extract.ts`'s
   `mapped` table directly: `mortgage_interest: "mortgage_statement"` (line 204) — confirmed this
   maps correctly to the `mortgage_statement` extraction prompt, not the `w2` one, so the fresh
   extraction will actually attempt to parse PennyMac's servicer name, interest paid, escrow, etc. as
   structured data instead of re-running the W-2 prompt that produced the original garbage
   `{data: {raw: "..."}}` refusal blob.
4. Once `triggerExtraction` completes successfully, `extractionData.summary` is overwritten with the
   new extraction's real summary — no longer the literal string `"Could not parse extraction
   response."` — so `findUnparseableExtractions` (`lib/tax-compute-build.ts`, unchanged) stops
   flagging this document on the next page load. The amber badge clears automatically the next time
   `mistaggedDocs` is recomputed server-side; `router.refresh()` (called in the `finally` block of the
   auto-re-extract branch) forces exactly that recomputation without a full page reload.
5. The corrected mortgage-interest data becomes available to `lib/tax-compute-build.ts`'s
   mortgage-interest resolver for the next tax-draft computation, per the plan's framing — no changes
   were made to that file, consistent with scope.

No fallback (Swap) is needed for this specific document, as the plan notes — it's a pure mistagging,
not a wrong-file-attached case — and Swap was still built per requirement #4 for future batch-mixup
scenarios.

## Open items

1. **Manual click-through verification is still required before this ships** — consistent with this
   repo's established convention for every UI-only task (no pipeline agent has browser access; per
   `.claude/agent-memory/planner/reference_infrastructure.md` and coder memory
   `no-browser-tool-for-manual-verification.md`). I traced the exact repro path against the real code
   (above) but did not and could not click through it live. Recommend Eric or Claude-in-Chrome
   actually: open the tax workspace page for the 2025 entity, find the amber-flagged row for document
   `cfeeec59-ea6c-4036-a10b-7fab323cff0c`, click View to visually confirm the PennyMac 1098, retype to
   `mortgage_interest`, save, and confirm the badge clears on the next page load/refresh.
2. **Pre-existing UX quirk, out of this task's scope** (per plan risk #1): the "Rename / retype" name
   field doesn't auto-update when the docType `<select>` changes mid-edit. If Eric retypes without
   also manually editing the name, the saved `documentName` will still read the old type's label
   ("W-2") even though `docType` and the extraction (the two things that actually matter for tax
   computation) are both corrected. Flagging per the plan's own call, not fixing — outside this
   task's stated scope.
3. **`classifyDocType` has no dedicated mapping for `property_tax` or `extension`** (pre-existing,
   confirmed unchanged in `lib/doc-extract.ts`) — Re-extract on those docTypes falls through to
   filename-keyword matching and will usually land on the generic "other" prompt. Not a regression
   introduced by this task; behaves identically to the existing upload-time extraction path.
