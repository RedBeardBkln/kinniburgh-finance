# Test Report — Prior-year tax document upload (RE-TEST after fix)

## Verdict: PASS

The single defect from the prior FAIL pass (`components/tax/add-prior-year-form.tsx`
swallowing the successful `NEXT_REDIRECT` control-flow rejection in a local `try/catch`) is
genuinely fixed. Full re-verification of typecheck/lint/test and a scope check confirm no
regressions and no scope creep. All other acceptance criteria, previously verified PASS and
confirmed untouched by this fix (via file mtimes, all predating the prior FAIL report), still
hold.

## Acceptance criteria checklist

1. **"Add a prior year" form creates + opens a workspace for a zero-workspace year (personal
   and business).** **PASS (was FAIL).** Read the current `add-prior-year-form.tsx` in full.
   The `try/catch` around `ensureTaxWorkspace(formData)` is genuinely gone:
   ```js
   startTransition(async () => {
     await ensureTaxWorkspace(formData);
   });
   ```
   This is structurally identical to the working precedent in
   `components/tax/tax-entity-widget.tsx`'s `handleCreate` — both call
   `ensureTaxWorkspace(fd)` unguarded, directly inside `startTransition(async () => {...})`,
   with no `try/catch` wrapping the call, allowing Next's `NEXT_REDIRECT` rejection to
   propagate to the nearest `RedirectBoundary` as intended. (The only difference between the
   two call sites is `tax-entity-widget.tsx` has a trailing `router.refresh()` after the
   `await`, which is dead code on the successful path since `ensureTaxWorkspace` always ends
   in `redirect()` — the new form correctly omits that line rather than pretending it's
   reachable.)
   - **No validation coverage was lost.** `isValidPriorYear` and the entity-selected (`!entityId`)
     checks run synchronously inside `submit()`, before the `FormData` is even constructed and
     well before `startTransition` is invoked (lines ~26–38) — both checks `return` early with
     `setError(...)` on failure, exactly as before the fix. The removed `try/catch` only ever
     wrapped the action call itself, never the validation.
   - Confirmed via `pnpm typecheck` (clean) that the removal didn't break any type contract.

2. **Multi-file upload creates one `Document` row per file...** **PASS, unchanged.**
   `actions/tax-planning.ts`'s `uploadTaxDocuments` mtime (2026-09-13 18:32:40) predates my
   prior FAIL report (18:49:08) and the fix commit (18:50–18:51) — untouched since my last
   pass. Original hand-verification stands.

3. **Partial-failure batch reports failures, never silently drops one.** **PASS, unchanged.**
   `lib/tax-doc-batch.ts` (mtime 18:30:34) and its test file untouched since last pass; original
   verification stands. Re-ran the test file this round — `lib/__tests__/tax-doc-batch.test.ts`
   (7 tests) still passes.

4. **Business workspace gets the same upload capability.** **PASS, unchanged.**
   `components/tax/tax-workspace-client.tsx` (mtime 18:36:39), `tax-document-upload.tsx`
   (18:33:10), and `app/tax/[workspaceId]/page.tsx` (18:37:16) all predate the fix window —
   untouched. Original verification stands.

5. **"Other years" section, correctly scoped, working View link.** **PASS, unchanged.**
   `other-year-documents.tsx` (18:33:36) and both page files untouched since last pass.
   Original verification stands.

6. **No Prisma schema/migration changes.** **PASS.** `git status --porcelain` shows no
   `prisma/schema.prisma` change and no new tax-document migration directory (the one new
   migration present, `20260908120000_bank_statements`, is an untracked sibling-task artifact,
   not this task's).

7. **`pnpm typecheck`, `pnpm lint`, `pnpm test` all pass clean.** **PASS**, independently
   re-run this round (not trusted from the Coder's report) — see Tests Run below.

## Tests run

```
$ pnpm typecheck
> tsc --noEmit
(clean, exit 0, no output)
```

```
$ pnpm lint
✖ 43 problems (0 errors, 43 warnings)
```
Full warning list re-inspected: all 43 warnings are in files this task never touched
(`components/insurance/insurance-policy-card.tsx`, `components/retirement/retirement-balance-form.tsx`,
`components/settings/entities-client.tsx`, `components/tag-rules/retroactive-rule-modal.tsx`,
`components/vault/vault-client.tsx`, `components/vault/vault-verify-client.tsx`,
`lib/__tests__/doc-extract.test.ts`, `lib/__tests__/forecast.test.ts`, `lib/encrypt.ts`,
`lib/plaid-sync.ts`, `prisma/seed.ts`). Identical baseline to the prior pass. Zero warnings in
`add-prior-year-form.tsx` or any other file touched by this task.

```
$ pnpm test
 Test Files  35 passed (35)
      Tests  395 passed (395)
```
Exact match to the prior pass's count and to the Coder's reported count — `lib/__tests__/tax-year-range.test.ts` (7 tests) and `lib/__tests__/tax-doc-batch.test.ts` (7 tests) both present and passing. Zero regressions.

## Scope check

File mtimes confirm exactly one source file changed since the prior FAIL report
(18:49:08) and before this pass began:

| File | mtime |
|---|---|
| `components/tax/add-prior-year-form.tsx` | 2026-09-13 18:50:24 (fix applied) |
| `.claude/pipeline/prior-year-tax-documents/02-implementation.md` | 2026-09-13 18:51:15 (Coder's write-up of the fix) |

All other files in this task's scope (`lib/tax-year-range.ts`, `lib/tax-doc-batch.ts`,
`actions/tax-planning.ts`, `components/tax/tax-document-upload.tsx`,
`components/tax/other-year-documents.tsx`, `components/tax/personal-tax-client.tsx`,
`components/tax/tax-workspace-client.tsx`, all three `app/tax/**/page.tsx` files) have mtimes
predating 18:49:08 — confirmed untouched by the fix, exactly as expected for a targeted defect
fix.

`git status --porcelain` output is otherwise identical in shape to the prior pass's snapshot —
the same sibling-task files (`actions/bank-statements.ts`, `app/business/**`,
`components/app-sidebar.tsx`, `lib/bank-statement-extract.ts`, `lib/period-balance-sheet.ts`,
`pnpm-workspace.yaml`, `prisma/migrations/20260908120000_bank_statements/`, etc.) remain
present as pre-existing sibling-task state, not scope creep introduced by this fix. No new
files, no unexpected modifications.

## Tests added

None this round. The defect fixed was a client-component control-flow bug
(`try/catch` swallowing a redirect); this repo has no precedent for testing client components
or Server Actions with Vitest (confirmed again this pass — no test scaffolding exists for
`"use client"` components anywhere in `lib/__tests__/`), consistent with the plan's own test
expectations. The underlying pure logic (`isValidPriorYear`, `summarizeUploadBatch`) was
already thoroughly covered and unchanged since the prior pass; no new gaps identified.

## Defects found

None this round. The one defect from the prior pass is resolved — see acceptance criterion #1
above for the fix verification.

## Not tested

- **Manual/visual browser verification** — still not performed (no running dev server + live
  Supabase credentials in this environment), same gap as the prior pass and as the plan's own
  "Manual/visual verification required" section flags. The fix was verified by direct source
  comparison against a known-working precedent (`tax-entity-widget.tsx`) rather than by
  observing the navigation in a browser. Given the fix reduces the new code to a structurally
  identical pattern to code already working in production elsewhere in this app, this is a low
  residual risk, but it is explicitly unconfirmed by an actual click-through.
- **`pnpm build`** — not run, same rationale as prior pass (not part of stated acceptance
  criteria; touches a live DB during static generation).
- Everything else listed as "Not tested" in the prior pass (extraction paths,
  `actions/documents.ts#getDocumentSignedUrl`'s pre-existing bug) remains equally untested and
  equally out of scope — unchanged since last pass.
