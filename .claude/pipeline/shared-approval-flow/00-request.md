Build a shared approval flow for large/unusual spend, per spec 05 §8 item 9 ("Shared
approval flow — large/unusual spend pings the other partner (opt-in)") — the last
unaddressed item in Tier 2 of the platform's automation roadmap.

CONTEXT: Two notification checks already exist in lib/notifications.ts and are currently
PASSIVE BROADCASTS (no approval/acknowledgment mechanism, just a read/unread notification
like every other type):
- `checkLargeSpend()` — per-transaction, threshold-based (configurable per user via
  `User.notificationPrefs["large_spend"]`, default $500), fires "large_spend" notifications
  to every user who has it enabled.
- `checkAnomalies(period)` — per-tag, monthly, compares current spend to a 3-month trailing
  average (fires when >1.5x average and above a $50 noise floor), fires "anomaly"
  notifications to all users.
Read both of these functions in full in lib/notifications.ts, plus actions/notifications.ts
(existing getNotifications/markRead/markAllRead/getNotifPrefs/updateNotifPrefs — the existing
per-user read-tracking and opt-in-preference infrastructure this task should build on, not
duplicate), and the Notification/NotificationUser Prisma models.

IMPORTANT CONSTRAINT ALREADY INVESTIGATED — do not re-litigate, design around this:
`Transaction` has NO field identifying which household member made a purchase (no
`userId`/spender field), and `Account` has no per-user ownership field either. The only
approximate signal is manually-applied tags like "Credit Cards / Credit Card - Eric" vs
"Credit Cards / Credit Card - Eva" (seen in the real tag list), which are optional and not
guaranteed to be applied. Given this, "pings the other partner" cannot reliably mean
"identify who spent it and notify specifically the other one" — that data doesn't exist.
Design instead around a genuinely useful, buildable interpretation: a large/unusual-spend
notification gets an explicit APPROVAL state (distinct from the existing read/unread state)
that either household member can act on, and — critically — that action is VISIBLE TO BOTH
users (who approved it, when), not just a private per-user read marker. This turns a passive
"FYI" broadcast into an actual shared acknowledgment workflow, which is the real value spec
05 was asking for, without inventing a spender-detection feature this data model can't
support. State this reasoning explicitly in the plan so it's clear this was a deliberate
scope decision, not an oversight.

DESIGN QUESTIONS TO RESOLVE (make concrete decisions, don't leave these open for the Coder):
1. Exact data model for "approval state" on a notification — a new field/model, or reuse
   something. Consider: does this need to be its own concept, or can it be layered onto the
   EXISTING Notification/NotificationUser rows for "large_spend"/"anomaly" types specifically
   (a JSON field, a new nullable column, or a small new model like `NotificationApproval`
   keyed by notificationId)? Prefer the smallest change that works — this project has had
   exactly one schema migration so far (the gl-code-tag-mapping task) and treats each one
   carefully; state plainly whether this task genuinely needs one and why, or how you're
   avoiding one.
2. What "opt-in" means concretely for THIS feature specifically, beyond the
   threshold/enabled toggle that already exists for large_spend in notificationPrefs — is
   there a new preference to add (e.g., "require approval" vs. "just notify"), or does
   approval apply unconditionally to every large_spend/anomaly notification once the
   existing large_spend/anomaly toggles are on? Decide and justify.
3. UI: where does "Approve" live — inline on the existing notification bell/list
   (components/notifications/notification-bell.tsx, app/notifications/page.tsx — read both
   fully first) or a new dedicated view? What does an approved item look like afterward (to
   both users, including the one who didn't click approve)?
4. Does approving require a comment/reason, or is a plain acknowledgment enough? Keep this
   simple unless you find a strong reason not to — read spec 05 §8 item 9's one-line
   description again, it's intentionally lightweight ("pings the other partner", not
   "requires sign-off with justification").
5. Should un-approved large/unusual-spend notifications surface anywhere with elevated
   visibility (e.g., a small "pending approval" count somewhere), or is sitting in the
   existing notification list sufficient? Decide based on what's actually useful vs. scope
   creep.

REQUIREMENTS:
- CLAUDE.md conventions: TypeScript strict, `requireAuth()` first line of every server
  action, ground rule 8 (observational language, no advice) in any new copy.
- Testing: any new pure decision logic (if any emerges — this task may be mostly
  straightforward CRUD/UI, in which case say so plainly rather than inventing a pure
  function to test for its own sake) follows this repo's established
  pure-function-plus-thin-DB-wrapper pattern.
- Definition of done: pnpm typecheck, pnpm lint, and pnpm test (full suite) all pass clean.
  Current baseline is 381/381 tests across 33 files — if this task adds no new pure logic
  worth testing, say so explicitly rather than padding with low-value tests; zero
  regressions either way.
- Do NOT modify checkLargeSpend's or checkAnomalies's existing trigger/threshold logic —
  only their downstream consumption (the notification payload/UI) should change, unless you
  find a compelling reason otherwise (state it if so).
- If a schema change IS genuinely needed, follow the exact conventions from the
  gl-code-tag-mapping migration (check
  prisma/migrations/20260912000000_tag_gl_code_mapping/ for the established style) and note
  plainly in the plan that applying it to production is a separate, deliberate step outside
  the Coder's job — same as that prior task.
- This task touches UI — note explicitly that a human must visually verify the rendered
  page, consistent with every prior UI-touching task in this repo.

Produce a concrete, scoped implementation plan: exact schema/type changes (or confirmation
none are needed), exact new/modified function signatures, the UI structure (what's new vs.
modified, server vs. client component boundaries matching this repo's established RSC
pattern), and specific test cases if any pure logic is introduced.
