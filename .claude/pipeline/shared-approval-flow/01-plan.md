# Plan: Shared approval flow for large/unusual spend

## Restated goal

Turn the existing `large_spend` and `anomaly` notifications from passive, per-user
FYI broadcasts into an explicit shared acknowledgment: either household member can
mark one "approved," and that state — who approved it and when — is visible to
both Eric and Eva, not just tracked as a private read/unread flag.

## Scope

**In scope:**
- A new nullable approval state on the `Notification` model (`approvedByUserId`,
  `approvedAt`), one Prisma migration.
- A new `approveNotification(notificationId)` server action in
  `actions/notifications.ts`.
- A small new shared, DB-free module `lib/notification-types.ts` defining which
  notification types are approvable.
- `getNotifications()` updated to include the approver's name so both users see it.
- Inline "Approve" affordance on both `components/notifications/notification-bell.tsx`
  and `app/notifications/page.tsx`, and an "Approved by X · <time>" indicator once set.

**Out of scope (explicitly not building):**
- Any attempt to detect *who spent the money* (no "notify the other partner
  specifically" — see reasoning below). This is a deliberate scope decision, not
  an oversight.
- Any change to `checkLargeSpend()`'s or `checkAnomalies()`'s trigger/threshold
  math, or to the notification-preferences schema (no new "require approval"
  toggle — see Design Decision 2).
- A comment/reason field on approval — plain acknowledgment only.
- An "un-approve"/undo action.
- A new dedicated "pending approvals" page or a separate pending-approval badge
  count anywhere in the header/nav.
- Applying the new Prisma migration to the production database — the Coder writes
  the migration files by hand; running it against the real (only) Supabase
  instance is a separate, deliberate step for the human operator, same convention
  as the `gl-code-tag-mapping` task.

## Deliberate scope decision: what "the other partner" means here

`Transaction` has no spender/`userId` field, and `Account` has no per-user
ownership field (confirmed by reading `prisma/schema.prisma` in full for both
models). The only proxy signal — tags like "Credit Cards / Credit Card - Eric" vs
"- Eva" — is optional, manually applied, and not guaranteed present on any given
transaction. Building "identify the spender and notify specifically the other
one" on top of that would mean silently guessing at attribution from an
unreliable tag, which risks misattributing real spend between two people — not
acceptable per ground rule 1 (never fabricate/guess at financial facts).

Instead, this plan implements the buildable, genuinely useful half of the spec
item: both `large_spend` and `anomaly` notifications already reach both
household members in the common case (see Design Decision 1's note on
`checkLargeSpend`'s per-user fan-out for the one caveat). What's missing today is
that "reaching both members" is indistinguishable from every other passive
notification type — there's no way to say "yes, we've seen this and it's fine"
in a way the *other* person can see. Adding a shared approval state on the
notification itself (not a private per-user flag) is the real value spec 05 was
asking for, without inventing spender-detection this data model can't support.

## Affected files/modules

- `prisma/schema.prisma` — add two nullable columns + one relation to `Notification`,
  one reverse relation on `User`.
- `prisma/migrations/<timestamp>_notification_approval/migration.sql` — new,
  hand-written (do not run `prisma migrate dev`/`db push`).
- `lib/notification-types.ts` — new file (shared constant + type guard, no DB import).
- `lib/notifications.ts` — **no changes** (confirmed not needed; see Design
  Decision 1 note on why `checkLargeSpend`/`checkAnomalies` themselves are untouched).
- `actions/notifications.ts` — modify `getNotifications()`, add `approveNotification()`.
- `components/notifications/notification-bell.tsx` — modify (Approve button + approved badge).
- `app/notifications/page.tsx` — modify (Approve button + approved badge, via server-action form).
- `app/api/cron/notifications/route.ts` — **no changes** (approval is a
  post-creation UI/action concern, not part of the generation cron).

## Design decisions (resolved, not left open)

### 1. Data model — smallest change that works

Add two nullable columns directly to the existing `Notification` table:
`approvedByUserId String?` (FK to `User`, `ON DELETE SET NULL`) and
`approvedAt DateTime?`. No new model, no JSON blob.

Why on `Notification` (the shared row) and not `NotificationUser` (the per-user
row): `NotificationUser` is exactly the private per-user mechanism (`readAt`)
that this feature must be distinct from. Putting approval on the row that's
already shared across both users' `NotificationUser` children is what makes "who
approved, when" visible to both without any extra join logic or duplication.

Why a nullable-column migration and not a new model: the smallest structural
change that satisfies "one approver, one timestamp, visible to everyone who can
see the notification." A new `NotificationApproval` model would only be
justified if approval needed its own history (e.g., multiple approvals, or
per-approval comments) — which Design Decision 4 explicitly rules out. A JSON
field on `payload` was considered and rejected: `payload` is already a loosely-typed
grab-bag per notification type, and approval state needs a stable, queryable,
FK-constrained shape (so `Notification_approvedByUserId_fkey` enforces
referential integrity) — a real column is more honest here than nesting it in JSON.

This genuinely needs a migration (two new columns + one FK don't exist today).
Confirmed by reading `prisma/migrations/20260912000000_tag_gl_code_mapping/migration.sql`
for style — this migration is a subset of that one (no new table, just
`ALTER TABLE` + one FK). **Applying this migration to the production database is
NOT part of the Coder's job** — hand-write `schema.prisma` and `migration.sql`
only, matching the prior task's convention (this repo's `DATABASE_URL` points at
the only real Supabase instance; there is no local/shadow DB to run
`migrate dev` against).

Exact schema diff (`prisma/schema.prisma`):

```prisma
model Notification {
  id        String    @id @default(uuid())
  entityId  String?
  type      String    // overspend | low_balance | accrual_shortfall | bill_due | anomaly | ... | large_spend
  payload   Json
  sentAt    DateTime?
  channel   String    // push | email | in_app
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  // Shared approval flow (spec 05 §8 item 9). Applies only to "large_spend" and
  // "anomaly" types at the app layer (see lib/notification-types.ts) — no DB-level
  // type constraint. Stored on this shared row (not NotificationUser) so approval
  // is visible to every recipient, not a private per-user marker.
  approvedByUserId String?
  approvedAt       DateTime?

  entity     Entity?            @relation(fields: [entityId], references: [id])
  approvedBy User?              @relation("NotificationApprovedBy", fields: [approvedByUserId], references: [id], onDelete: SetNull)
  users      NotificationUser[]
}
```

And on `model User`, add one reverse relation field near the other back-relations:
```prisma
approvedNotifications Notification[] @relation("NotificationApprovedBy")
```

Migration file `prisma/migrations/<YYYYMMDDHHMMSS>_notification_approval/migration.sql`
(Coder: use the actual date at implementation time, following the
`YYYYMMDDHHMMSS_snake_case_name` convention seen across every existing migration
folder):

```sql
-- Shared approval flow (spec 05 §8 item 9): adds approval state directly on the
-- shared Notification row (not NotificationUser) so "who approved, when" is
-- visible to every household member, not a private per-user read marker.
-- Applies only to large_spend / anomaly notification types at the app layer
-- (see lib/notification-types.ts); no DB-level type constraint.

ALTER TABLE "Notification" ADD COLUMN "approvedByUserId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "approvedAt" TIMESTAMP(3);

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_approvedByUserId_fkey"
  FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

After writing both files, run `pnpm db:generate` (codegen only, no DB
connection — safe) so `pnpm typecheck`/`pnpm test` see the new Prisma Client
fields. Do **not** run `pnpm db:migrate` or `pnpm db:push`.

### 2. What "opt-in" means here — no new preference

No new `notificationPrefs` key (e.g. no `requireApproval` toggle). Approval
capability applies unconditionally to every `large_spend`/`anomaly` notification
a user already receives, gated only by the existing `large_spend.enabled` /
`anomaly.enabled` toggles in `notificationPrefs` (already opt-in, already
per-user, already shipped).

Justification: spec 05 §8 item 9 says "pings the other partner (opt-in)" — one
lightweight opt-in gate, not two. The existing enabled/disabled toggle per
notification type already *is* that opt-in gate (a user who's opted out of
`large_spend` notifications entirely gets no notification, and therefore nothing
to approve). Adding a second, separate "require approval" toggle would be an
extra preference to design UI for, explain, and maintain, for a feature whose
one-line spec description doesn't ask for that granularity. If the user later
wants approval to be independently toggle-able from plain notification, that's a
natural, additive follow-up — flagged under Risks/unknowns, not built now.

### 3. UI placement — inline on the existing bell + list, no new view

No new dedicated "approvals" page. Both existing surfaces get the same treatment:

- **`components/notifications/notification-bell.tsx`** (client component,
  unchanged boundary — already `"use client"`): for any item where
  `isApprovableNotificationType(item.notification.type)` is true:
  - If `item.notification.approvedByUserId` is null: render an "Approve" button
    next to the existing "Read" button (both can coexist — approving does not
    imply read, and vice versa; they are deliberately separate states, matching
    the framing that approval is distinct from the read/unread mechanism).
  - If set: render a small muted line `Approved by {name} · {relativeTime}`
    instead of the Approve button (using the existing local `relativeTime()`
    helper already in that file).
- **`app/notifications/page.tsx`** (server component, unchanged boundary): same
  two states, rendered directly from server-fetched data (no client component
  needed) using the same inline-server-action-in-a-`<form>` pattern already used
  for "Mark all read" on that page (`<form action={async () => { "use server";
  await approveNotification(...); }}>`).

Both users see the same thing after approval, because the state lives on the
shared `Notification` row — the partner who didn't click Approve sees "Approved
by {other partner's name} · {time}" the next time they open the bell or the page
(bell: next time it's opened, since it fetches fresh each time it opens, matching
existing behavior for `getNotifications()`; page: on next navigation/reload, an
RSC).

Bell's optimistic-update strategy: rather than hand-constructing an approved
`{name}` object client-side (which would require threading the current user's
identity into a component that doesn't have it today), `handleApprove` calls
`approveNotification(id)` then re-fetches `getNotifications()` and replaces
`items` wholesale — the same pattern the bell already uses on open
(`openDropdown`). This keeps the client component free of any new props and
guarantees the rendered name is server-truth, not a client guess.

### 4. Comment/reason — none

Plain acknowledgment. `approveNotification(notificationId: string): Promise<void>`
takes no reason/comment argument. Matches the one-line spec wording ("pings the
other partner," not "requires sign-off with justification") and avoids scope creep.

### 5. Elevated visibility — none added

No new "pending approval" count/badge anywhere (header, sidebar, or elsewhere).
The existing unread-count bell badge already surfaces `large_spend`/`anomaly`
notifications like any other type; requiring approval status to *also* be
counted separately would need a second badge and a decision about how it
interacts with the read-count badge, for a feature whose core ask is "let the
other partner acknowledge it," not "make it more alarming." If real usage shows
approvals get missed, a follow-up could add a distinct pending-approval count —
flagged under Risks/unknowns, not built now.

## Approach (ordered steps)

1. **Schema.** Edit `prisma/schema.prisma`: add `approvedByUserId`/`approvedAt`/
   `approvedBy` to `Notification`, add `approvedNotifications` reverse relation to
   `User` (exact diff above). Hand-write the migration SQL file (exact contents
   above) in a new `prisma/migrations/<timestamp>_notification_approval/` folder.
   Run `pnpm db:generate` only.
2. **Shared type list.** Create `lib/notification-types.ts`:
   ```ts
   export const APPROVABLE_NOTIFICATION_TYPES = ["large_spend", "anomaly"] as const;
   export type ApprovableNotificationType = (typeof APPROVABLE_NOTIFICATION_TYPES)[number];
   export function isApprovableNotificationType(type: string): type is ApprovableNotificationType {
     return (APPROVABLE_NOTIFICATION_TYPES as readonly string[]).includes(type);
   }
   ```
   No DB import, no `"use client"`/`"use server"` — safe to import from both the
   client bell component and the server actions file.
3. **Server action.** In `actions/notifications.ts`:
   - Modify `getNotifications()` to nest an `approvedBy` include:
     ```ts
     export async function getNotifications() {
       const user = await requireAuth();
       return db.notificationUser.findMany({
         where: { userId: user.id },
         include: {
           notification: {
             include: { approvedBy: { select: { id: true, name: true } } },
           },
         },
         orderBy: { notification: { createdAt: "desc" } },
         take: 50,
       });
     }
     ```
   - Add:
     ```ts
     export async function approveNotification(notificationId: string): Promise<void> {
       const user = await requireAuth();

       const notification = await db.notification.findUnique({
         where: { id: notificationId },
         include: { users: { where: { userId: user.id } } },
       });
       if (!notification) throw new Error("Notification not found");
       if (!isApprovableNotificationType(notification.type)) {
         throw new Error("This notification type does not support approval");
       }
       if (notification.users.length === 0) {
         // Not a recipient of this notification — refuse silently-wrong approvals.
         throw new Error("Unauthorized");
       }
       if (notification.approvedByUserId) return; // already approved — idempotent, first approver wins

       await db.notification.update({
         where: { id: notificationId },
         data: { approvedByUserId: user.id, approvedAt: new Date() },
       });
       revalidatePath("/notifications");
     }
     ```
   - Import `isApprovableNotificationType` from `@/lib/notification-types`.
4. **Bell component.** In `components/notifications/notification-bell.tsx`:
   - Import `isApprovableNotificationType` and `approveNotification`.
   - `NotifRow` type is unchanged in *definition* (`Awaited<ReturnType<typeof
     getNotifications>>[number]`) but now structurally includes
     `notification.approvedByUserId`/`approvedAt`/`approvedBy` — no manual type
     edits needed.
   - Add `async function handleApprove(notificationId: string)`: calls
     `await approveNotification(notificationId)`, then re-fetches via
     `const rows = await getNotifications(); setItems(rows);` (mirrors
     `openDropdown`'s fetch).
   - In the item-render block, alongside the existing `isUnread` "Read" button,
     add the approve/approved branch described in Design Decision 3.
5. **Notifications page.** In `app/notifications/page.tsx`:
   - Import `approveNotification` and `isApprovableNotificationType`.
   - In the per-item render block, add the same two-state branch (Approve form /
     "Approved by X · time" line), using the inline-server-action `<form>`
     pattern already used for "Mark all read".
6. **Manual verification.** Since this task touches UI, a human must visually
   verify the rendered bell dropdown and `/notifications` page (both the
   unapproved-with-button state and the approved state) before this is
   considered done — this cannot be fully confirmed by automated tests alone.

## Risks/unknowns

- **`checkLargeSpend`'s per-user fan-out caveat (flagged, not fixed):**
  `checkLargeSpend()` creates a *separate* `Notification` row per user (loop
  body: `userIds: [user.id]`), gated by that user's own `thresholdCents`
  preference — unlike `checkAnomalies`/`checkBudgetOverspend`/etc., which create
  *one* shared row with `userIds: [...all]`. This means: if Eric and Eva have
  different configured thresholds and a transaction crosses both, two
  independent `Notification` rows are created for the same transaction — each
  approvable independently, and approving one does NOT mark the other approved.
  If only one user's threshold is crossed, only that user has a notification at
  all, so there's no "shared visibility" to speak of for that specific alert. In
  the common case (both users leave the default $500 threshold, or intentionally
  match thresholds), this degrades gracefully and both do get a visible,
  shared-in-effect notification. Per the explicit instruction not to modify
  `checkLargeSpend`'s trigger/threshold logic, this plan leaves that fan-out
  behavior untouched — fixing it (e.g., broadcasting the same Notification row
  to every user whose *own* threshold is met) would be a legitimate follow-up
  but changes `checkLargeSpend`'s structure, not just downstream consumption, so
  it's out of scope here. Flagging explicitly so it isn't mistaken for an oversight.
- **`anomaly` type has no such caveat** — it already broadcasts one shared row
  to all users, so approval on it behaves exactly as designed with no edge case.
- **Idempotent "first approver wins," no undo.** If one partner approves by
  mistake, there's no way to un-approve short of a DB fix. Acceptable given
  Design Decision 4's "keep it simple" framing, but worth stating as a
  conscious tradeoff, not an oversight.
- **`onDelete: SetNull` on `approvedByUserId`** was chosen defensively (so a
  hypothetical future user-deletion path wouldn't be blocked by old approval
  records) even though no user-deletion flow exists anywhere in this codebase
  today (consistent with `AuditLog.changedBy` having no delete path either,
  per this repo's existing precedent of not inventing deletion-safety
  machinery that doesn't exist yet) — flagging the inconsistency rather than
  silently picking a stricter `RESTRICT` that could someday surprise someone.
- **No new preference (Design Decision 2)** is a judgment call; if the user
  later wants approval to be independently toggle-able from the underlying
  notification, that's additive and not precluded by this schema.

## Acceptance criteria

- [ ] `prisma/schema.prisma` has `Notification.approvedByUserId` (nullable
      String), `Notification.approvedAt` (nullable DateTime), the `approvedBy`
      relation, and `User.approvedNotifications` reverse relation.
- [ ] A new migration folder exists under `prisma/migrations/` with a
      hand-written `migration.sql` matching the ALTER TABLE/FK shown above; it
      has NOT been applied to the live database by the Coder.
- [ ] `lib/notification-types.ts` exports `APPROVABLE_NOTIFICATION_TYPES`
      (`["large_spend", "anomaly"]`) and `isApprovableNotificationType()`.
- [ ] `lib/notifications.ts` is unmodified — `checkLargeSpend()` and
      `checkAnomalies()` trigger/threshold math and notification payload shape
      are byte-for-byte unchanged.
- [ ] `actions/notifications.ts` exports a working `approveNotification(id)`
      that: requires auth, 404s/throws on unknown id, throws for non-approvable
      types, throws for a caller who isn't a recipient, is idempotent once
      already approved, and sets both `approvedByUserId` and `approvedAt`
      together (never one without the other).
- [ ] `getNotifications()` returns each row's `notification.approvedBy` (id +
      name) alongside the existing fields.
- [ ] The notification bell shows an "Approve" affordance on unapproved
      `large_spend`/`anomaly` items and an "Approved by {name} · {time}" line
      once approved, visible regardless of which user is currently logged in.
- [ ] `/notifications` page shows the same two states via a server-action form,
      no client component added to that page.
- [ ] No other notification types (`overspend`, `low_balance`,
      `accrual_shortfall`, `bill_due`, `budget_pace`, `cc_payment_due`,
      `cc_payment_overdue`, `cc_funding_shortfall`, `policy_expiry`) show any
      approve affordance.
- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass with zero
      regressions against the current 381/381 baseline (re-verify the live
      number when running, per this repo's convention of not trusting a stated
      count over time).
- [ ] A human has visually verified the rendered bell dropdown and
      `/notifications` page in both states (unapproved-with-button,
      approved-with-badge) — required because this task touches UI.

## Test expectations

This task is, by design, mostly CRUD/UI wiring on top of already-tested
infrastructure — **stating explicitly, not as an oversight:** no new pure
decision-math module is warranted here. `isApprovableNotificationType()` is a
one-line array-membership check with no branching worth a dedicated
`lib/__tests__/notification-types.test.ts` file; adding one would be padding
per the task's own instruction not to invent tests for their own sake.

What should exist:
- **No new unit test file is required.** `lib/notifications.ts` is unmodified,
  so `lib/__tests__/notifications.test.ts` needs no changes and should continue
  passing as-is.
- **No integrated/DB test for `approveNotification`** — matches this repo's
  established "no integrated DB tests, mock at the function boundary" testing
  pattern; there is no precedent anywhere in `actions/*.ts` for testing a server
  action directly (none of `markRead`/`markAllRead`/`updateNotifPrefs` etc. have
  dedicated tests either), so `approveNotification` following the same
  precedent is consistent, not a gap.
- **Manual/visual verification is the actual test for this task's user-facing
  behavior** (see Acceptance Criteria's last item) — a human must click through
  both the bell dropdown and `/notifications` page, in both states, before
  calling this done.
- Full baseline regression: `pnpm test` must still show the pre-existing test
  count passing (confirm the live number at run time — the baseline stated in
  the task prompt, 381/381 across 33 files, should not decrease and no new
  failing suite should appear).
