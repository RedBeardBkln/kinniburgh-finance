# Review — Notification delivery hardening

## Verdict: APPROVED

## Verification performed

- Read `00-request.md`, `01-plan.md`, `02-implementation.md`, `03-test-report.md` in full.
- Read the real diff (`git diff`) for all 5 changed files, plus the full current content of `lib/web-push.ts`, `lib/__tests__/web-push.test.ts`, and `components/notifications/notif-prefs-form.tsx` — not just the summaries.
- Independently re-ran `pnpm typecheck` (clean), `pnpm lint` (0 errors, 43 pre-existing warnings, none in touched files), `pnpm test` (458/458, 38 files) — all match the Tester's reported numbers.
- Grepped the diff for `channel`/`email` occurrences in `lib/notifications.ts` — none. Confirmed the email channel is genuinely untouched.
- Grepped the diff for `checkDocumentExpiry`/`checkLargeSpend` — zero matches, confirming those two already-correct functions are byte-for-byte unmodified.
- Traced `checkLowBalance` line-by-line: the `$15` minimum-balance-fee `Transaction`/`TransactionTag`/GL-assignment block (lines 311–357) sits entirely before `eligibleUserIds` is computed (line 361) and before the `breaches.length === 0` gate — it has no dependency on `users`/prefs at all. The `low_balance` preference only gates the `createNotification` call at the bottom. This is a real financial side effect (writes a `Transaction` row and runs GL auto-assignment) and it correctly stays unconditional. Confirmed further by the Coder's own test ("still creates the $15 minimum-balance fee transaction even when every user is opted out") which I re-ran and which passes.
- Confirmed `getAllUserIds()` is fully removed with a repo-wide grep — only pipeline markdown docs reference the name now, no code.
- Confirmed `TYPE_META`-equivalent maps in `components/notifications/notification-bell.tsx` already have entries for `budget_pace`, `cc_payment_due`, `cc_payment_overdue`, `cc_funding_shortfall` (pre-existing, since these notification types already existed — this task only added prefs-schema keys, no new type strings) — so the recurring "new type string missing from TYPE_META" pattern I've flagged before in this repo does not apply here.
- Checked `checkCardPaymentsDue`'s shared-toggle design: `eligibleUserIds` is computed once outside the per-card loop from `cc_payment_due`, then reused for both the `cc_payment_due` and `cc_payment_overdue` branches. This matches the plan's explicit judgment call (confirmed reasonable — same underlying per-card check, two severities, not independent conditions) and the risk is called out transparently in the plan for the user to reconsider later if wanted; not a defect.

## Findings

None blocking. Two minor nits, neither requiring a round-trip:

- **nit** — `lib/notifications.ts`, `checkCardPaymentsDue`: `if (eligibleUserIds.length === 0) continue;` sits inside the per-card `for` loop rather than short-circuiting once before the loop (e.g. `if (eligibleUserIds.length === 0) return 0;` right after computing it). Functionally identical — it still skips all per-card notification work — just a hair less direct than it could be. Not worth a round-trip.
- **nit** — The web-push test's `webpushHost["sendNotification"] = sendNotificationMock` approach permanently mutates the shared `web-push` module object for the duration of the test file (restored via `afterAll`). This is a reasonable, well-documented workaround for the genuine `@types/web-push` synthetic-default-export `vi.spyOn` inference gap the Coder hit (verified: this is a real TS limitation, not an excuse to reach for `any` — and no `any` was used anywhere in the diff). Vitest's default per-file thread isolation means this can't leak across test files; the Tester's reasoning here is sound and matches documented Vitest behavior. Flagging only so a future reader of this test file understands why it doesn't use `vi.mock("web-push", ...)` like other 3rd-party-SDK tests in this repo — the in-file comment already explains this adequately, so no action needed.

## Scope discipline — confirmed

- No email-channel work. `channel: "in_app"` literal untouched; zero email-related lines anywhere in the diff.
- `checkLowBalance`'s `$15` fee side effect is genuinely unconditional, not accidentally gated behind `low_balance` prefs (verified above).
- `checkDocumentExpiry` and `checkLargeSpend` are unmodified (verified via diff grep, not just trusting the summary).
- No new `Notification.type` strings, no wording/body changes, no `TYPE_META`/`notification-bell.tsx` changes — confirmed via `git diff --stat` equivalent (only the 5 files listed in `git status` are touched, matching what was planned).
- No Prisma schema changes — correct, since `notificationPrefs` is already `Json` and `Notification.type` is a plain string.

## Code quality

- The 8 fixed check functions consistently follow one of the two established patterns (batch-filter vs. per-user-threshold), matching the plan's explicit instruction not to force one shape onto a function that doesn't fit it. The `prefs["key"] as {...} | undefined` inline-cast pattern is repeated 8 times with slightly different shapes — mildly repetitive but consistent with this file's existing style (no shared helper existed before this change either), and extracting a shared `getEligibleUserIds(users, prefKey, predicate)` helper would be a reasonable future cleanup, not something this task needed to introduce.
- `Decimal.greaterThan`/`.times()` used correctly for the anomaly multiplier comparison (not raw `>`), matching CLAUDE.md's Decimal convention and the file's existing style throughout.
- The stale web-push comment is replaced with an accurate one; the new comment explains the 404/410 rationale and the concurrent-delete race guard clearly.

## Test quality

- Tests are substantive, not tautological: they set up realistic per-user preference divergence (one user opted out/high-threshold, another default) and assert on the actual `userIds` payload extracted from the `notification.create` mock call, not just a boolean return value. The threshold/daysAhead/multiplier tests specifically construct scenarios where only one of two users' configured value is met — this actually exercises the acceptance criteria rather than merely confirming the code runs.
- The Tester's own additions (`checkCardPaymentsDue` ×3, `checkCcFundingShortfall` ×2) are a good catch — `checkCardPaymentsDue`'s shared-toggle-across-branches shape genuinely differs from the boilerplate the plan deemed low-risk, and testing it directly (rather than trusting code-reading) is the right call per this pipeline's own stated purpose.
- `lib/__tests__/web-push.test.ts` covers all 5 meaningful branches (410 deletes, 404 deletes, 500 doesn't, non-`WebPushError` doesn't, success doesn't) using the real `WebPushError` class, avoiding a hand-rolled prototype-chain mock that could silently drift from the real error shape.

## What's good

- The plan, implementation, and test report are unusually well cross-referenced — the Coder's one deviation (web-push mocking mechanism) was flagged explicitly rather than silently substituted, and the Tester's coverage decisions explain their reasoning rather than just listing what was added.
- Real bugs, real fix: this genuinely closes the gap between "toggle exists in settings UI" and "toggle actually suppresses the notification," which was the whole point of the task.
- Restraint was well exercised: no scope creep into the `bill_due.daysAhead`/`anomaly.multiplier` missing UI inputs, no attempt to split `cc_payment_due`/`cc_payment_overdue` into separate toggles, no email-channel work — all correctly identified as out of scope and left alone rather than "while I'm in here" fixed.

## Memory update

No new recurring pattern to record — this task didn't hit any of the previously-catalogued repo pitfalls (GL income/revenue drift, archivedAt omission, storage-path encoding, TYPE_META gaps) and didn't introduce a new one worth tracking. Existing memory entries remain accurate and were checked against, not updated.
