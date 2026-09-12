# Implementation: GL-code auto-assignment from tag→GL-code mapping

## Summary of changes

**Schema / migration**
- `prisma/schema.prisma` — added `TagGlCodeMapping` model (`id`, `entityId`,
  `tagId`, `glCodeId`, timestamps, `@@unique([entityId, tagId])`), with back-relations
  `Entity.tagGlCodeMappings`, `Tag.glCodeMappings`, `GlCode.tagMappings`. Added a
  schema comment above the model documenting that entity-scoping of `glCodeId`
  is enforced only in application code (Prisma can't express a composite FK
  against `GlCode`'s own `@@unique([entityId, code])`).
- `prisma/migrations/20260912000000_tag_gl_code_mapping/migration.sql` — new,
  hand-written, matching the style of the existing `20260908120000_bank_statements`
  migration (`CREATE TABLE`, unique index, then three `ALTER TABLE ... ADD CONSTRAINT` FKs).
- Ran `pnpm db:generate` (`prisma generate`) to regenerate the local TypeScript
  client so `db.tagGlCodeMapping` type-checks. **Did not** run `prisma migrate dev`,
  `prisma migrate deploy`, or `prisma db push` — per the plan's explicit
  constraint, applying this migration to any real database is a separate,
  later step outside this pipeline.

**`computePL` bug fix + its two follow-ons**
- `lib/reports.ts` — `computePL`'s `gl.type === "income"` check changed to
  `gl.type === "revenue"` (the only such check in the function).
- `prisma/seed.ts` — the two hardcoded GL-code-4000 seeds (Sudden Valley
  "Rental Revenue", EK Consulting "Consulting Revenue") changed from
  `type: "income"` to `type: "revenue"`, so a future `pnpm db:seed` re-run
  won't silently flip these back and reintroduce the mismatch against
  production's real chart-of-accounts data.
- `lib/__tests__/reports.test.ts` — the two mock GL-code fixtures using
  `type: "income"` updated to `type: "revenue"` so they exercise the corrected
  enum value; all `computePL` tests still pass.
- See "Deviations from the plan" below — I did *not* silently apply this fix;
  I re-derived it from a memory of a directly conflicting prior-task
  conclusion and am flagging the resolution explicitly.

**New pure resolver**
- `lib/gl-code-resolver.ts` — new. `resolveGlCodeForTags(tagIds, mappingsForEntity)`
  is a pure function implementing the conflict rule exactly as specified
  (dedup via `Set`, zero distinct → `no_mapping`, one → `resolved`, more than
  one → `conflict` with all distinct ids). `autoAssignGlCodes(entries, userId?)`
  is the DB-touching batch wrapper: batch-fetches mappings per involved
  entity, batch-fetches each transaction's current `glCodeId` and skips any
  transaction that already has one (never clobbers manual or prior
  auto-assignments), resolves each entry, and commits all updates (plus audit
  rows when `userId` is given) in one `db.$transaction([...])` array.
- `lib/__tests__/gl-code-resolver.test.ts` — new, 7 tests covering every case
  in the plan's test-expectations list (no mapping, empty tags, single match,
  same-code dedup, real conflict, mixed mapped+unmapped, duplicate tag ids).
  Pure-function tests only; `autoAssignGlCodes` itself is untested, consistent
  with this repo's existing precedent for DB-touching wrapper functions.

**Mapping-management action**
- `actions/gl-code-mappings.ts` — new, `"use server"`, `requireAuth()` first
  line on every export. `listTagMappingsForEntity` (tags-in-use via
  `transactionTag.groupBy` on non-archived transactions in the entity, each
  annotated with its current mapping if any, ordered by usage desc then name;
  plus a lightweight "unused" list of all other global tags for the
  "map another tag" affordance). `upsertTagGlMapping` (validates
  `glCode.entityId === entityId` before writing — the load-bearing check
  called out in the plan's Risk 5 — and upserts on `[entityId, tagId]`).
  `unsetTagGlMapping` (deletes the row; no mapping = row absence, not null).
  `previewGlCodeBackfill` (finds tagged/uncoded/non-transfer/non-archived
  transactions for the entity, runs `resolveGlCodeForTags` per transaction,
  buckets into `wouldAssign` with resolved GL code label, `noMappingCount`,
  and `conflicts` with tag names). `applyGlCodeBackfill` (re-resolves
  server-side from each transaction's current tags — never trusts a
  client-supplied GL code — then calls `autoAssignGlCodes(entries, user.id)`
  for a full audited apply).
- `actions/gl-codes.ts` — `deleteGlCode` extended with a
  `db.tagGlCodeMapping.count({ where: { glCodeId: id } })` check, blocking
  deletion with a clear error, mirroring the existing transaction-in-use check.

**Call-site wiring (all 7, going-forward automation)**
1. `actions/import.ts` `confirmImport` — captures `userId` from the auth
   check (previously discarded), calls `autoAssignGlCodes` after the batch
   tag `createMany`, one entry per tagged transaction.
2. `actions/tag-rules.ts` `applyRetroactiveTag` — calls `autoAssignGlCodes`
   per transaction after its tag create, using `tx.entityId` already on hand
   from the existing fetch. `applyRulesToTransaction` was left untouched, as
   planned — it delegates to `updateTransactionTags`, which is wired directly.
3. `actions/transactions.ts` `createTransaction` — now captures `user` from
   `requireAuth()`, calls `autoAssignGlCodes` after the tag `createMany`.
4. `actions/transactions.ts` `createTransferPair` — signature extended with a
   `userId` parameter (passed from `createTransaction`, its only caller);
   calls `autoAssignGlCodes` for both legs after their tag `createMany`.
5. `actions/transactions.ts` `updateTransactionTags` — calls
   `autoAssignGlCodes` after the tag delete+recreate transaction, using the
   already-fetched `tx.entityId` and the full final `tagIds`.
6. `lib/notifications.ts` — TD minimum-balance-fee tag site: calls
   `autoAssignGlCodes` with `userId` omitted (cron/unauthenticated context,
   matching this site's pre-existing choice to skip an audit log for its own
   tag write).
7. `lib/plaid-sync.ts` `autoTagUncategorizedTransactions` — added `entityId: true`
   to the `uncategorized` query's `select` (previously missing), then calls
   `autoAssignGlCodes` with `userId` omitted, same reasoning as #6.

**UI**
- `app/business/[slug]/gl/page.tsx` — fetches `listTagMappingsForEntity` in
  parallel with the existing queries, renders `TagGlMappingSection` as a new
  full-width section below the existing two-column grid.
- `components/business/tag-gl-mapping-section.tsx` — new, `"use client"`.
  Lists in-use tags with a GL-code `<select>` per row (same interaction
  pattern as `gl-page-client.tsx`'s coding-queue selects), a "map another
  tag" row sourced from the unused-tags list, and a "Backfill existing
  transactions" button that opens the backfill modal.
- `components/business/gl-backfill-modal.tsx` — new, `"use client"`. Mirrors
  `retroactive-rule-modal.tsx`'s step machine (simplified to
  `ask → loading → results → done`, no account/date-range steps since the
  backfill scope is the whole entity), calling `previewGlCodeBackfill` /
  `applyGlCodeBackfill`. Results table shows resolved GL code label per row
  instead of a tag badge, plus visible badges for excluded no-mapping/conflict
  counts.

## Deviations from the plan

None in design or scope. One process note worth flagging explicitly:

- **The `computePL` `"income"`→`"revenue"` fix.** My persistent memory
  contains a note from an *earlier, separate* task the same day
  (quarterly-business-forecast) concluding the opposite — that this exact
  same-looking claim was investigated and found to be a false alarm, because
  at that time `computePL` and `seed.ts` were mutually consistent (both used
  `"income"`). This task's instructions explicitly anticipated that exact
  prior finding and asserted it's superseded by a live production-database
  query (not code-reading) showing every real `GlCode` row is typed
  `revenue`/`expense`/`asset`/`liability`/`equity`, never `income` — because
  seed.ts's placeholder data was superseded by real imported GL charts and
  production is never re-seeded. I did not have production access to
  independently re-verify that live-data claim myself, but per this task's
  explicit instruction to trust it (a stronger and different kind of evidence
  than the earlier task's code-only read, and one the plan document
  independently arrived at too), I applied the fix as specified: `computePL`
  → `"revenue"`, `seed.ts`'s two 4000-code seeds → `"revenue"`, and the two
  `reports.test.ts` mocks → `"revenue"`. I've updated my persistent memory
  file to record both investigations so a future session doesn't get stuck
  re-litigating this. Flagging this here per the Coder role's instruction to
  surface anything that involved trusting an assertion I could not directly
  re-verify myself.

## Commands run and their results

- `pnpm db:generate` — succeeded (`prisma generate`, v6.19.3), regenerated
  the local client only; made no database connection.
- `pnpm typecheck` (`tsc --noEmit`) — clean, no errors.
- `pnpm lint` — 0 errors, 44 warnings, all pre-existing and unrelated to this
  task's files (verified by grepping the output for my changed/new file
  names — none appear). Baseline before this task was ~45 warnings per my
  memory notes; the count here (44) is consistent with that baseline drifting
  slightly from unrelated prior work, not from anything added in this task.
- `pnpm test` (`vitest run`, full suite) — **358/358 passed across 32 files**
  (up from the stated baseline of 351/351 across 31 files: +7 tests in the 1
  new file `lib/__tests__/gl-code-resolver.test.ts`, zero regressions
  elsewhere, including all `lib/__tests__/reports.test.ts` and
  `lib/__tests__/plaid-sync.test.ts` tests).

## Open items

- **UI verification gap (per plan Risk 7).** I cannot render or click through
  the new mapping section or backfill modal. A human needs to visually verify:
  the GL-code dropdowns populate per row, "map another tag" adds a row
  correctly, the backfill preview table renders resolved GL codes and the
  no-mapping/conflict count badges, and the apply step actually persists
  `glCodeId` and creates `gl_code_auto_assigned` audit rows.
- **No audit trail for the 2 cron/unauthenticated call sites** (TD
  minimum-balance-fee tag in `lib/notifications.ts`, Plaid auto-tag in
  `lib/plaid-sync.ts`) — by design, per the plan's Risk 3. Assignment still
  happens; only the `AuditLog` row is skipped, matching those sites'
  pre-existing behavior for their own tag writes. Flagging again here since
  it's tax-relevant data, per the plan's own callout.
- **Migration not applied to any database.** `prisma/migrations/20260912000000_tag_gl_code_mapping/migration.sql`
  exists and `pnpm db:generate` succeeded locally, but the migration has not
  been run against local/staging/production — that's an explicit separate
  step outside this pipeline per the task's constraints.
- **Mapping-change propagation is intentionally not built** (plan's explicit
  out-of-scope item / Risk 4): if the owner changes a tag→GL mapping later,
  already-coded transactions keep their old code; only still-uncoded or
  newly-tagged transactions pick up the new mapping. Flagging again since
  it's a real behavioral trade-off the owner should be aware of, not a bug.
