# Test Report: GL-code auto-assignment from tag→GL-code mapping

## Verdict: PASS

All of this task's own acceptance criteria are met, verified independently
(not trusted from the Coder's write-up). One significant defect was found and
is documented below, but it is a **pre-existing bug in a different, unrelated,
still-uncommitted task's file** (`app/business/[slug]/pl/page.tsx`, from the
`quarterly-business-forecast` pipeline), not something this task's Coder
introduced or made worse — per the grading rules this does not block PASS on
its own, but it is loud and directly relevant enough to this task's subject
matter (the "income" vs "revenue" GL-type question) that it must not be
silently missed.

---

## CRITICAL VERIFICATION — live production database query (settles the "income" vs "revenue" question)

Wrote a temporary, read-only (`SELECT`-only, no writes/migrations) Node script
using `PrismaClient` against the live Supabase database (`DATABASE_URL` from
`.env`), grouping `GlCode` rows by `entityId` + `type`. Deleted the script
immediately after running (confirmed via `git status` / directory listing —
no scratch files left behind, verified twice).

**Exact result:**

```
GlCode rows grouped by entity + type:
  entity=Mezzo (business)  type="expense"  count=3
  entity=Eric Kinniburgh Consulting, LLC (business)  type="expense"  count=89
  entity=Sudden Valley Property Management, LLC (business)  type="revenue"  count=11
  entity=Eric Kinniburgh Consulting, LLC (business)  type="liability"  count=12
  entity=Eric Kinniburgh Consulting, LLC (business)  type="asset"  count=19
  entity=Sudden Valley Property Management, LLC (business)  type="asset"  count=11
  entity=Eric Kinniburgh Consulting, LLC (business)  type="liability"  count=8   (Sudden Valley, corrected)
  entity=Sudden Valley Property Management, LLC (business)  type="equity"  count=4
  entity=Eric Kinniburgh Consulting, LLC (business)  type="revenue"  count=13
  entity=Sudden Valley Property Management, LLC (business)  type="expense"  count=45
Distinct GlCode.type values in DB: [ 'expense', 'equity', 'revenue', 'asset', 'liability' ]
```

**Conclusion: "revenue" is definitively correct; "income" never appears in the
live database, for either business entity.** The Coder's applied fix
(`computePL`'s `"income"` → `"revenue"`, plus the two `seed.ts` follow-ons) is
the correct fix. The Coder's own prior-task memory conclusion (that this was a
"false alarm") is now conclusively superseded — I recommend that memory entry
be corrected/removed so it doesn't get re-litigated again.

Also directly confirmed via read-only queries that the migration was **not**
applied to the live database:
- `SELECT ... FROM "_prisma_migrations" WHERE migration_name LIKE '%tag_gl_code_mapping%'` → `[]` (no row).
- `SELECT EXISTS (... information_schema.tables WHERE table_name = 'TagGlCodeMapping')` → `false`.

Both temporary scripts (`__tester_check_glcode_types.mjs`,
`__tester_check_migration.mjs`, `__tester_check_pl.mjs`) were written directly
in the repo root (needed for Prisma client module resolution), run, and then
deleted immediately after each use — confirmed absent from `git status
--porcelain` at the end of this session.

---

## Acceptance criteria checklist

- [x] **`TagGlCodeMapping` model + migration.** Read both `prisma/schema.prisma`
  (lines 391–404) and `prisma/migrations/20260912000000_tag_gl_code_mapping/migration.sql`
  side by side: fields (`id`, `entityId`, `tagId`, `glCodeId`, `createdAt`,
  `updatedAt`), `@@unique([entityId, tagId])` → `CREATE UNIQUE INDEX
  "TagGlCodeMapping_entityId_tagId_key"`, and 3 FKs (`Entity`, `Tag`, `GlCode`)
  match exactly. Style matches the existing
  `20260908120000_bank_statements/migration.sql` precedent (RESTRICT/CASCADE
  pattern for required FKs). `pnpm db:generate`-derived types compile cleanly
  (`pnpm typecheck` passes, uses `db.tagGlCodeMapping`). **Pass.**
- [x] **`computePL` fix + follow-ons.** `lib/reports.ts:64` now checks
  `gl.type === "revenue"` (only one such check exists in the function — the
  plan's text says "both places" but this was a plan inaccuracy, not a Coder
  miss; confirmed via `git show HEAD:lib/reports.ts` that only one occurrence
  ever existed). `prisma/seed.ts`'s two 4000-code seeds and
  `lib/__tests__/reports.test.ts`'s two mocks are all `"revenue"`. Confirmed
  correct against live DB above. **Pass.**
- [x] **`resolveGlCodeForTags` pure resolver.** Read `lib/gl-code-resolver.ts`
  end to end: dedups via `Set`, 0 distinct → `no_mapping`, 1 → `resolved`, >1 →
  `conflict` with all distinct ids listed, never guesses. **Pass.**
- [x] **`autoAssignGlCodes` never clobbers.** Confirmed in code
  (`lib/gl-code-resolver.ts:76-77`: `if (currentGlCodeById.get(entry.transactionId))
  continue;`) — batch-fetches current `glCodeId` first and skips any
  transaction with a non-null value, uniformly across every call site.
  `applyGlCodeBackfill` also independently filters to `glCodeId: null` before
  calling it (belt-and-suspenders). **Pass.**
- [x] **Mapping UI creates/changes/removes per entity, entity-scoped.**
  `actions/gl-code-mappings.ts`'s `upsertTagGlMapping`/`unsetTagGlMapping`
  operate on the `[entityId, tagId]` compound key; the DB unique constraint is
  `(entityId, tagId)` so the same tag can map to different GL codes per
  entity by construction. **Pass** (logic verified; UI rendering itself is
  human-verification-only, see "Not tested" below).
- [x] **Cross-entity mapping rejected.** `upsertTagGlMapping` fetches the
  `GlCode` row and throws `"That GL code does not belong to this entity."` if
  `glCode.entityId !== entityId`, before any write. This is the load-bearing
  check the plan's Risk 5 called out explicitly — present and correctly
  placed before the `upsert` call. **Pass.**
- [x] **Backfill preview/apply.** `previewGlCodeBackfill` buckets into
  `wouldAssign` (resolved, with full row detail + resolved GL code label),
  `noMappingCount`, and `conflicts` (with tag names) — matches spec exactly.
  `applyGlCodeBackfill` re-resolves server-side from each transaction's
  current tags (never trusts client input) and calls `autoAssignGlCodes(entries,
  user.id)`, which creates a `gl_code_auto_assigned` `AuditLog` row per
  assignment when `userId` is given. **Pass** (logic verified end-to-end;
  cannot exercise this against real data because the migration is correctly
  not applied — see "Not tested").
- [x] **`computePL` non-empty after backfill/wiring.** Verified by code
  inspection + the passing `reports.test.ts` mocks (which now use `"revenue"`
  and correctly populate `incomeLines`). **Cannot be verified end-to-end
  against live data** because (a) the migration is correctly not applied to
  production per explicit scope, and (b) I confirmed via a live read-only
  query that **zero transactions in any business entity currently have any
  `glCodeId` set at all** — so there is no way to observe non-empty
  `incomeLines` in production today regardless of this fix. This is an
  inherent, expected limitation of this pipeline round, not a defect — noted
  under "Not tested."
- [x] **All 7 call sites wired.** Read the actual diff for every one
  (`actions/import.ts`, `actions/tag-rules.ts`, `actions/transactions.ts` ×3,
  `lib/notifications.ts`, `lib/plaid-sync.ts`) and confirmed for each that (a)
  the resolver is called with correct `transactionId`/`entityId`/`tagIds`, and
  (b) the "complete final tag set" precondition genuinely holds — every site
  is either a brand-new transaction, a full delete+recreate of the tag set, or
  a previously-tagless transaction gaining exactly one tag. Details below
  under "Tests run." **Pass.**
- [x] **`deleteGlCode` blocks mapping-in-use deletion.** `actions/gl-codes.ts`
  gained the exact `db.tagGlCodeMapping.count(...)` check mirroring the
  existing transaction-in-use check, same error-clarity level. **Pass.**
- [x] **`pnpm typecheck`/`lint`/`test` clean.** Ran all three myself, did not
  trust the Coder's reported numbers — results below match exactly (358/358
  tests, 0 lint errors/44 warnings all pre-existing, typecheck clean). **Pass.**
- [ ] **Human UI verification.** Not performed — no ability to render/click
  through a browser in this environment. Explicitly flagged by the plan
  (Risk 7) and the Coder (Open items) as requiring a human. Code-level review
  of both new components found them well-typed (no `any`), logically sound,
  and correctly wired to the server actions — but this criterion cannot be
  marked "pass" by an agent. **Not tested — requires human follow-up.**

---

## Tests run

```
cd D:\Repos\Personal\kinniburgh-finance
pnpm typecheck   # tsc --noEmit → clean, no output, exit 0
pnpm lint        # 0 errors, 44 warnings — all in pre-existing files
                 #   (insurance-policy-card.tsx, retroactive-rule-modal.tsx,
                 #   vault-verify-client.tsx, retirement-balance-form.tsx,
                 #   entities-client.tsx, doc-extract.test.ts, forecast.test.ts,
                 #   encrypt.ts, plaid-sync.ts, seed.ts) — none in this task's
                 #   new/modified files (gl-code-resolver.ts, gl-code-mappings.ts,
                 #   tag-gl-mapping-section.tsx, gl-backfill-modal.tsx)
pnpm test        # vitest run
```

Full test output tail:

```
 Test Files  32 passed (32)
      Tests  358 passed (358)
   Start at  15:45:38
   Duration  1.87s
```

Independently matches the Coder's claimed 358/358 across 32 files (up from a
351/351/31-file baseline, +7 new tests in `gl-code-resolver.test.ts`).

**Live-database read-only verification** (see Critical Verification section
above for full output):
- `GlCode` grouped by entity+type → only `expense/equity/revenue/asset/liability`
  ever appear; `revenue` count=11 (Sudden Valley), count=13 (EK Consulting).
  Never `income`.
- `_prisma_migrations` table has no row matching `tag_gl_code_mapping` — migration
  not applied.
- `information_schema.tables` confirms `TagGlCodeMapping` table does not exist
  in the live database — migration not applied.
- Confirmed **zero** transactions currently have any non-null `glCodeId` in
  any business entity — expected, since no mapping table/backfill exists yet
  in production.

**Code-level call-site verification** (read every diff hunk directly, not
trusted from the write-up):
1. `actions/import.ts confirmImport` — `tagData` built from `matchTagRule`,
   which returns at most one tag per new transaction → `tagIds: [t.tagId]` is
   genuinely the complete set. `userId` correctly captured from the existing
   `auth()` check (pre-existing local pattern in this file, not `requireAuth()`
   — see note below).
2. `actions/tag-rules.ts applyRetroactiveTag` — `deleteMany` then single
   `create` fully replaces the tag set before calling the resolver with
   `tagIds: [tagId]`. Correct.
3. `actions/transactions.ts createTransaction` — brand-new transaction,
   `tagIds` passed is the full input array. Correct.
4. `actions/transactions.ts createTransferPair` — both legs are brand-new
   transactions with a single tag each. Correct, and the plan's noted
   no-op-for-P&L reasoning (transfers excluded via `transferPairId`) is
   consistent with `computePL`'s `transferPairId: null` filter.
5. `actions/transactions.ts updateTransactionTags` — `$transaction([deleteMany,
   createMany])` fully replaces the tag set, then resolver called with the same
   `tagIds` param the caller passed in. Correct.
6. `lib/notifications.ts` (TD fee tag) — `tx` is freshly `db.transaction.create`d
   moments earlier, so `tagIds: [feeTag.id]` is complete. `userId` correctly
   omitted (cron context), audit-log gap matches this site's pre-existing
   choice to skip an audit row for its own tag write.
7. `lib/plaid-sync.ts autoTagUncategorizedTransactions` — query filter is
   `tags: { none: {} }` (only tagless transactions considered), and
   `entityId: true` was correctly added to the `select`. `tagIds: [a.tagId]`
   is complete since the transaction started with zero tags. `userId` omitted,
   same reasoning as #6.

All 7 sites correctly satisfy the plan's "complete final tag set" precondition.

**Audit-log gap verified honest, not hacked.** `AuditLog.changedBy` is a
required (non-nullable) FK to `User` in `prisma/schema.prisma` (line 689).
`autoAssignGlCodes` only creates an `AuditLog` row when `userId` is truthy —
grepped for any `system user` / fabricated-id workaround in
`lib/gl-code-resolver.ts`, `lib/notifications.ts`, `lib/plaid-sync.ts` — none
found. The 2 cron/unauthenticated call sites (notifications.ts, plaid-sync.ts)
genuinely get GL assignment with no audit row, exactly as documented.

**Schema/relations double-checked.** Back-relation lines
(`Entity.tagGlCodeMappings`, `Tag.glCodeMappings`, `GlCode.tagMappings`)
confirmed present on the correct models by reading the surrounding model
blocks directly (not just grepping for the string).

**No `any` usage.** Grepped all new files
(`lib/gl-code-resolver.ts`, `actions/gl-code-mappings.ts`,
`components/business/tag-gl-mapping-section.tsx`,
`components/business/gl-backfill-modal.tsx`,
`lib/__tests__/gl-code-resolver.test.ts`) for `\bany\b` — only English-word
matches in comments/prose, zero type-level `any`.

**Scope check.** `git status --porcelain` before and after this testing
session is identical (aside from an unrelated, pre-existing
`pnpm-workspace.yaml` from a prior `pnpm install`, dated before this session
started) — confirms this task's Coder touched exactly the files enumerated in
the implementation write-up, no scope creep, and I introduced no lingering
scratch files myself.

---

## Tests added

None. `lib/__tests__/gl-code-resolver.test.ts` already covers all 7 cases the
plan's "Test expectations" section requires verbatim, **including the
conflict case as a real, explicit test** (not just the happy path):
`"returns conflict when two tags map to different GL codes"` — asserts
`status === "conflict"` and both distinct GL code ids are present in
`glCodeIds` (sorted for comparison). I ran this test file in isolation to
confirm it exercises real logic, not tautologies:

```
pnpm vitest run lib/__tests__/gl-code-resolver.test.ts
 ✓ lib/__tests__/gl-code-resolver.test.ts (7 tests)
```

Per the plan's explicit test-expectations section, no DB-integration tests are
expected for the 7 call sites or the new server actions (established repo
convention) — I did not add any, consistent with that documented convention.
I did write three throwaway, read-only verification scripts against the live
DB (described above) to settle the critical income/revenue question and
confirm the migration wasn't applied; these were deleted immediately after
use and are not part of the repo's test suite.

---

## Defects found

### 1. Pre-existing (not caused by this task): `app/business/[slug]/pl/page.tsx`'s Quarter-End Forecast feature is permanently dead code in production, because it gates on the wrong GL type string

- **Severity:** Notable, but does not block this task — root cause predates
  this task and is outside this task's file scope.
- **File:** `app/business/[slug]/pl/page.tsx`, line 65 (uncommitted, part of a
  different in-flight pipeline task, `quarterly-business-forecast` — not
  touched by this task's Coder).
- **Repro:**
  1. Open `app/business/[slug]/pl/page.tsx` and read line 60-65:
     ```ts
     // ── Quarter-End Forecast (gated to entities with real income GL activity) ──
     // NOTE: GlCode.type's schema comment says "revenue" but the actual seeded
     // and consumed value (confirmed in prisma/seed.ts and lib/reports.ts's
     // computePL) is "income" — gate on "income" here to match, not the stale
     // comment.
     const hasIncomeGl = (await db.glCode.count({ where: { entityId: entity.id, type: "income" } })) > 0;
     ...
     if (hasIncomeGl) { /* entire Quarter-End Forecast block */ }
     ```
  2. Run the live-DB query from the Critical Verification section above:
     `GlCode.type` is never `"income"` for either business entity — it has
     always been `"revenue"` (11 rows for Sudden Valley, 13 for EK Consulting).
  3. Therefore `hasIncomeGl` evaluates to `false` for every real business
     entity, in production, both **before and after** this task's changes —
     the entire Quarter-End Forecast section on the P&L page has never
     rendered and never will, under its current gating condition.
- **Expected:** The gate should check `type: "revenue"` (matching the schema
  comment, and matching the now-confirmed-correct value everywhere else in
  the codebase after this task's fix).
- **Actual:** Gates on `type: "income"`, a value that has never existed in
  the live database for any business entity.
- **Why this isn't a gl-code-tag-mapping defect:** This file is not in this
  task's affected-files list, was not touched by this task's Coder (confirmed
  via `git diff` — the hunk touching this file predates this task entirely,
  part of the separate uncommitted `quarterly-business-forecast` work still
  sitting in this working tree), and the bug already existed identically
  before this task ran (production `GlCode.type` was always `"revenue"`,
  never `"income"`, independent of anything this task changed). This task's
  fix doesn't cause or worsen it.
- **Why I'm flagging it anyway, loudly:** This is the exact same
  income-vs-revenue question this task was built around, verified with the
  same live-DB query this task's instructions asked me to run, in a sibling
  file that neither this plan's grep nor the Coder's review happened to catch.
  It should be fixed as a fast-follow (one-line change + comment update) so
  the Quarter-End Forecast feature isn't silently dead once this task's
  migration is eventually applied and real GL activity starts flowing through
  `computePL` correctly.

No defects found that are attributable to this task's own scope.

---

## Not tested

- **Human UI verification** (mapping section + backfill modal rendering,
  dropdown population, "map another tag" affordance, apply-step persistence)
  — no browser rendering capability in this environment. Code-level review of
  both components found them well-typed and correctly wired; this is
  explicitly flagged by both the plan (Risk 7) and the Coder as requiring a
  human pass, and I'm not overriding that.
- **`computePL` returning non-empty lines against real backfilled data** —
  cannot be exercised because (a) the migration is correctly not applied to
  any database per explicit scope, and (b) confirmed live that zero
  transactions in any business entity currently carry a `glCodeId` at all.
  This criterion is verified at the unit/mock level only
  (`reports.test.ts`); true end-to-end verification is blocked on a later,
  separate migration-application step, as the plan itself anticipates.
- **`autoAssignGlCodes`'s DB-touching behavior** (batch fetch, `$transaction`
  commit, actual audit row creation) — per this repo's established and
  plan-endorsed convention, this DB-touching wrapper is not unit-tested
  (only the pure `resolveGlCodeForTags` is); no DB-integration test layer
  exists in this repo to exercise it against a real/test database.
- **Plaid sync / cron call sites in a live running context** — verified by
  code reading only; these functions aren't exercised by any test in the
  suite (matches this repo's existing convention of not testing `actions/*.ts`
  or cron-context `lib/*.ts` functions directly).
