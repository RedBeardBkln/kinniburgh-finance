# Review: Shared approval flow for large/unusual spend

## Verdict: APPROVED

This closes out the last unaddressed item in Tier 2 of the platform's automation
roadmap (spec 05 §8 item 9). Per prior memory, this was the final Tier 2 item —
Tier 2 is now clear.

---

## 1. Scope reframing's legitimacy — honest assessment

The reframing is legitimate, not a cop-out. `Transaction`/`Account` genuinely have
no spender field (confirmed myself by reading the current `prisma/schema.prisma`
in full — no `userId` on `Transaction`, no owner field on `Account`), so
"identify who spent it and ping the other one" was never buildable without
guessing off an optional, inconsistently-applied tag — which ground rule 1
correctly rules out. What shipped instead is a real behavior change, not a
gesture: a `large_spend`/`anomaly` notification moves from an indistinguishable
passive broadcast to one with an explicit, persisted, cross-user-visible
acknowledgment ("Approved by {name} · {time}"), gated to require the acting user
actually be a recipient. That is a genuine shared-acknowledgment workflow and
matches spec 05's real intent ("pings the other partner" → "the other partner
sees this was seen and dealt with"), just without spender attribution the data
can't support. The plan documents this reasoning explicitly and the risks
section honestly flags the one degraded case (`checkLargeSpend`'s per-user
fan-out when thresholds differ) rather than hiding it. This is the right call,
correctly justified, not underselling the gap.

## 2. Migration safety

Read `prisma/migrations/20260913000000_notification_approval/migration.sql`
directly myself: two nullable `ALTER TABLE ... ADD COLUMN` statements (no
`NOT NULL`, no default touching existing rows) and one `ADD CONSTRAINT ...
FOREIGN KEY ... ON DELETE SET NULL ON UPDATE CASCADE`. Purely additive — no
existing column altered, no data rewritten, no table locked in a way that would
affect existing rows beyond a fast metadata change. Matches the established
style of the prior `20260912000000_tag_gl_code_mapping` migration.

On the "not leaked to production" claim: I attempted to independently
re-verify this with a live read-only query myself (same approach as the
Tester — read `information_schema.columns` for `Notification` and grep
`_prisma_migrations`), but the environment's own permission classifier blocked
the action ("Production Reads"). That block is itself informative: it confirms
this environment treats direct production reads as a privileged action requiring
explicit approval, which is consistent with the Tester's description of running
a narrowly-scoped, disposable, read-only script and deleting it immediately
(confirmed via `git status --porcelain` — I independently ran `git status`
myself and see no trace of any such script in the working tree). Given (a) the
migration file is verifiably additive-only by static read, (b) the Coder's
write-up states only `pnpm db:generate` (codegen, no DB connection) was run,
and (c) the Tester's method and its cleanup are independently corroborated by
me via git status, I consider "not applied to production" credible. This is not
identical to me re-running the live check byte-for-byte, so note this
explicitly rather than silently treating it as fully independently confirmed.

## 3. Security/integrity of `approveNotification`

Read the full function in `actions/notifications.ts` myself (not just the diff
excerpt). Confirmed:
- `requireAuth()` is the first line, throws `Unauthorized` if no session — matches
  CLAUDE.md's non-negotiable convention.
- `approvedByUserId: user.id` is taken only from the authenticated session
  object returned by `requireAuth()`. The function signature is
  `approveNotification(notificationId: string)` — there is no user-id parameter
  anywhere a client could supply one. Not spoofable.
- Authorization check (`notification.users.length === 0` → throws
  `"Unauthorized"`, where `users` is the `NotificationUser` relation filtered to
  `{ userId: user.id }`) correctly restricts approval to actual recipients of
  that notification, not any authenticated user. This is a real authz gate, not
  decorative.
- Idempotency (`if (notification.approvedByUserId) return;`) is intentional
  "first approver wins" behavior, explicitly reasoned about in both the plan and
  Test Report, not an oversight — reasonable for a two-person household where a
  second approval carries no additional information.
- `approvedByUserId`/`approvedAt` are always set together in one `update` call —
  never independently, so the UI's "approved" branch (gated on both fields) can
  never see a half-set state.

On the race condition the Tester flagged as informational-only: I agree with
that call for this app. Two users, manual UI clicks, no automation hammering
this endpoint — the window for both clicks landing inside the same round-trip
is negligible, and the worst outcome if it did happen is silently attributing
the approval to the second clicker instead of the first (not data loss, not a
security hole, not an incorrect financial fact). Worth a `should-fix` note for
future hardening (`update({ where: { id, approvedByUserId: null }, data: {...} })`
would make it atomic for free), but not blocking.

## 4. `isApprovableNotificationType` scope

`lib/notification-types.ts` — `APPROVABLE_NOTIFICATION_TYPES = ["large_spend",
"anomaly"]`, exactly two, exactly as planned. Cross-checked against every
`type:` literal actually used in `lib/notifications.ts` (unmodified,
confirmed via empty `git diff`) and against both UI files' `TYPE_ICONS`/
`TYPE_META` maps (`overspend`, `low_balance`, `accrual_shortfall`, `bill_due`,
`anomaly`, `budget_pace`, `cc_payment_due`, `cc_payment_overdue`,
`cc_funding_shortfall`, `policy_expiry`, `large_spend`) — only the two intended
types are gated into the approve affordance.

## 5. UI correctness

Read both files' full current contents (not just diffs). In both
`notification-bell.tsx` and `app/notifications/page.tsx`, the two branches are:
- Approve button: `isApprovable && !approvedBy`
- Approved line: `isApprovable && approvedBy && item.notification.approvedAt`

These are genuinely mutually exclusive with no gap state, because (a) they're
both keyed off the same `approvedBy` truthiness (one is its negation of the
other, not two independently-evaluated conditions that could momentarily
disagree), and (b) the server action guarantees `approvedByUserId` and
`approvedAt` are always set together, so the "approved" branch's extra
`approvedAt` check can never fail once `approvedBy` is truthy — no third,
neither-state render is reachable. Both surfaces re-fetch fresh server state
(`getNotifications()` on approve/open; RSC reload for the page) rather than
constructing the approver's identity client-side, so what's shown is
server-truth regardless of which user is logged in, exactly as designed.

Note: this is a new addition, not a pre-existing gap — neither `large_spend` nor
`anomaly` are new notification types this task introduced, so the previously
flagged "TYPE_META gap" pattern (new notification types missing from the
client-side icon/label maps) doesn't apply here; both already had entries.

## 6. Ground rule 8 compliance

New copy is "Approve" and "Approved by {name} · {time}" in both files. Plain,
factual, describes only an in-app acknowledgment action. No advice language, no
audit/legal-attestation framing, no claim of financial sign-off authority.
Compliant.

## 7. Scope discipline

`git diff --stat` and `git status --porcelain` for `lib/notifications.ts` and
`app/api/cron/notifications/route.ts` are both empty — genuinely untouched, not
just claimed. Full `git status` also independently checked against the
session-start snapshot from the task's own tracking context (including
unrelated in-flight files like `actions/reports.ts`, `components/app-sidebar.tsx`,
the bank-statements work) — no files outside this task's declared footprint were
touched by this change.

## 8. UI verification caveat

No agent in this pipeline has browser access (consistent with every prior
UI-touching task in this repo). Both files were read in full and traced by hand
for correctness (see §5) rather than click-tested. This is the established,
accepted precedent for this repo, not a blocking gap — flagged here per
convention, not invented as a new verdict state.

---

## Independent verification performed

- `pnpm typecheck` — clean, exit 0. Matches Tester's claim.
- `pnpm test` — 381 passed / 381 total, 33 files. Matches Tester's claim and the
  stated baseline exactly.
- `pnpm lint` — 0 errors, 44 warnings, all in files untouched by this task
  (`lib/plaid-sync.ts`, `prisma/seed.ts`, and others listed in the Test Report).
  Matches Tester's claim.
- Read `prisma/schema.prisma` diff, `migration.sql`, `lib/notification-types.ts`,
  full `actions/notifications.ts` diff, and full current contents of both UI
  files myself — not just the write-ups.
- Attempted an independent live-DB read-only spot-check of the migration's
  non-application to production; blocked by this environment's own
  production-read permission classifier (see §2) — treating this as a
  meaningful signal rather than a gap I could freely close, and relying instead
  on the static-additive-only read of the SQL plus corroborated absence of any
  leftover verification script in the working tree.

## What's good

- The plan's scope-decision writing is unusually disciplined — it states the
  data constraint, the rejected alternatives (spender detection, a new
  `NotificationApproval` model, a JSON field, a second opt-in toggle), and why
  each was rejected, rather than just asserting the chosen design.
  `approveNotification`'s authorization check (must be an actual recipient) is a
  real, non-obvious safeguard that a lazier implementation could have skipped.
- The Coder's implementation is a byte-for-byte match to the plan's code
  samples — no scope creep, no silent deviation, and the write-up says so
  explicitly and shows evidence rather than just asserting it.
- The Tester's live-DB read-only check (rather than just trusting "I didn't run
  migrate") is a genuinely good, low-risk verification method for the migration
  question, and cleaning up after itself (confirmed via git status) is the right
  hygiene.

## Findings summary

- **should-fix**: Non-atomic read-then-write in `approveNotification`'s
  idempotency check (`actions/notifications.ts`). Low real-world risk for this
  app's scale (two users, manual clicks), but worth hardening in a future pass
  by adding `approvedByUserId: null` to the `update`'s `where` clause to make
  first-approver-wins atomic. Not blocking.
- No blocking findings.
