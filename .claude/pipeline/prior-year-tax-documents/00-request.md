Add the ability to upload previous years' tax documents (and multiple documents at
once) so they can be referenced while preparing current/future tax filings. This is
Tier 3 of the platform's automation roadmap. The owner explicitly asked to check
whether this already existed before building — it was investigated thoroughly and
confirmed NOT to fully exist. Do not re-investigate from scratch; the findings below
are already verified, trust them and build from here.

VERIFIED CURRENT STATE (read the actual files yourself to confirm/extend this, but do
not re-derive it from nothing):
- `actions/tax-planning.ts`'s `uploadTaxDocument(formData)` already accepts an
  arbitrary `taxYear` (2000-2100) per upload and creates a `Document` row (entityId +
  taxYear + docType + fileKey), with AI extraction for structured types
  (w2/1099/k1/mortgage_interest/tax_return/property_tax). This is a solid, reusable
  primitive — read it in full (lib/doc-extract.ts's extractDocument,
  lib/supabase-storage.ts's uploadTaxFile too) before planning, but do not change its
  core single-document creation logic unless genuinely necessary.
- The ONLY place that calls `uploadTaxDocument` from a UI is
  `components/tax/personal-tax-client.tsx` (used by `app/tax/personal/[year]/page.tsx`),
  and its `taxYear` field is a HIDDEN input hardcoded to the currently-viewed year
  (`<input type="hidden" name="taxYear" value={props.taxYear} />`, line ~254) — there's
  no way to pick a different year from that form. It's also a single-file form
  (`formData.get("file")` expects exactly one Blob) with no `multiple` attribute.
- `app/tax/[workspaceId]/page.tsx` (the BUSINESS workspace page — EK Consulting,
  Sudden Valley) fetches `relatedDocs` via `listDocuments({entityId,
  taxYear: workspace.taxYear})` and passes them to
  `components/tax/tax-workspace-client.tsx` as READ-ONLY data — there is no upload
  form anywhere in that component. Business entities currently cannot upload tax
  documents through any UI.
- `app/tax/page.tsx` (the year-grouped index) only shows years that ALREADY have at
  least one `TaxWorkspace` row anywhere (`years = workspaces.map(w => w.taxYear) +
  currentYear`) — there's no way to introduce a genuinely new past year (e.g. 2019)
  into the system if nothing currently references it.
  `components/tax/tax-entity-widget.tsx` DOES have a working "Create Workspace"
  button (calls `ensureTaxWorkspace` in actions/tax.ts, which accepts arbitrary
  entityId+taxYear and is idempotent) — but only for years already in that `years`
  set.
- Both workspace pages currently show documents STRICTLY filtered to that
  workspace's own exact taxYear — there is no view anywhere that shows a prior
  year's documents while looking at the current year's workspace.
- `Document` model (prisma/schema.prisma, ~line 443) has `entityId`, `taxYear`
  (nullable Int), `docType`, `fileKey`, `documentName`, `notes`,
  `extractionStatus/Data/Model`, `archivedAt` (soft-delete only, tax records are
  never hard-deleted per ground rule 7). No changes to this model should be needed
  for this task — say so explicitly if you find otherwise.

SCOPE — build these four things, in this order of priority, and state plainly if you
think any should be cut/deferred:
1. **Arbitrary-year entry point.** A way to add a past year that doesn't already
   exist anywhere in the system (e.g. a manual "Add a prior year" year-number input
   near the Tax Workspaces index, that calls the existing `ensureTaxWorkspace` action
   directly rather than requiring the year to already be in the auto-derived `years`
   set). Decide the exact UI placement and validation (reasonable year range, e.g.
   not before the household's own financial history starts — check `data/` or ask if
   genuinely ambiguous, but a wide sane range like 2000-current is probably fine
   without needing to ask).
2. **Multi-file upload.** Extend the upload flow to accept multiple files in one
   submission (native `<input type="file" multiple>` is sufficient — do NOT attempt
   true OS folder/directory-tree upload with `webkitdirectory`, that's explicitly out
   of scope, inconsistent cross-browser, and not worth the complexity for "a folder
   full of documents" which multi-file select already covers in practice). Design
   exactly how this works with `uploadTaxDocument`'s current single-Blob-per-call
   shape — a new function that loops and calls the existing per-file logic (or a
   shared extracted core), one Document row per file, matching docType/taxYear
   applied to every file in the batch (don't over-engineer per-file docType
   selection in one submission unless you have a strong reason to).
3. **Business workspace upload parity.** Give `/tax/[workspaceId]` (business
   entities) the same upload capability the personal workspace already has — reuse
   `uploadTaxDocument` and the personal upload form's patterns rather than inventing
   a new upload mechanism.
4. **Prior-year reference view.** Within a given tax workspace (personal or
   business), show a collapsed/secondary section listing documents from OTHER years
   for the SAME entity (read-only, with a link/signed-URL to view each) — so
   preparing 2026's return, you can see 2025's W-2 sat right there for reference.
   Decide exactly how many prior years to show (e.g. all, or a reasonable cap) and
   how it's fetched (a new query, or extending `listDocuments`).

REQUIREMENTS:
- CLAUDE.md conventions: TypeScript strict, `requireAuth()` first line of every
  server action, ground rule 1 (never fabricate — extraction failures must be
  handled the same honest way the existing code already does, not silently
  swallowed), ground rule 7 (tax records never hard-deleted — this task shouldn't
  need any delete logic, but if you touch anything adjacent, preserve that
  invariant), ground rule 8 (observational language only).
- Match this codebase's existing patterns: read `components/tax/personal-tax-client.tsx`
  in full for the exact upload UX (loading states, error handling, extraction-result
  display) to replicate faithfully for the business workspace rather than inventing
  new UX conventions.
- Do NOT touch `lib/doc-extract.ts`'s extraction logic itself, and do NOT modify the
  Prisma schema unless you find a genuinely compelling reason (state explicitly
  either way) — this task should be achievable as pure application-layer work on top
  of the existing `Document` model.
- Testing: if any new pure logic emerges (e.g. year-range validation, a multi-file
  batching helper), test it per this repo's established pure-function pattern; if
  this task is mostly UI/action wiring with nothing meaningfully pure to test, say so
  explicitly rather than padding with low-value tests.
- Definition of done: pnpm typecheck, pnpm lint, and pnpm test (full suite) all pass
  clean. Current baseline is 381/381 tests across 33 files — state explicitly whether
  you expect that count to change.
- This task touches UI (multiple pages/forms) — note explicitly that a human must
  visually verify the rendered pages, consistent with every prior UI-touching task in
  this repo.

Given the real size here (4 sub-features across both personal and business tax
pages), feel free to recommend splitting into a smaller first pass vs. a follow-up if
you think that's warranted — make and justify that call rather than leaving it
ambiguous, the same way prior plans in this repo have made deliberate scope
decisions.
