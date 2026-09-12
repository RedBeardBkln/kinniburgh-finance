# Plan: GL-code auto-assignment from tag→GL-code mapping

## Restated goal

Let the owner configure, per business entity, which GL code each Tag maps to, then
use that mapping to auto-assign `Transaction.glCodeId` — both retroactively (a
preview-then-apply backfill over already-tagged transactions) and going forward
(automatically, whenever a transaction's tags are written). Also fix the
independently-discovered `computePL` type-string bug so GL-coded transactions
actually appear as revenue once assignment starts working, since income
GL-coded activity is currently invisible even where GL codes exist.

## Scope

**In scope:**
- New `TagGlCodeMapping` Prisma model (`(entityId, tagId)` → `glCodeId`) + migration file.
- A pure, unit-tested resolver (`lib/gl-code-resolver.ts`) implementing the
  owner's conflict rule (exactly one distinct resolved GL code → auto-assign;
  zero or >1 distinct → leave uncoded for manual review).
- Wiring that resolver into all 7 existing `TransactionTag`-creation call sites
  so new/re-tagged transactions get auto-coded going forward.
- A mapping-management UI section on the existing GL page
  (`app/business/[slug]/gl/page.tsx` / `components/business/gl-page-client.tsx`)
  showing the entity's in-use tags, their current mapping (if any), and a way
  to set/change/unset each one.
- A preview → apply backfill flow (new modal, same UX shape as
  `components/tag-rules/retroactive-rule-modal.tsx`) that resolves GL codes for
  all existing tagged-but-uncoded business transactions in an entity and lets
  the owner review before committing.
- The one-line `computePL` fix (`"income"` → `"revenue"`, both checks), plus
  two follow-on fixes required to make that fix actually stick (see Risks –
  these are small, directly caused by the same root bug, not scope creep):
  - `prisma/seed.ts`'s two hardcoded `type: "income"` GL code seeds (Sudden
    Valley "Rental Revenue" 4000, EK Consulting "Consulting Revenue" 4000) —
    left uncorrected, a future `pnpm db:seed` re-run would silently flip these
    back to `"income"` via its `upsert`, undoing the fix.
  - `lib/__tests__/reports.test.ts`'s two mock fixtures currently typed
    `"income"` — must become `"revenue"` or they'll fail against the corrected
    filter.
- Extending `deleteGlCode` (`actions/gl-codes.ts`) to also block deletion when
  a `TagGlCodeMapping` still references that code (mirrors its existing
  transaction-in-use check).

**Out of scope (explicitly not building):**
- Actually applying the Prisma migration to any real database (local, staging,
  or production) — that is a separate, later, explicit step. This task only
  produces the schema.prisma diff and a hand-written migration SQL file.
- Any change to `components/business/gl-page-client.tsx`'s `GL_TYPES` dropdown
  enum. A prior task's implementation notes
  (`.claude/pipeline/quarterly-business-forecast/02-implementation.md`) flagged
  this dropdown as a possible latent bug. Having now read the current file:
  the dropdown's enum is `["revenue","expense","asset","liability","equity"]`
  — identical to `actions/gl-codes.ts`'s validation enum and already correct.
  The bug was entirely in `computePL` checking `"income"` (a value the
  dropdown never even offers), not in the dropdown. Fixing `computePL`
  resolves that prior note completely; no dropdown change is needed and none
  is included here.
- A full audit trail for GL auto-assignments triggered from unauthenticated/
  cron contexts (Plaid sync auto-tag, the TD minimum-balance-fee tag) — see
  Risk 3 for why, and the explicit decision made instead.
- Retroactively re-running the backfill to override manually-corrected GL
  codes — manual assignments (via the existing `assignGlCode`) are never
  clobbered by this system, ever (see Risk 4 / design decision 7 below).
- Any UI for browsing/searching *all* global tags when building the mapping
  list beyond a simple "map another tag" add affordance (see design decision 5).
- Changing `lib/forecast.ts`'s unrelated `"income"` cash-flow event type
  (personal income-source forecasting) — confirmed via grep this is a
  different concept entirely; do not touch it.

## Affected files/modules

**Schema/migration:**
- `prisma/schema.prisma` — new `TagGlCodeMapping` model + back-relations on
  `Entity`, `Tag`, `GlCode`.
- `prisma/migrations/20260912000000_tag_gl_code_mapping/migration.sql` — new,
  hand-written (see Approach step 1 for why it can't be `prisma migrate dev`-generated).

**New logic:**
- `lib/gl-code-resolver.ts` — new. Pure `resolveGlCodeForTags()` + DB-touching
  `autoAssignGlCodes()` batch helper.
- `lib/__tests__/gl-code-resolver.test.ts` — new.
- `actions/gl-code-mappings.ts` — new. `listTagMappingsForEntity`,
  `upsertTagGlMapping`, `unsetTagGlMapping`, `previewGlCodeBackfill`,
  `applyGlCodeBackfill`.

**Bug fixes:**
- `lib/reports.ts` — `computePL`'s two `gl.type === "income"` checks → `"revenue"`.
- `prisma/seed.ts` — lines ~582, ~597: `type: "income"` → `type: "revenue"`.
- `lib/__tests__/reports.test.ts` — update the 2 mock fixtures using
  `type: "income"` to `type: "revenue"` (lines ~44, ~77 as currently read).
- `actions/gl-codes.ts` — `deleteGlCode` gains a mapping-in-use check.

**Call-site wiring (going-forward automation), all 7:**
- `actions/import.ts` — `confirmImport`, after the batch `transactionTag.createMany` (~line 283).
- `actions/tag-rules.ts` — `applyRetroactiveTag`, after each `transactionTag.create` (~line 419).
- `actions/transactions.ts` — three sites: `createTransaction` (~line 89),
  `createTransferPair` (~line 154), `updateTransactionTags` (~line 192).
- `lib/notifications.ts` — the TD minimum-balance-fee tag assignment (~line 332).
- `lib/plaid-sync.ts` — `autoTagUncategorizedTransactions` (~line 397); its
  `uncategorized` query select list must gain `entityId`.

**UI:**
- `app/business/[slug]/gl/page.tsx` — fetch tag-mapping data, pass to a new section.
- `components/business/gl-page-client.tsx` or a new sibling component
  (decision below: new component) — render the mapping section.
- `components/business/tag-gl-mapping-section.tsx` — new. Lists in-use tags +
  mapping dropdowns + "map another tag" affordance + "Backfill" trigger button.
- `components/business/gl-backfill-modal.tsx` — new. Preview → apply flow,
  modeled directly on `components/tag-rules/retroactive-rule-modal.tsx`.

## Approach

### Step 1 — Schema + migration (do this first, nothing else depends-free of it)

Add to `prisma/schema.prisma`:

```prisma
model TagGlCodeMapping {
  id        String   @id @default(uuid())
  entityId  String
  tagId     String
  glCodeId  String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  entity Entity @relation(fields: [entityId], references: [id])
  tag    Tag    @relation(fields: [tagId], references: [id])
  glCode GlCode @relation(fields: [glCodeId], references: [id])

  @@unique([entityId, tagId])
}
```

Add back-relation lines: `Entity.tagGlCodeMappings TagGlCodeMapping[]`,
`Tag.glCodeMappings TagGlCodeMapping[]`, `GlCode.tagMappings TagGlCodeMapping[]`.

There is no application-level constraint that `glCodeId`'s entity matches
`entityId` (Prisma can't express a composite FK against `GlCode`'s
`@@unique([entityId, code])`) — this must be enforced in `upsertTagGlMapping`
by fetching the `GlCode` and checking `glCode.entityId === entityId` before
writing, and rejecting otherwise. State this in code as a comment so it isn't
silently dropped later.

Write the migration by hand at
`prisma/migrations/20260912000000_tag_gl_code_mapping/migration.sql`, in the
same style as `prisma/migrations/20260908120000_bank_statements/migration.sql`
(`CREATE TABLE`, unique index, then `ALTER TABLE ... ADD CONSTRAINT` for each FK).

**Do not run `prisma migrate dev`, `prisma migrate deploy`, or `prisma db push`.**
This repo's `DATABASE_URL`/`DIRECT_URL` point at the real Supabase instance —
there is no separate local/shadow database to safely diff against, so any of
those commands would touch the real database. Write the schema + migration
files by hand only. Run `pnpm db:generate` (`prisma generate`) once the schema
edit is in — this only reads `schema.prisma` and regenerates the TypeScript
client locally; it makes no database connection and is required before
`pnpm typecheck` / `pnpm test` will pass (they need the new
`db.tagGlCodeMapping` client methods to type-check). Applying the migration to
any real database is an explicit, separate step for later, outside this
pipeline.

### Step 2 — Pure resolver + unit tests

`lib/gl-code-resolver.ts`:

```ts
export type GlResolution =
  | { status: "resolved"; glCodeId: string }
  | { status: "no_mapping" }
  | { status: "conflict"; glCodeIds: string[] };

export function resolveGlCodeForTags(
  tagIds: string[],
  mappingsForEntity: Map<string, string>, // tagId -> glCodeId, one entity's mappings only
): GlResolution
```

Logic: collect the distinct `glCodeId`s reachable from `tagIds` via
`mappingsForEntity` (tags with no mapping are simply ignored, not an error).
Zero distinct → `no_mapping`. Exactly one → `resolved`. More than one →
`conflict` (owner's explicit rule: never guess, leave for the existing manual
"Coding Queue" review surface).

Then the DB-touching batch wrapper, in the same file (per this repo's
established "pure-decision-module" pattern — the DB wrapper is not itself
unit-tested, only the pure function is):

```ts
export interface GlAssignmentEntry {
  transactionId: string;
  entityId: string;
  tagIds: string[]; // the transaction's FULL/final tag set after this write
}

export async function autoAssignGlCodes(
  entries: GlAssignmentEntry[],
  userId?: string, // omit for cron/unauthenticated contexts — see Risk 3
): Promise<{ assigned: number }>
```

Implementation: batch-fetch `TagGlCodeMapping` rows for the involved
`entityId`s, group into `Map<entityId, Map<tagId, glCodeId>>`; batch-fetch
current `glCodeId` for the involved transactions and **skip any transaction
that already has a non-null `glCodeId`** (never clobber a manual or prior
auto-assignment — decision 7 below); call `resolveGlCodeForTags` per entry;
for every `resolved` entry, build a `transaction.update` plus (only if
`userId` given) an `auditLog.create` with `changeType: "gl_code_auto_assigned"`,
and commit the whole batch in one `db.$transaction([...])` array (mirrors
`createTransferPair`'s existing use of `db.$transaction([...])`).

**Critical precondition for every call site:** by the time a call site invokes
`autoAssignGlCodes`, `tagIds` in each entry must be the transaction's complete,
final tag set — not just newly-added tags. Verified true for all 7 sites read
in this plan: every one either creates a brand-new transaction (no prior tags
possible) or does delete-then-recreate of the full tag set (`updateTransactionTags`,
`applyRetroactiveTag`). There is no "add one tag without touching others" path
anywhere in this codebase today. If a future change introduces one, it must
pass the transaction's complete current tag set to the resolver, not a delta.

Unit tests (`lib/__tests__/gl-code-resolver.test.ts`), pure-function only, no
DB, following this repo's `describe`/`it`/`expect` style:
- No tags in the mapping map for any of the transaction's tags → `no_mapping`.
- Empty `tagIds` array → `no_mapping`.
- One tag, mapped → `resolved` with that code.
- Two tags mapping to the *same* code → `resolved` (dedup, not a false conflict).
- Two tags mapping to *different* codes → `conflict` with both ids listed.
- One mapped + one unmapped tag → `resolved` with the mapped one (unmapped tag
  is silently ignored, does not force a conflict or block resolution).
- Duplicate tag ids in the input array → still resolves correctly (Set-based dedup).

### Step 3 — `computePL` fix + its two follow-on fixes

1. `lib/reports.ts`: change both `gl.type === "income"` checks to `"revenue"`.
2. `prisma/seed.ts`: change the two `type: "income"` GL code seed entries
   (Sudden Valley code 4000, EK Consulting code 4000) to `type: "revenue"`.
   These are chart-of-accounts type labels, not financial source data — this
   is a typo-level fix, not "cleaning up" the owner's real numbers, so it does
   not need separate sign-off per the ground rules' seed-data caution.
3. `lib/__tests__/reports.test.ts`: update the 2 mock GL code fixtures
   currently `type: "income"` to `type: "revenue"` so they exercise the
   corrected/real enum. No other test file references GL code `"income"`
   type strings (confirmed via repo-wide grep) — `lib/forecast.ts`'s
   `"income"` cash-flow-event type and `lib/tax-guidance.ts`'s `"income"`
   category string are unrelated concepts; do not touch them.

### Step 4 — Mapping-management action + UI

`actions/gl-code-mappings.ts` (new, `"use server"`, `requireAuth()` first line
on every export):

- `listTagMappingsForEntity(entityId)` — returns the entity's tags-in-use
  (tags with at least one `TransactionTag` on a non-archived `Transaction` in
  this entity, via `db.tag.findMany({ where: { transactions: { some: {
  transaction: { entityId, archivedAt: null } } } } })`), each annotated with
  its current mapping's `glCodeId` if one exists, ordered by usage count
  descending then name. Decision (design question 5): the mapping UI's
  *primary* list is tags-in-use, not all ~100+ global tags — most of which
  are personal categories irrelevant to a given business entity. Also return
  a lightweight full list of `{id, name}` for every global tag *not* already
  in the in-use list, so the UI can offer a "map another tag" affordance for
  tags the owner wants to pre-configure before any transaction uses them yet
  (e.g. anticipating a new recurring vendor). A tag with no mapping yet is
  simply shown with a blank/"— unmapped —" selector — there is no forced
  "must map everything" gate; the owner fills these in incrementally.
- `upsertTagGlMapping(entityId, tagId, glCodeId)` — validates `glCode.entityId
  === entityId` (see Step 1), upserts on `[entityId, tagId]`.
- `unsetTagGlMapping(entityId, tagId)` — deletes the row (glCodeId is
  non-nullable on the mapping, so "no mapping" = row absence, not `null`).
- `previewGlCodeBackfill(entityId)` — finds this entity's tagged
  (`tags: { some: {} }`), un-coded (`glCodeId: null`), non-archived,
  non-transfer (`transferPairId: null`) transactions; for each, loads its
  tags and runs `resolveGlCodeForTags` against the entity's current mapping;
  buckets into `wouldAssign` (resolved — include enough detail per row to
  mirror `RetroactiveMatch`'s shape: id, postedAt, payeeRaw, amount, tag
  names, resolved GL code label), `noMapping` (count only), `conflict`
  (count only, tag names shown so the owner knows what to go configure).
- `applyGlCodeBackfill(transactionIds)` — **re-resolves server-side**, never
  trusts a client-supplied GL code; builds `GlAssignmentEntry[]` and calls
  `autoAssignGlCodes(entries, user.id)` (a real session exists here, so this
  path *does* get a full `gl_code_auto_assigned` audit trail per transaction).

Extend `actions/gl-codes.ts`'s `deleteGlCode`: also
`db.tagGlCodeMapping.count({ where: { glCodeId: id } })` and block with a
clear error if any mapping still references it (mirrors the existing
transaction-in-use check immediately above it).

UI: add `components/business/tag-gl-mapping-section.tsx` (new,
`"use client"`), rendered as a new full-width section in
`app/business/[slug]/gl/page.tsx` below the existing two-column grid (decision
for design question 6: new section on the existing GL page, not a separate
page — it's already the natural, discoverable home for GL configuration, and
splitting it out would just fragment one workflow across two URLs). It shows
the tag list with a GL-code `<select>` per row (same interaction pattern as
`gl-page-client.tsx`'s existing coding-queue `<select>`), a "map another tag"
row using the unused-tags list, and a "Backfill existing transactions" button
that opens `components/business/gl-backfill-modal.tsx`.

`gl-backfill-modal.tsx` mirrors `retroactive-rule-modal.tsx`'s step machine
(`ask → loading → results → done`) but calls `previewGlCodeBackfill`/
`applyGlCodeBackfill` instead, and its results table shows the resolved GL
code per row instead of a tag badge, plus a visible count of
no-mapping/conflict transactions that were excluded from the preview (so the
owner knows backfill coverage is partial and why).

### Step 5 — Wire the resolver into all 7 call sites (going-forward automation)

For each site, after the tag write succeeds, build `GlAssignmentEntry[]` and
call `autoAssignGlCodes(entries, userId)` (or `undefined` where noted):

1. **`actions/import.ts` `confirmImport`** (~line 283): after
   `db.transactionTag.createMany({ data: tagData, ... })`, build entries from
   `tagData` (`{ transactionId, entityId: parsed.entityId, tagIds: [tagId] }`
   — one tag each here). Real session exists (top of function) → pass `user.id`.
2. **`actions/tag-rules.ts` `applyRetroactiveTag`** (~line 419): after the
   per-transaction `transactionTag.create`, call with a single-entry array
   `{ transactionId: txId, entityId: tx.entityId, tagIds: [tagId] }` (need
   `tx.entityId` — the existing `findUnique` already fetches `tx`, just read
   `entityId` off it, no extra query). Pass `user.id`.
   `applyRulesToTransaction` (same file) delegates to
   `updateTransactionTags` (in `actions/transactions.ts`) — **do not wire it
   separately**; it will already be covered once `updateTransactionTags` is wired.
3. **`actions/transactions.ts` `createTransaction`** (~line 89): after the
   `transactionTag.createMany`, one entry
   `{ transactionId: tx.id, entityId: parsed.entityId, tagIds }`. Pass `user.id`.
4. **`actions/transactions.ts` `createTransferPair`** (~line 154): after the
   `transactionTag.createMany` for the Transfer Out/In tags, build entries
   for both legs. Note: `computePL` already excludes `transferPairId != null`
   transactions from GL aggregation, so this wiring is a no-op for P&L
   correctness either way — include it anyway for consistency/completeness
   (harmless, and future GL-code features may not always filter transfers the
   same way). Pass the caller's `user.id` (available via `requireAuth()` at
   the top of `createTransaction`, which is `createTransferPair`'s only caller).
5. **`actions/transactions.ts` `updateTransactionTags`** (~line 192): after
   the `$transaction([...deleteMany, createMany])` completes, one entry
   `{ transactionId, entityId: tx.entityId, tagIds }` (the function's existing
   `tx` fetch already has `entityId`). Pass `user.id`. This covers direct
   tag-editor UI usage *and* `applyRulesToTransaction`'s indirect calls.
6. **`lib/notifications.ts`** (~line 332, TD fee-tag): after
   `db.transactionTag.create(...)`, one entry
   `{ transactionId: tx.id, entityId: entity.id, tagIds: [feeTag.id] }`. No
   user session in this cron path → call `autoAssignGlCodes(entries)` with
   `userId` omitted (see Risk 3 — the assignment still happens, only its audit
   row is skipped, matching this exact call site's own pre-existing choice to
   skip an audit log for its `transactionTag.create` today).
7. **`lib/plaid-sync.ts`** (~line 397, `autoTagUncategorizedTransactions`):
   first add `entityId: true` to the `uncategorized` query's `select` (it's
   currently missing — required for the resolver). After
   `db.transactionTag.createMany({ data: assignments, ... })`, build entries
   from `assignments` joined back to each transaction's `entityId` from the
   `uncategorized` list. No user session → omit `userId`, same as #6.

## Risks/unknowns

1. **Single Coder pass, with an explicit internal checkpoint if it runs long.**
   This is a large task (schema/migration + resolver + tests + 7 call-site
   edits + 2 new UI flows + 2 small bug fixes), but every design ambiguity the
   task flagged has been resolved concretely above — nothing is left for the
   Coder to guess at, which is normally the main reason to split a task across
   pipeline passes. Recommendation: **one Coder pass**, ordered Step 1 → 5 as
   written, because steps 1–4 alone (schema, resolver, `computePL` fix, and
   the mapping+backfill UI) already unblock the P&L for all *existing*
   historical data — the owner can configure mappings and run the backfill
   even before going-forward wiring lands. If the Coder genuinely runs out of
   budget, Step 5 (call-site wiring) is the safest and most mechanical piece
   to defer to a fast-follow task, since it's pure repetition of the same
   pattern seven times with no remaining design decisions. Steps 1–4 must not
   be split, since the UI/backfill straightforwardly depend on the schema and
   resolver existing first.
2. **`computePL`'s bug is confirmed real, live, and independently verified in
   this planning pass** (not just trusted from the task prompt): I read the
   current `lib/reports.ts` (checks `"income"`) and `actions/gl-codes.ts` /
   `components/business/gl-page-client.tsx` (both enums are
   `revenue/expense/asset/liability/equity`, no `"income"` value reachable
   through either UI or the create/update/import actions) directly. The only
   place `"income"` GL-code-typed data can currently originate is
   `prisma/seed.ts`'s hardcoded seed (see Scope) — which is why that file
   also needs the fix, not just `computePL`.
3. **No audit trail for GL auto-assignments from unauthenticated/cron call
   sites (Plaid sync auto-tag, TD fee-tag).** `AuditLog.changedBy` is a hard
   non-nullable FK to `User` — there is no "system user" concept anywhere in
   this codebase (confirmed via grep across all existing `auditLog.create`
   call sites; every one uses a real `requireAuth()`-derived `user.id`), and
   both of those two specific call sites *already* skip `AuditLog` entirely
   today for their own `TransactionTag` writes (this is pre-existing behavior,
   not something this task introduces). Rather than invent a new system-user
   concept (its own migration/seed decision, out of proportion to this task),
   this plan makes `autoAssignGlCodes`'s `userId` parameter optional: those 2
   of 7 call sites get GL auto-assignment with no audit row; the other 5 (all
   real user-initiated actions, plus the backfill) get a full
   `gl_code_auto_assigned` audit entry. **Flagging this explicitly because
   it's tax-relevant data and the owner may want full audit coverage** — if
   so, that requires a separate follow-up task to introduce a real system-user
   convention repo-wide, not a one-off hack here.
4. **Manual GL assignments are never overwritten, ever, by design (owner's
   design question 7).** `autoAssignGlCodes` only ever acts on transactions
   where `glCodeId` is currently `null` — this applies uniformly to both the
   going-forward hooks and the backfill. A transaction manually corrected via
   the existing `assignGlCode` (or previously auto-assigned) will never be
   touched again by a later backfill re-run or re-tagging event. This means
   if the owner later *changes* a tag→GL mapping, already-coded transactions
   from before the change keep their old code — only newly-tagged or
   still-uncoded transactions pick up the new mapping. This is the safer
   default for tax data; flagging in case the owner actually wants
   mapping-change propagation to prior transactions (that would need a
   different, more invasive backfill mode, out of scope here).
5. **`GlCode`'s entity-scoping is enforced only in application code, not the
   database schema**, for the reason given in Step 1 (Prisma can't express a
   composite FK against `GlCode`'s `(entityId, code)` unique key from this
   mapping table). `upsertTagGlMapping`'s entity-match check is load-bearing —
   if the Coder skips it, it becomes possible to map a Sudden Valley tag to an
   EK Consulting GL code with no error, corrupting P&L data silently.
6. **Personal-entity transactions pass through the same `autoAssignGlCodes`
   call harmlessly.** `autoTagUncategorizedTransactions` in particular scans
   *all* entities, not just business ones. This is fine by construction: if
   no `TagGlCodeMapping` row exists for the Personal entity (expected — GL
   codes are a business/tax bookkeeping concept, `Entity.type === "personal"`
   has no chart of accounts), `resolveGlCodeForTags` returns `no_mapping` and
   nothing happens. No entity-type filtering is needed anywhere in the
   resolver or its call sites.
7. **UI verification gap.** This task touches two new/changed UI surfaces
   (the mapping section and the backfill modal) that no pipeline agent can
   render or click through. A human must visually verify both — that the
   dropdowns populate correctly, the backfill preview table renders resolved
   GL codes as expected, and the apply step actually persists — before this
   is considered done. `pnpm typecheck`/`lint`/`test` passing is necessary
   but not sufficient here.

## Acceptance criteria

- [ ] `prisma/schema.prisma` has the new `TagGlCodeMapping` model with a
      `@@unique([entityId, tagId])` constraint and relations to `Entity`,
      `Tag`, `GlCode`; a hand-written migration file exists at
      `prisma/migrations/20260912000000_tag_gl_code_mapping/migration.sql`
      matching the existing migrations' SQL style; `pnpm db:generate` succeeds.
- [ ] `lib/reports.ts`'s `computePL` checks `gl.type === "revenue"` (not
      `"income"`) in both places; `prisma/seed.ts`'s two GL-code type-4000
      seeds are `"revenue"`; `lib/__tests__/reports.test.ts`'s mocks match.
- [ ] `lib/gl-code-resolver.ts` exports a pure `resolveGlCodeForTags()` that:
  returns `no_mapping` when none of a transaction's tags have a mapping for
  its entity; returns `resolved` with the single GL code when exactly one
  distinct GL code is reachable; returns `conflict` (never auto-assigns) when
  tags resolve to more than one distinct GL code.
- [ ] `autoAssignGlCodes()` never overwrites a transaction that already has a
      non-null `glCodeId`, regardless of caller.
- [ ] A tag→GL-code mapping can be created/changed/removed per entity through
      the new UI section on `app/business/[slug]/gl/page.tsx`, scoped so the
      same tag can map to different GL codes on different entities.
- [ ] Attempting to map a tag to a GL code that belongs to a *different*
      entity is rejected with a clear error, not silently accepted.
- [ ] Once mappings exist, running the backfill preview shows exactly which
      currently-uncoded, already-tagged transactions would be assigned which
      GL code (and separately surfaces counts of no-mapping and conflicting
      transactions that are excluded), and applying it assigns GL codes only
      to the transactions the owner confirmed, each with a
      `gl_code_auto_assigned` `AuditLog` row.
- [ ] After the backfill (or after this task's going-forward wiring), an
      entity's `computePL(entityId, from, to)` for a range with GL-coded
      activity returns non-empty `incomeLines`/`expenseLines` — no longer
      always empty for entities with real bookkeeping activity.
- [ ] All 7 identified `TransactionTag`-creation call sites invoke the shared
      resolver after writing tags, per the per-site mapping in Approach Step 5.
- [ ] `deleteGlCode` refuses to delete a GL code that still has a tag mapping
      pointing to it, with a message as clear as its existing
      transaction-in-use check.
- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass clean, with zero
      regressions against the verified 351/351-test, 31-file baseline.
- [ ] A human has visually verified the mapping-management section and the
      backfill preview/apply modal render and function correctly in the browser.

## Test expectations

- **Unit (required, `lib/__tests__/gl-code-resolver.test.ts`):** all six
  `resolveGlCodeForTags` cases listed in Step 2 (no mapping / empty tags /
  single match / same-code dedup / real conflict / mixed mapped+unmapped /
  duplicate tag ids). Pure function, no DB, mocked at the function boundary
  per this repo's established pattern — do **not** attempt to unit-test
  `autoAssignGlCodes` itself (the DB-touching wrapper); that's consistent with
  this repo's existing precedent of leaving DB-touching wrapper functions
  untested when their decision logic is already covered by a pure sibling.
- **Existing regression coverage:** `lib/__tests__/reports.test.ts`'s
  `computePL` tests must still pass after the fixture updates — this is the
  test suite that proves the `"income"`→`"revenue"` fix didn't break income/
  expense/asset-exclusion behavior.
- **No new integration/DB tests** — this repo has no DB-integration test
  layer (confirmed convention); the 7 call-site wirings and the two new
  server actions (`gl-code-mappings.ts`) are not unit-tested directly, same as
  every other `actions/*.ts` mutation in this codebase today. Their
  correctness is covered by (a) the pure resolver's unit tests plus (b) the
  human UI verification pass called out above and in acceptance criteria.
- **Edge cases the resolver tests must not skip:** a transaction with *no*
  tags at all (empty array) must resolve to `no_mapping`, not throw or crash;
  a mapping map with entries for tags *not* present on the transaction must
  be ignored, not accidentally matched.
