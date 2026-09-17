# Test Report: View, Archive, Re-extract, and Swap for current-year tax documents

## Verdict: PASS

I independently re-verified this implementation via full code trace of the actual diff, `actions/documents.ts`,
`actions/tax-planning.ts`, and `lib/doc-extract.ts`, plus re-running `pnpm typecheck`, `pnpm lint`, and `pnpm test`
myself. I stake this verdict specifically on the two critical areas the task asked me to stake my name on:

- **Ground rule 7 (no hard delete):** confirmed clean. No `.delete(` call anywhere in the diff or in the
  server actions it calls. `archiveDocument` is unmodified and does `archivedAt: new Date()` only.
- **Swap ordering (data-loss safety):** confirmed clean by trace, including a detail neither the plan nor the
  implementation doc mentioned: `requestTaxDocumentUploadSlot` creates **zero** DB rows (only generates a
  `documentId`/`fileKey`/signed URL) — the `Document` row is only written inside `finalizeTaxDocumentUpload`
  after it independently re-downloads the file from storage to verify the PUT actually landed. So a failed
  swap upload leaves not just the old document untouched, but literally no orphaned `Document` row at all —
  stronger than the plan's own claim.

One non-blocking, low-severity defect was found (button-combination race across sibling row actions, not a
data-loss issue) — see Defects Found. Manual browser click-through is still required before Eric relies on
this for the real mistagged 1098; I have no browser access, consistent with prior sessions.

## Acceptance criteria checklist

1. **Each row has working View, Rename/retype, Re-extract, Swap file, Archive controls.** PASS — all five
   controls present in `DocumentRowEditable`'s non-editing action cell
   (`components/tax/tax-document-upload.tsx:515-557`), each wired to its claimed handler.

2. **View opens the real file via signed URL; failure shows inline error, never silent.** PASS by trace —
   `handleView` (lines 349-362) calls `getTaxDocumentSignedUrl(doc.id)` then `window.open(url, "_blank",
   "noopener,noreferrer")`; catch sets `viewError` rendered at line 560. `getTaxDocumentSignedUrl`
   (`actions/tax-planning.ts:406+`) confirmed unmodified. Not click-tested (no browser).

3. **Archive requires confirm(); after confirming, doc disappears from list; no hard delete (archivedAt set,
   row still exists).** PASS — `handleArchive` (lines 377-391) calls native `confirm(...)` first, returns
   early if declined; on confirm calls `archiveDocument(doc.id)` (confirmed unmodified,
   `actions/documents.ts:188-196`, `archivedAt: new Date()` only, no delete) then `router.refresh()`.

4. **Re-extract calls triggerExtraction; Parsed column/extractionStatus reflect fresh result or Failed.**
   PASS by trace — `handleReExtract` (lines 364-375) calls `triggerExtraction(doc.id)` then
   `router.refresh()`. `triggerExtraction` (`actions/documents.ts:200-236`, confirmed unmodified) sets
   `extractionStatus: "processing"` then `"complete"` or `"failed"` on error (caught internally, never
   rethrows for extraction errors) — matches the row's existing badge logic (lines 478-486) unchanged.

5. **Retype where docType changed auto-re-runs extraction with no separate user action; unchanged docType
   does not trigger an extra call.** PASS by trace — `handleSave` (lines 308-347) captures
   `originalDocType = doc.docType` (the prop, i.e. pre-edit value) before calling `updateTaxDocument`, then
   compares the *local* `docType` state (what was actually submitted) against it. `triggerExtraction(doc.id)`
   only fires inside `if (docType !== originalDocType)` (line 331). A pure rename takes the `else` branch
   (line 344) — no extraction call, just `router.refresh()`.

6. **Swap: uploads via 3-step flow using OLD doc's docType/notes/page taxYear (no re-entry); archives old
   only after new is confirmed uploaded; results in exactly one active document.** PASS by trace —
   `handleSwapFileChange` (lines 393-428) calls `uploadFile(file, entityId, taxYear, doc.docType as
   TaxDocType, doc.notes ?? undefined)` — all four values sourced from the OLD document/page props, none
   re-entered by the user. `archiveDocument(doc.id)` (the OLD doc) is the **last** call in the success path,
   strictly after `uploadFile` returns `success: true` and after `triggerExtraction(result.documentId)` (the
   NEW doc) completes. Verified `TAX_DOC_TYPES` (`actions/tax-planning.ts:158-168`) exactly matches the
   component's local `TaxDocType` union (lines 59-61), so the `as TaxDocType` cast on `doc.docType` cannot
   silently pass through an invalid enum value.

7. **If new-file upload fails, old document remains fully intact/active.** PASS by trace — `if
   (!result.success) { setSwapError(result.error); return; }` (lines 409-412) exits before either
   `triggerExtraction` or `archiveDocument` is reached. Independently confirmed via
   `requestTaxDocumentUploadSlot`/`finalizeTaxDocumentUpload` (`actions/tax-planning.ts`) that a failed
   upload never creates a `Document` row in the first place (see Verdict section) — so a failed swap leaves
   zero trace anywhere, not just "old doc untouched."

8. **No code path in this task ever calls `db.document.delete` or otherwise hard-removes a `Document` row.**
   PASS — grepped `.delete(` across the diff, `actions/documents.ts`, and `actions/tax-planning.ts`: zero
   matches. Command run: `grep -n "\.delete(" -r actions/documents.ts actions/tax-planning.ts
   components/tax/tax-document-upload.tsx` → no output.

9. **`pnpm typecheck` and `pnpm lint` pass with no new `any`.** PASS — see Tests Run below for actual output.
   0 typecheck errors, 0 lint errors (47 pre-existing warnings, none in the changed file).

## Tests run (real output)

```
$ cd D:/Repos/Personal/kinniburgh-finance && pnpm typecheck
$ tsc --noEmit
(clean exit, zero output beyond the command banner)
```

```
$ cd D:/Repos/Personal/kinniburgh-finance && pnpm lint
...
✖ 47 problems (0 errors, 47 warnings)
  0 errors and 1 warning potentially fixable with the `--fix` option.
```
Scanned the full warning list: all 47 are in pre-existing files unrelated to this task
(`category-drilldown-modal.tsx`, `transfer-history-panel.tsx`, `insurance-policy-card.tsx`,
`offline-indicator.tsx`, `retroactive-rule-modal.tsx`, `vault-verify-client.tsx`, various unused-var
warnings, `prisma/seed.ts`, `lib/__tests__/*`). None reference `tax-document-upload.tsx`.

```
$ cd D:/Repos/Personal/kinniburgh-finance && pnpm test
...
 Test Files  52 passed (52)
      Tests  736 passed (736)
```
Full suite green, no regressions from this change (expected — no `lib/` files touched).

```
$ git diff --stat
 components/tax/tax-document-upload.tsx | 190 +++++++++++++++++++++++++++++++--
 1 file changed, 182 insertions(+), 8 deletions(-)
```
Confirms single-file scope exactly as claimed — no server action files modified.

```
$ grep -n "\.delete(" -r actions/documents.ts actions/tax-planning.ts components/tax/tax-document-upload.tsx
(no matches)
```

Also independently read (not just trusted the implementation doc's citation of):
- `actions/documents.ts` lines 188-236 (`archiveDocument`, `triggerExtraction`) — full text, unmodified.
- `actions/tax-planning.ts` lines 264-410 (`requestTaxDocumentUploadSlot`, `finalizeTaxDocumentUpload`,
  `updateTaxDocument` schema, `getTaxDocumentSignedUrl` signature) — unmodified.
- `lib/doc-extract.ts` lines 192-216 (`classifyDocType`) — confirmed `mortgage_interest: "mortgage_statement"`
  at line 204, independently verifying the plan/implementation's citation rather than trusting it.

## Tests added

None. Per the plan's own test-expectations section (repo has zero DOM/component-test infra — `node`
environment in `vitest.config.ts`, no jsdom/RTL, no `__tests__` under `components/`), and I independently
confirmed the Swap "which fields carry over" logic is genuinely a flat object-literal call site with no
branching (`doc.docType`, `doc.notes ?? undefined`, `taxYear`, `entityId` — no conditional logic), so no pure
helper is being under-tested by omission. Agree with the Coder that introducing jsdom/RTL for this one task
would be disproportionate infrastructure ceremony, consistent with prior UI-only tasks in this repo
(`entity-tab-navigation`, `mobile-responsive-nav`).

## Defects found

### 1. Same-row action buttons don't cross-gate against each other (low severity, non-blocking)

Each of the five non-editing row actions (View/Rename/Re-extract/Swap/Archive) is `disabled={}` only on its
*own* loading flag (`viewLoading`, `extracting`, `archiving`, `swapping`) — none is disabled while a
*different* action is in flight on the same row/document id. Concretely:

- A user can click **Archive** while a **Swap** upload is still in flight for the same row (Archive isn't
  gated on `swapping`). This calls `archiveDocument(doc.id)` immediately. When the in-flight Swap later
  finishes, it calls `archiveDocument(doc.id)` again on the same (already-archived) row — harmless no-op,
  but the net result can be two independent `router.refresh()` calls and a confusing sequence of UI states.
- A user can click **Re-extract** on a document while a concurrent **Swap** is archiving it. `triggerExtraction`
  (`actions/documents.ts:200-236`) has no `archivedAt: null` guard on its `db.document.findUniqueOrThrow` —
  it will happily write fresh `extractionData` onto a now-archived row. Not data loss (the row still exists,
  archived, with updated extraction fields) and not a ground-rule-7 violation, but it's wasted work and
  slightly surprising (an archived document silently getting new extraction data after being "removed").

**Why not blocking:** neither path touches `.delete(`, neither can strand the household without a file
(worst case is a redundant archive no-op or extraction data written to an inactive row), and both require a
user to deliberately fire two different destructive-ish actions on the same row within a few hundred
milliseconds of each other — a narrow, low-likelihood window, not the primary swap-ordering/hard-delete
concern this task exists to guard against. Flagging for the Coder/Planner to consider for a future
polish pass (e.g. gate all five buttons on `viewLoading || extracting || archiving || swapping` collectively),
not blocking this task's PASS.

### 2. Mid-edit combination — confirmed NOT a bug (verified, not found)

Checked explicitly per the task's prompt #7 concern ("could Swap fire while mid-edit in the rename form?").
Traced the render logic (lines 491-558): the entire View/Rename/Re-extract/Swap/Archive button row only
renders in the `editing === false` branch; the `editing === true` branch renders only Save/Cancel. This
structurally prevents Swap (or any other action) from being triggered while the rename form is open — the
buttons simply don't exist in the DOM at that point. No fix needed; confirming this is sound, not a gap.

## Not tested

- **Live click-through in a real browser.** I have no browser access (confirmed limitation, consistent with
  every prior UI-only task in this repo's pipeline history). All verification above is a full, line-level
  code trace of the actual diff and every server action/lib function it calls — not a guess at expected
  behavior. This does **not** substitute for an actual click-through of the real repro: open the tax
  workspace for entity `6f55fa50-9d94-47a8-92d6-2cc5abeac714`, find the amber-flagged row for document
  `cfeeec59-ea6c-4036-a10b-7fab323cff0c`, click View to visually confirm the PennyMac 1098 PDF actually opens,
  retype `w2` → `mortgage_interest`, save, confirm the "DocType changed — re-extracting…" status text appears
  and the amber badge clears after refresh. **This manual step is still required before Eric relies on this
  for the real document** — flagging exactly as the Coder's implementation doc already does, and reiterating
  per the task's own instruction #8.
- **Storage-layer failure modes** (e.g. signed URL generation actually failing against live Supabase, PUT
  failing partway through a large file) — only traced via the code's error-handling branches, not exercised
  against a real storage backend.
- **`property_tax`/`extension` re-extract quality** — pre-existing gap in `classifyDocType`'s fallback
  behavior (confirmed unchanged, not a regression from this task), out of this task's scope to fix.
