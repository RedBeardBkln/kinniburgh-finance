# Review: GL-code auto-assignment from tag→GL-code mapping

## Verdict: APPROVED

The migration still needs a deliberate, separate "apply to production" step
before this delivers real value — the mapping UI, backfill, and resolver are
inert until `prisma/migrations/20260912000000_tag_gl_code_mapping/migration.sql`
is actually run against the real database (same situation as the
quarterly-forecast feature's own migration-not-yet-applied state). Nothing in
this task's history applied it anywhere; confirmed independently below.

---

## What I verified myself (not just trusted from the write-ups)

- **Migration safety.** Read the migration SQL directly
  (`prisma/migrations/20260912000000_tag_gl_code_mapping/migration.sql`): one
  `CREATE TABLE`, one unique index, three `ADD CONSTRAINT` FKs to existing
  tables (`Entity`, `Tag`, `GlCode`), all `ON DELETE RESTRICT`. No `ALTER` on
  any existing table, no data migration, no default-backfill statement. Pure
  additive change — safe to apply later with no lock/breakage risk to existing
  data. Matches the style of the prior `20260908120000_bank_statements`
  migration. Confirmed via `git diff` that `schema.prisma`'s `TagGlCodeMapping`
  model and back-relations match the SQL exactly, field for field.
- **Never-applied confirmation.** `git log --all` shows no commit history for
  the migration file (it's untracked/new). The Tester's report documents
  direct read-only queries against the live Supabase DB showing no
  `_prisma_migrations` row and no `TagGlCodeMapping` table. I did not re-run
  those queries myself (no need to duplicate live-DB access for a read that's
  already been done twice — Coder's `pnpm db:generate`-only claim and the
  Tester's live confirmation agree), but I did confirm no stray verification
  scripts were left in the repo (`git status` clean of any `.mjs`/`__tester`
  files) and that `pnpm db:generate` is the only Prisma command this task's
  history claims to have run.
- **Conflict-rule correctness.** Read `lib/gl-code-resolver.ts` end to end.
  `resolveGlCodeForTags` dedups reachable GL codes via `Set`; 0 distinct →
  `no_mapping`, 1 → `resolved`, >1 → `conflict`, never guesses. This is the
  right default for tax-relevant categorization — a false auto-assignment on
  ambiguous tag combinations would corrupt P&L data silently, and this design
  refuses to do that. `lib/__tests__/gl-code-resolver.test.ts`'s 7 cases
  (including the real conflict case, asserting both distinct ids are
  reported, not just a boolean) genuinely exercise this, not tautologically.
  Independently reran `pnpm test`: 358/358 passed, 32 files, matching both
  write-ups exactly.
- **7 call-site integrations, spot-checked via actual diffs** (not the
  Tester's summary): read `git diff` for all 7
  (`actions/import.ts`, `actions/tag-rules.ts`, `actions/transactions.ts` ×3,
  `lib/notifications.ts`, `lib/plaid-sync.ts`). Confirmed for each that the
  "complete final tag set" precondition holds (brand-new transaction, or
  delete+recreate of the full tag set, or a previously-tagless transaction
  gaining exactly one tag) and that `entityId` passed to the resolver is
  correct in every case (e.g. `lib/notifications.ts` passes `entity.id`,
  matching the `entityId` the transaction was just created with moments
  earlier).
  - **`lib/plaid-sync.ts` (highest volume, cron-driven, no human in the loop):**
    the `uncategorized` query's `select` correctly gained `entityId: true`
    (previously missing — would have crashed or silently no-op'd the
    resolver call without it); entries are built by joining `assignments`
    back to `entityById`, correctly derived from a query that already filters
    to `tags: { none: {} }`, so `tagIds: [a.tagId]` is genuinely the complete
    set. `userId` correctly omitted.
  - **No-clobber guarantee:** `autoAssignGlCodes` batch-fetches each
    transaction's current `glCodeId` first and does `if
    (currentGlCodeById.get(entry.transactionId)) continue;` before ever
    resolving or updating — this applies uniformly to all 7 call sites and
    the backfill, and `applyGlCodeBackfill` additionally filters to
    `glCodeId: null` server-side before even building entries
    (belt-and-suspenders, re-resolves rather than trusting client input).
    A transaction with a manually-set `glCodeId` (via the pre-existing
    `assignGlCode`) can never be silently overwritten by this system, by
    construction.
- **Audit trail honesty.** `AuditLog.changedBy` is confirmed non-nullable
  (`prisma/schema.prisma:689`, a hard FK to `User`, no default). There is
  genuinely no way to create an audit row without a real session `userId` in
  this schema, and the plan's Risk 3 / implementation's Open Items both state
  the 2 cron/unauthenticated sites (`lib/notifications.ts`,
  `lib/plaid-sync.ts`) skip the audit row plainly, in a code comment at the
  call site, not hidden. This matches those same 2 sites' pre-existing choice
  to skip an audit row for their own `TransactionTag.create` calls today — not
  a new gap this task introduces, and not worked around with a fabricated
  system-user id.
- **Code quality vs. established conventions.** Compared
  `actions/gl-code-mappings.ts` against `actions/gl-codes.ts`: same local
  `requireAuth()` wrapper pattern (not a shared lib helper — that's this
  repo's existing, if slightly inconsistent-with-CLAUDE.md-wording, actual
  convention), same `before: {}` / `after: {...}` audit shape, same
  `user.id!` non-null-assertion style. `components/business/gl-backfill-modal.tsx`
  mirrors `components/tag-rules/retroactive-rule-modal.tsx`'s step-machine
  shape (`ask → loading → results → done`) faithfully. Note:
  `components/business/tag-gl-mapping-section.tsx`'s `handleSetMapping` has no
  `catch` (silent failure on error, only a `finally` to clear the saving
  spinner) — I flagged this as a possible nit, then checked
  `gl-page-client.tsx`'s existing `handleAssign` (the direct analog for the
  coding-queue `<select>`) and found it has the *identical* try/finally-no-catch
  shape already in the codebase. This is a faithful match of an existing
  (imperfect but established) convention, not a new regression — not blocking.
- **Completeness against plan scope.** All acceptance criteria in
  `01-plan.md` are met at the code level: schema/migration, resolver +
  7-case unit tests, `computePL` fix + both follow-ons (seed.ts, test mocks),
  all 7 call sites, mapping CRUD UI, cross-entity-mapping rejection,
  backfill preview/apply with audit rows, `deleteGlCode` mapping-in-use
  guard. Independently reran `pnpm typecheck` (clean), `pnpm lint` (0 errors,
  44 warnings, none in this task's files), `pnpm test` (358/358, 32 files) —
  all match both the Coder's and Tester's reported numbers exactly.

## What's good

- The entity-scoping gap in the schema (Prisma can't express the composite
  FK) is documented in three places consistently — a schema comment, a code
  comment at the enforcement point in `upsertTagGlMapping`, and the plan/
  implementation write-ups — so it won't get silently dropped in a future
  refactor.
- The resolver is genuinely pure and well-tested, including the
  same-code-dedup and mixed-mapped/unmapped edge cases that are easy to get
  wrong and easy to skip testing.
- The backfill's "re-resolve server-side, never trust client input" design
  closes an obvious tampering/staleness gap between preview and apply.
- The Coder's own "Deviations from the plan" note about reconciling a
  conflicting prior-task memory entry (income vs. revenue) by trusting this
  task's live-DB-verified instruction, rather than silently picking one, is
  exactly the right way to surface that kind of ambiguity.

## Findings

- **Nit:** `AuditLog.changeType`'s schema comment
  (`entity_change | tag_change | category_change`) doesn't list
  `gl_code_assigned` or `gl_code_auto_assigned` as valid values. Pre-existing
  gap (the former was already undocumented before this task), and
  `changeType` is a free-text string with no enum enforcement, so this is
  purely a documentation nit, not a functional issue. Worth a one-line
  comment update whenever someone next touches that model.
- **Not a finding, contextual note per task instructions:** the Tester
  correctly identified and correctly did not block on a different,
  uncommitted task's file (`app/business/[slug]/pl/page.tsx`, from
  `quarterly-business-forecast`) gating its Quarter-End Forecast section on
  `type: "income"` — the identical mistake this task fixed elsewhere, in a
  file this task never touched. Confirmed via `git diff` that this task's
  Coder did not write that line. This is real and should be fixed as a
  fast-follow, but it is that other task's responsibility to fix when it
  comes up for its own review, not a blocker here.
- **UI verification gap, accepted with the caveat named** (consistent with
  how the prior UI-touching task's review handled the same situation): no
  pipeline agent has browser access. I traced both new components' render
  logic and server-action wiring by hand and found them sound (typed
  correctly, no `any`, correct props threading from
  `app/business/[slug]/gl/page.tsx`), but a human still needs to click
  through the mapping section and backfill modal in a real browser before
  this is considered fully done in practice. This does not block APPROVED —
  it's named explicitly per the same precedent as the last UI task.

## Route-back target

N/A — approved, no route-back.

## Explicit note on production impact

This is inert until a deliberate follow-up step applies
`prisma/migrations/20260912000000_tag_gl_code_mapping/migration.sql` to the
real database (`prisma migrate deploy` or equivalent), separately from this
pipeline, per the plan's and Coder's explicit and correctly-honored
constraint not to touch the live DB. Until that happens: no mapping can be
saved, no backfill can run, and `computePL`'s fix — while itself already
correct and shippable — still has zero business transactions with a
`glCodeId` set to actually populate `incomeLines`/`expenseLines` from
(confirmed live: zero GL-coded business transactions exist today). Applying
the migration is the next required action, followed by the owner configuring
mappings and running the backfill, before this feature does anything visible.
