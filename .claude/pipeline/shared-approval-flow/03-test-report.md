# Test Report: Shared approval flow for large/unusual spend

## Verdict: PASS

## Acceptance criteria checklist

- [x] `prisma/schema.prisma` has `Notification.approvedByUserId` (nullable String),
      `Notification.approvedAt` (nullable DateTime), the `approvedBy` relation, and
      `User.approvedNotifications` reverse relation. — Verified via `git diff
      prisma/schema.prisma`; diff matches the plan's exact schema block character-for-
      character (relation name `"NotificationApprovedBy"` on both sides, `onDelete:
      SetNull`).
- [x] A new migration folder exists under `prisma/migrations/` with a hand-written
      `migration.sql` matching the ALTER TABLE/FK shown in the plan; NOT applied to the
      live database. — `prisma/migrations/20260913000000_notification_approval/migration.sql`
      read directly: two nullable `ALTER TABLE ADD COLUMN` statements + one `ADD
      CONSTRAINT ... FOREIGN KEY` — a pure additive change, no touching of existing
      non-null constraints or data, matches the plan verbatim. Independently verified
      against the live Supabase DB with a read-only Prisma script (`information_schema.columns`
      for `"Notification"` and `_prisma_migrations`): `approvedByUserId`/`approvedAt` do
      NOT exist in production, and no `_prisma_migrations` row matches
      `%notification_approval%`. Script was written in repo root, run once, and deleted
      immediately after (confirmed via `git status --porcelain` — no trace left).
- [x] `lib/notification-types.ts` exports `APPROVABLE_NOTIFICATION_TYPES`
      (`["large_spend", "anomaly"]`) and `isApprovableNotificationType()`. — Read the file
      directly; matches exactly, no other types included. Cross-checked against
      `lib/notifications.ts`'s actual `type:` literals (`overspend`, `budget_pace`,
      `low_balance`, `accrual_shortfall`, `bill_due`, `anomaly`, `policy_expiry`,
      `cc_payment_due`, `cc_payment_overdue`, `cc_funding_shortfall`, `large_spend`) —
      only `anomaly`/`large_spend` are in the approvable list; the other 9 are not.
- [x] `lib/notifications.ts` is unmodified. — `git diff lib/notifications.ts` and `git
      status --porcelain lib/notifications.ts` both empty. `app/api/cron/notifications/route.ts`
      likewise empty/untouched.
- [x] `actions/notifications.ts` exports a working `approveNotification(id)` meeting all
      stated sub-requirements. — Read the full function body:
  - `requireAuth()` is the first line (throws `Unauthorized` if no session).
  - Throws `"Notification not found"` on unknown id.
  - Throws for non-approvable types (checked via `isApprovableNotificationType`).
  - Throws `"Unauthorized"` for a caller who isn't a recipient (checked via
    `notification.users.length === 0`, where `users` is filtered to `{ userId: user.id }`
    — confirmed correct against `NotificationUser`'s actual `userId` field in schema).
  - `approvedByUserId` is set to `user.id` from `requireAuth()` (the session's own user),
    never taken from an unchecked client argument — a caller cannot claim credit for
    someone else's approval by passing a different id; the function signature is
    `approveNotification(notificationId: string)` with no user-id parameter at all.
  - Idempotent: `if (notification.approvedByUserId) return;` — a second call after
    already-approved is a silent no-op, correctly implementing "first approver wins" as
    intended by the plan (doesn't let a second user overwrite the first approver).
  - `approvedByUserId` and `approvedAt` are always set together in one `update` call —
    never independently.
- [x] `getNotifications()` returns each row's `notification.approvedBy` (id + name). —
      Confirmed via nested `include: { approvedBy: { select: { id: true, name: true } } }`.
- [x] Bell shows "Approve" on unapproved approvable items and "Approved by {name} ·
      {time}" once approved, regardless of logged-in user. — Read the full diff: gating is
      `isApprovable && !approvedBy` for the button and `isApprovable && approvedBy &&
      item.notification.approvedAt` for the approved line — these are mutually exclusive
      (both keyed off the same `approvedBy` truthiness), so an approvable-but-approved
      item shows exactly the approved state, never both/neither. State is server-truth
      (re-fetched via `getNotifications()` after approving, not client-constructed), so it
      renders identically for whichever user is logged in.
- [x] `/notifications` page shows the same two states via a server-action form, no client
      component added. — Confirmed: `<form action={async () => { "use server"; await
      approveNotification(...) }}>` pattern, mirrors the existing "Mark all read" form on
      the same server component page. Same mutually-exclusive gating logic as the bell.
- [x] No other notification types show an approve affordance. — Confirmed by the
      `isApprovableNotificationType` gate wrapping both UI branches in both files, and by
      the type-literal grep above showing the 9 other types aren't in the approvable list.
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass with zero regressions against
      381/381. — Ran all three myself (see below); confirmed live counts, not trusted from
      the write-up.
- [~] A human has visually verified the rendered bell dropdown and `/notifications` page —
      **not verifiable by me** (no browser access); flagged under "Not tested" below, per
      the plan's own acknowledgment that this step requires a human. Does not block PASS
      since the plan explicitly scopes this as a separate manual step, not part of
      automated verification.

## Tests run

```
$ pnpm typecheck
tsc --noEmit
(clean, exit 0, no output)

$ pnpm lint
✖ 44 problems (0 errors, 44 warnings)
```
All 44 warnings confirmed pre-existing, in files unrelated to this task (`components/documents/document-review-client.tsx`,
`components/income/*`, `components/insurance/insurance-policy-card.tsx`, `components/retirement/retirement-balance-form.tsx`,
`components/settings/entities-client.tsx`, `components/tag-rules/retroactive-rule-modal.tsx`, `components/vault/*`,
`lib/__tests__/doc-extract.test.ts`, `lib/__tests__/forecast.test.ts`, `lib/encrypt.ts`, `lib/plaid-sync.ts`, `prisma/seed.ts`).
None of the task's changed files (`actions/notifications.ts`, `lib/notification-types.ts`,
`components/notifications/notification-bell.tsx`, `app/notifications/page.tsx`) appear anywhere in the warning list.

```
$ pnpm test
 Test Files  33 passed (33)
      Tests  381 passed (381)
   Duration  1.71s
```
Exact same file count and test count as the stated baseline — zero regressions, `lib/__tests__/notifications.test.ts` (9 tests)
ran and passed unchanged.

Live-DB read-only verification (script written to repo root as `check-notification-columns.mjs`, run once with plain `node`,
deleted immediately after):
```
Notification columns: [ 'channel','createdAt','entityId','id','payload','sentAt','type','updatedAt' ]
Matching migration rows: []
```
Confirms `approvedByUserId`/`approvedAt` do not exist on the live table and the migration has not been applied.

## Tests added

None. Reviewed the plan's "Test expectations" section and agree with its reasoning:
`isApprovableNotificationType()` is a one-line array-membership check with no branching,
`lib/notifications.ts` is unmodified (its existing 9-test suite already covers
`checkLargeSpend`/`checkAnomalies`), and this repo has no precedent for direct unit tests
on any `actions/*.ts` server action (`markRead`, `markAllRead`, `updateNotifPrefs`, none
have dedicated tests) — `approveNotification` following the same precedent is consistent,
not a coverage gap. Manual/visual verification is the plan's own stated test mechanism for
the UI behavior here.

## Defects found

None blocking. One low-severity observation, inherited directly from the plan's own code
sample (not a Coder deviation — the Coder implemented this verbatim):

- **Read-then-write race in `approveNotification`'s idempotency check (low severity, informational only).**
  The idempotency check (`if (notification.approvedByUserId) return;`) and the subsequent
  `db.notification.update(...)` are two separate round-trips, not one atomic conditional
  update (e.g. `update({ where: { id, approvedByUserId: null }, data: {...} })`). If both
  household members' clicks land inside the same tiny window, "first approver wins" is not
  strictly guaranteed — the second write is unconditional and would silently overwrite the
  first approver's `approvedByUserId`/`approvedAt` with its own. Given this is a two-person
  household app driven by manual UI clicks (not a high-concurrency system), the practical
  risk is negligible, and the code exactly matches what the plan itself specified — so this
  is not attributable to Coder deviation and does not block PASS. Flagging in case a future
  task hardens this (e.g. adding `approvedByUserId: null` to the `update`'s `where` clause).

## Not tested

- **Manual/visual verification of the rendered bell dropdown and `/notifications` page**
  (both unapproved-with-button and approved-with-label states, for both `large_spend` and
  `anomaly` types) — I have no browser/UI rendering access in this environment. The plan
  explicitly calls this out as a required human step separate from automated
  verification; it is not silently assumed covered here.
- **Behavior once the migration is actually applied to production** — by design, this
  round only verifies the migration is additive and NOT yet live; end-to-end behavior
  against a real applied schema is untested (out of scope per the plan, which explicitly
  defers `prisma migrate deploy`/`db push` to a separate deliberate operator step).
- **`checkLargeSpend`'s per-user fan-out edge case** (two independent `Notification` rows
  for the same transaction event when Eric/Eva have different thresholds, each approvable
  independently) — this is explicitly flagged in the plan as an existing, unfixed
  characteristic of `checkLargeSpend`, out of scope for this task, and not something I
  attempted to reproduce end-to-end since it requires DB state and `checkLargeSpend` is
  unmodified.

## Scope check

`git status` at the end of this task matches the session-start snapshot exactly for every
file outside this task's stated scope (`actions/notifications.ts`, `app/notifications/page.tsx`,
`components/notifications/notification-bell.tsx`, `prisma/schema.prisma` modifications;
`lib/notification-types.ts`, `prisma/migrations/20260913000000_notification_approval/`
additions). No files outside the task's declared scope were touched.

## Ground rule 8 (no financial-advice/liability claims)

New copy is "Approve" (button label) and "Approved by {name} · {time}" (status line) — both
plain, factual, and describe only an in-app acknowledgment action, not a financial
sign-off, audit attestation, or liability claim. No wording implies legal/tax/financial
advice or formal approval authority.
