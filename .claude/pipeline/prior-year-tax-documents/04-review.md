# Review — Prior-year tax document upload

## Verdict: APPROVED

All four sub-features are genuinely implemented, wired end-to-end, and match the
plan. The one real defect (redirect-swallowing `try/catch`) was caught by the
Tester and the fix is structurally correct — independently re-verified below,
not just trusted from the write-up. Typecheck, lint, and the full test suite
were independently re-run in this review (not just read from the reports):
`pnpm typecheck` clean, `pnpm lint` 0 errors / 43 pre-existing warnings (none
in touched files), `pnpm test` 395/395 across 35 files.

## Findings

### Blocking
None.

### Should-fix
None — no defects rise to should-fix. Everything below is a nit.

### Nits
- `components/tax/personal-tax-client.tsx` has no trailing newline after the
  refactor (`git diff` shows `\ No newline at end of file`). Cosmetic only,
  but worth a trailing-newline pass next time this file is touched.
- `fmtDate` is now duplicated verbatim in `tax-document-upload.tsx` and
  `other-year-documents.tsx` (previously it existed once in
  `personal-tax-client.tsx`). Not worth blocking on for two small sibling
  components, but a shared `lib/format.ts` helper would avoid a third copy if
  a future component needs the same date format.
- The plan's own noted deviations (upload card loses its "1 ·" step-numbering
  prefix; single-file success banner no longer echoes the extraction summary
  text) are honest, minor, and reasonable — not worth reversing.

## Verification performed (this review, independently)

1. **Redirect-bug fix** — read `components/tax/add-prior-year-form.tsx` and
   `components/tax/tax-entity-widget.tsx` side by side. The fix
   (`startTransition(async () => { await ensureTaxWorkspace(formData); })`,
   no `try/catch`) is structurally identical to the working, already-shipped
   pattern in `handleCreate`. Confirmed `ensureTaxWorkspace`
   (`actions/tax.ts`, untouched by this task) has no success path that
   doesn't end in `redirect(...)` — every non-redirect exit is a `throw`
   (bad input via zod, entity not found), so the removed `try/catch` was only
   ever swallowing the successful case. Confirmed validation
   (`isValidPriorYear`, entity-selected check) runs synchronously in
   `submit()` before `startTransition` — unaffected by the removal.

2. **Batch upload integrity** — read `lib/tax-doc-batch.ts` and
   `uploadTaxDocuments` in `actions/tax-planning.ts` directly. Shared fields
   are validated once (batch-level throw only for invalid entityId/taxYear/
   docType or empty/oversized batch); each file is validated and uploaded
   inside its own try/catch, pushing a discriminated-union result
   (`success: true` with `documentId`/`documentName`/`extraction`, or
   `success: false` with `error`) — one bad file never aborts the others and
   never gets silently dropped. `summarizeUploadBatch` renders every failure
   by name and reason in the UI banner. Test coverage
   (`lib/__tests__/tax-doc-batch.test.ts`) exercises all-success, all-failure,
   mixed, singleton, multi-failure, and empty-array cases.

3. **`uploadTaxDocumentCore` extraction** — diffed `actions/tax-planning.ts`
   directly. The extracted core (`uploadTaxDocumentCore`) contains the exact
   original body (storage upload, `Document` create, extraction try/catch,
   name generation) verbatim; `uploadTaxDocument(formData)` is now a thin
   FormData-parsing wrapper with identical validation, identical thrown
   errors, identical return shape. The only change is dropping an unused
   `const user =` binding — no behavior change. This is a clean refactor, not
   a rewrite.

4. **`getTaxDocumentSignedUrl` bucket-routing fix** — read the actual
   bucket-selection logic in `lib/supabase-storage.ts` and the sibling
   `actions/documents.ts#uploadDocument`/`getDocumentSignedUrl`. Confirmed
   `uploadDocument` stores the *full* `documents/{entityId}/{docId}.ext` key
   into the `receipts` bucket and `getDocumentSignedUrl` signs that same full
   key unmodified — so the new `getTaxSignedUrlSafe`'s non-`taxes/` branch
   (`getReceiptSignedUrl(fileKey)`, no stripping) is byte-for-byte consistent
   with how those documents were actually stored. The fix is correct, and it
   now has a real call site: `OtherYearDocuments`'s "View" button calls
   `getTaxDocumentSignedUrl`, so this is no longer dead code.

5. **`other-year-documents.tsx`** — confirmed genuinely read-only: the only
   interactive element is a "View" button that fetches a signed URL and opens
   it in a new tab, with an inline error message on failure (no silent
   no-op). No edit/delete/archive affordance anywhere in the component —
   correctly upholds ground rule 7. Confirmed scoping at the call sites
   (`app/tax/personal/[year]/page.tsx`, `app/tax/[workspaceId]/page.tsx`):
   both fetch all of the entity's documents, then split into
   `docs`/`otherYearDocs` by `taxYear !== currentYear`, same entity, same
   `archivedAt: null` filter as before.

6. **`add-prior-year-form.tsx`** — confirmed it calls the existing
   `ensureTaxWorkspace` (`actions/tax.ts`) directly, no new server action or
   duplicate workspace-creation path. Client-side validates with
   `isValidPriorYear` (and an entity-selected check) before building
   `FormData` and submitting.

7. **Ground rule 8 (no advice claims)** — new copy (`summarizeUploadBatch`
   messages, upload card description, "Other years" section) is all
   observational/factual ("uploaded & parsed", "failed: <file> (<reason>)"),
   no advice-language creep.

8. **Scope discipline** — `git diff --stat` against the declared file list
   matches exactly: `actions/tax-planning.ts`,
   `app/tax/[workspaceId]/page.tsx`, `app/tax/page.tsx`,
   `app/tax/personal/[year]/page.tsx`,
   `components/tax/personal-tax-client.tsx`,
   `components/tax/tax-workspace-client.tsx` modified; five new files created
   (`lib/tax-year-range.ts`, `lib/tax-doc-batch.ts`,
   `components/tax/tax-document-upload.tsx`,
   `components/tax/add-prior-year-form.tsx`,
   `components/tax/other-year-documents.tsx`) plus their two test files.
   `prisma/schema.prisma` untouched (`git diff --stat` shows no schema
   change), no new tax-document migration directory — the one new migration
   present (`20260908120000_bank_statements`) is a sibling task's untracked
   artifact, confirmed unrelated. Other modified/untracked files in the
   working tree (`actions/reports.ts`, `app/business/**`,
   `components/app-sidebar.tsx`, bank-statement files, etc.) are pre-existing
   sibling-task state, not scope creep from this task.

9. **UI verification without a browser** — same structural gap as every
   prior UI task in this repo (no pipeline agent has browser access);
   applying the established precedent. What tips this toward comfortable
   approval rather than a more cautious stance: every render-determining piece
   of logic was traced by hand to its actual JSX/props (data splits in the
   page files, prop wiring into the two shared components, the batch summary
   string flowing into the banner), the personal-workspace's pre-existing
   upload/table UX was moved into the shared component with no functional
   change (confirmed via diff, not just described), and this went through one
   real Tester-caught defect that was fixed and independently re-verified
   here against a known-good precedent — which is evidence the process
   worked, not a reason for extra suspicion of what's left. The plan itself
   flags the same manual-verification follow-up (open `/tax`, add a prior
   year for personal and business, upload a batch with one bad file, expand
   "Other years" and click View) — that remains a legitimate post-merge human
   QA step, not a pipeline-blocking gap.

## What's good

- The plan's own scope discipline held all the way through implementation —
  nothing was invented beyond what was planned (no new workspace-creation
  path, no schema change, no touching `lib/doc-extract.ts`).
- The batch-upload partial-failure design is exactly right for a tax-document
  feature: per-file try/catch, honest discriminated-union results, and a
  summarizer that never drops a failure — tested for every meaningful shape
  (all-success singular/plural, all-failure, mixed, multi-failure, empty).
- The bucket-routing fix was reasoned through symmetry with the sibling
  `actions/documents.ts` code path rather than guessed at, and the plan
  correctly scoped out fixing the *other* (still-broken) `getDocumentSignedUrl`
  bug on `/documents` as a named follow-up rather than scope-creeping into it.
- The Tester's redirect-bug catch and the Coder's fix were both genuinely
  correct, and this review re-verified the fix from first principles (reading
  `ensureTaxWorkspace`'s actual control flow) rather than trusting the
  write-up.

## What a household member can do now that they couldn't before

- **Open a genuinely new past tax year.** From `/tax`, "+ Add a prior year"
  lets you pick any entity (personal, EK Consulting, Sudden Valley, Mezzo)
  and any year back to 2000 that has never had a workspace, and it creates
  and opens that workspace immediately — previously the only years you could
  open were ones some other workspace had already touched.
- **Upload several tax documents at once**, in either a personal or a
  business workspace, instead of one file per submission. If one file in the
  batch is the wrong type or too large, the rest still upload and get parsed,
  and you're told exactly which file failed and why.
- **Upload tax documents for the business entities (EK Consulting, Sudden
  Valley) at all** — this upload capability did not exist anywhere in the UI
  for those workspaces before this change.
- **See a prior year's documents while working on the current year's
  return**, in any workspace — a collapsed "Other years" section lists that
  entity's documents from every other year, with a working "View" link,
  regardless of whether the document was originally uploaded through the
  tax-specific flow or the general document vault (the bucket-routing fix
  makes both kinds of links work correctly here for the first time).

## Outstanding (non-blocking, explicitly flagged by the plan/implementation, not new findings from this review)

- Manual/visual browser verification of all four flows is still pending —
  same structural limitation as every UI task in this pipeline, and the plan
  itself names this as required human QA before/alongside shipping.
- `actions/documents.ts#getDocumentSignedUrl` (the generic `/documents` vault
  page's "View" link) still has the pre-existing, unrelated bucket-routing
  bug for tax-flow-uploaded documents — correctly left out of this task's
  scope, recommended as a follow-up by the plan.
- No queueing/background-job system exists for a large serial-extraction
  batch; `MAX_BATCH_FILES = 25` bounds but doesn't eliminate a request-timeout
  risk on a big batch of extractable files. Accepted, documented risk, not a
  regression.
