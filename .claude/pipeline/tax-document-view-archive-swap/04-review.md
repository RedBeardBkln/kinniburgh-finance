# Review: View, Archive, Re-extract, and Swap for current-year tax documents

## Verdict: APPROVED

Independently read the full request, plan, implementation, and test report, then read
`components/tax/tax-document-upload.tsx` in full (not just the diff), re-ran `git diff --stat` /
`git status` for scope, re-ran `pnpm typecheck` myself (clean), and read every server action this
component calls (`archiveDocument`, `triggerExtraction`, `updateTaxDocument`,
`requestTaxDocumentUploadSlot`, `finalizeTaxDocumentUpload`, `getTaxDocumentSignedUrl` in
`actions/documents.ts` / `actions/tax-planning.ts`) directly from disk rather than trusting the
Coder/Tester's citations.

## Scrutiny items (per task instructions)

**1. Ground rule 7 (archive-only, never hard-delete).** Confirmed myself, independently of the
Tester's grep: `grep -n "\.delete(\|delete(" -r actions/ lib/ components/tax/` shows 13 hits, none
on the `Document` model (they're `Budget`, `DebtDetail`, `ScheduledTransfer`, `AccrualDraw`,
`GlCode`, `FinancialGoal`, `IncomeSource`, `RecurringExpense`, `TagRule`, `Tag`,
`TaxChecklistItem`, `VaultEntry`, `PushSubscription`). `archiveDocument` (`actions/documents.ts:188-196`)
is unmodified and does `archivedAt: new Date()` only, with an explicit `// Hard delete is forbidden
— archive only` comment already in place before this task touched anything. No code path in the
diff calls `.delete(` on `Document`, directly or transitively. **Clean.**

**2. Cross-action race on the same row (Tester's non-blocking finding).** Confirmed by reading the
diff myself: each of View/Re-extract/Archive/Swap is `disabled={}` only on its own loading flag —
none checks the others. I independently confirmed the specific mechanism the Tester named:
`triggerExtraction` (`actions/documents.ts:200-236`) does `db.document.findUniqueOrThrow({ where: {
id: documentId } })` with no `archivedAt: null` filter, so a Re-extract that lands after a
concurrent Swap's `archiveDocument` call would write fresh `extractionData` onto an archived row.

**My call: genuinely non-blocking, agree with the Tester's severity assessment.** Reasoning:
- This is a single-user-at-a-time household app (Eric or Eva, not concurrent multi-tenant traffic)
  with no realistic double-click-across-two-different-buttons-on-the-same-row scenario in normal use.
- I confirmed the blast radius is bounded: the row-list query that feeds this whole table already
  filters `archivedAt: null` at three call sites I checked (`app/tax/personal/[year]/page.tsx:44,61`,
  `lib/tax-compute-build.ts:617`), so an archived-but-re-extracted row is invisible everywhere that
  matters (UI list, tax-draft computation) — the wasted write is inert, not silently corrupting a
  number Eric or a CPA would see.
- No `.delete(` is reachable from either path; the ground-rule-7 invariant holds even in the race.
- Fixing this properly (a shared per-row "any action in flight" boolean, or an `archivedAt: null`
  guard added to `triggerExtraction`) is a reasonable small follow-up but not worth blocking a real,
  currently-live user-facing gap over a sub-second, two-deliberate-clicks race with no data-loss or
  ground-rule outcome. **Not routing back for this.**

**3. End-to-end unblock claim, traced myself.** View → `getTaxDocumentSignedUrl(doc.id)` →
`window.open` opens the real file (unmodified action, confirmed at `actions/tax-planning.ts:406-414`).
Retype `w2` → `mortgage_interest` via existing Rename/retype form → `handleSave` captures
`originalDocType = doc.docType` before calling `updateTaxDocument`, compares it against the
submitted `docType` state after a successful save, and fires `triggerExtraction(doc.id)`
automatically when they differ (`tax-document-upload.tsx:315,331`) — confirmed this is the *only*
place extraction is gated on docType-changed, and a pure rename correctly skips it. Inside
`triggerExtraction`, `classifyDocType(doc.docType, doc.fileKey)` is called against the DB's
just-persisted value; I independently re-grepped `lib/doc-extract.ts` and confirmed
`mortgage_interest: "mortgage_statement"` at line 204, so this routes to the mortgage-statement
prompt, not the stale W-2 one. On success, `extractionData.summary` is overwritten
(`actions/documents.ts:216-224`), so it stops being the literal string `"Could not parse extraction
response."` that `findUnparseableExtractions` keys off — the amber flag is server-computed from
fresh data on next render, not client-side state, so `router.refresh()` (called in the `finally`
block regardless of extraction outcome) correctly clears it. **Confirmed true, no gap.**

**4. Scope discipline.** `git status --porcelain` / `git diff --stat` both confirm exactly one file
changed (`components/tax/tax-document-upload.tsx`, 182 insertions / 8 deletions), matching the plan
and implementation doc's stated single-file scope exactly. No server action files, no schema, no
unrelated files touched.

**5. UI/UX risk — Swap vs. the top-of-page upload form.** Read the full JSX. The top-of-page upload
form is a large, boxed section with a labeled multi-file `<input>`, a docType `<select>`, and a
primary-styled button reading "Upload & Parse". "Swap file" is a small `text-xs` inline text link
inside a specific row's action cell, grouped with View/Rename/Re-extract/Archive — spatially and
visually distinct from the top form, and contextually scoped to one document. I don't think this
risks confusion with "uploading a new document." One nit: the label "Swap file" doesn't hint that it
also archives the old document as a side effect — a slightly more explicit label ("Replace file"
with a tooltip, or the same wording used in the plan's own framing) would be marginally clearer, but
this is a nit, not a blocker — the plan explicitly and reasonably rejected a confirm dialog because
the ordering itself (new file must land before the old one is touched) makes an accidental click
harmless, and I agree with that reasoning after reading the code myself.

## Other findings

- **should-fix (non-blocking):** `triggerExtraction`'s missing `archivedAt: null` guard (item 2
  above) is pre-existing repo behavior, unmodified by this task, but this task is what makes it newly
  reachable via a same-row UI race. Worth a follow-up ticket, not a blocker here.
- **nit:** Swap's catch-all error message ("Swap failed — the original document was not changed")
  would be slightly inaccurate in the rare case where `archiveDocument`'s server call actually
  committed but the client never got a successful response (network drop after commit) — the old doc
  would in fact be archived despite the message. This matches every other handler in this same file's
  pre-existing catch-block convention (assume no-response-received means no-effect), so it's not a
  new pattern this task introduced; not worth blocking on.
- **nit:** the plan's own risk #1 (retype doesn't auto-refresh the `documentName` field when the
  user changes docType mid-edit, so a retyped doc can end up with a stale-looking display name like
  "W-2" after being corrected to `mortgage_interest`) is real, confirmed by reading `handleSave`/the
  `name` state initialization, and correctly out of scope — flagged, not fixed, consistent with the
  plan's explicit call.

## What's good

- The Swap ordering (new file must fully land, including its own re-extraction call, before the old
  document is archived) is exactly right for a ground-rule-7-sensitive feature, and the Coder
  followed the plan's sequencing precisely — verified by reading the actual `handleSwapFileChange`
  body, not just trusting the summary.
- Reused every existing primitive (`archiveDocument`, `triggerExtraction`, `uploadFile`,
  `getTaxDocumentSignedUrl`) unmodified rather than inventing new server-side logic for what is
  fundamentally client-side orchestration — correctly scoped, and correctly justified in the plan why
  a dedicated `swapTaxDocument` server action was rejected (would lose the direct-to-storage PUT's
  whole point).
- Auto-re-extract-on-docType-change is the actual load-bearing fix for the real reported bug, and
  it's implemented with a precise, correct condition (compare pre-edit vs. submitted docType) rather
  than something looser like "always re-extract on any save."
- Error handling is consistent across all five new/changed handlers (sanitized user-facing messages,
  own loading/error state per action, no raw server errors surfaced).
- Both the Coder and Tester did real, independent verification (DB queries, line citations, re-running
  commands) rather than restating each other's claims — this made my own review faster and more
  targeted.

## Outstanding before Eric relies on this for the real document

Consistent with every other UI-only task in this repo's pipeline history, no pipeline agent
(Planner/Coder/Tester/Reviewer) has browser access. Eric (or a future Claude-in-Chrome session with
real login credentials) still needs to actually click through the live repro against the real
mistagged document — `id cfeeec59-ea6c-4036-a10b-7fab323cff0c`, `entityId
6f55fa50-9d94-47a8-92d6-2cc5abeac714` — to confirm at runtime: View opens the real PennyMac 1098 PDF,
retyping to `mortgage_interest` and saving shows the "DocType changed — re-extracting…" status text,
and the amber "⚠ check type" badge actually clears after the page refreshes. Everything above is a
full code-level trace, not a live click-through.

If approved, this is the fifth task in tonight's build trail and directly resolves the gap Eric
raised this session — but the manual verification step above is the one piece no agent in this
pipeline can complete.
