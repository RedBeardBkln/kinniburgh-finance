# Review, STEP 1 (budget carry-forward) - carry-forward-seasonal-energy

**Verdict: APPROVED** (step 1 only; step 2 and 3 are not reviewed here). No blocking findings. Four should-fix items and four nits, all small; none needs a re-test cycle to ship, but S1 and S2 are cheap and should ride along with the commit or with step 2.

Reviewer: independent, 2026-10-09. Read the plan (incl. OWNER ANSWERS), implementation note, test report, CLAUDE.md, the two new modules in full, and the real diffs of every touched consumer. Nothing edited, staged, committed or pushed.

## Independent verification

- `pnpm typecheck`: exit 0.
- `npx vitest run` on the carry-forward, bill-dates, upcoming-ledger, net-income, recurring, notifications and advisor groups: 84 files, 1644 passed, 8 skipped, 0 failed (includes the Coder's 4 files and the Tester's 3 added files; the 4000-world oracle fuzz runs and passes).
- Writes: grep of `lib/budget-carry-forward.ts` and `-build.ts` for create/update/upsert/delete/executeRaw/queryRaw: no hit. Only Budget reads (`findMany`) and one `appSetting.findUnique`. `git status` shows nothing under `prisma/`, `actions/` or `lib/tax*`; no migration.
- Remaining direct `db.budget` readers (grep, non-test): `app/budgets/page.tsx`, `app/page.tsx`, `lib/monthly-review-build.ts`, `actions/budgets.ts`, `actions/recurring-suggestions.ts`, `actions/reports.ts` = exactly the allow-listed real-row screens and the loader. Synthetic `carried:` ids reach no server action (a Tester guard pins that no `'use server'` file imports the modules).
- Line endings (`git ls-files --eol`): index is LF everywhere, working copy CRLF for exactly the five files that were CRLF before (`CLAUDE.md`, `app/forecast/page.tsx`, `lib/advisor-context.ts`, `lib/notifications.ts`, `lib/upcoming-ledger.ts`), LF for the rest; new modules are 0 CR. Diff sizes are small, so no whole-file rewrite.
- Edited pre-existing tests (read two of the five diffs myself, Tester read all): query-shape pins only (`where.period.in` -> no `where`, select gained `id`/`tag`, findMany counts 3 -> 2), one case gained a carried-entry assertion. No behaviour assertion weakened.

## Ground rules / owner rules

- Rule 1 (no fabricated data): carried figures are a documented copy of the owner's own earlier row, never invented; ledger rows say `Budget figure carried forward from <period>`, the assistant rows carry `carried_from` plus a note, the overview suffixes `[carried forward from <period>]`. Gap: the Forecast page's business view and the Pace card show carried figures with no label (S3).
- Rule 3: nothing mutates; Budget rows and transactions untouched. Rollover and the one-off additional amount are not carried (so the July 2026 "+$200" does not repeat).
- Rule 5/auth: no new route or action; loaders have no auth by design and are called only from pages/actions/cron that already authenticate or from the already-authenticated cron route; logging is `err.name` only.
- Rule 6 (entity separation): the line key is `entityId|tagId`, the frontier is per entity, an `entityId` filter does not change the answer. A same-named tag in two entities is two lines. Verified in the resolver code and by the Tester's oracle.
- Rule 8: wording is observational.
- Owner answer 1 (ended lines): implemented faithfully (`last.period !== frontier` -> not carried, per entity). Behaviour matches the live lists in the implementation note (30 ended lines).
- Owner answer 5 (Sudden Valley, same feature per entity): SV `Arbor Retreat / Electricity` and `/ Oil` are in the default variable set, so they do not carry flat in step 1. That is a defensible reading (they are seasonal, the step-2 model will own them) and it is flagged. The SV bills have no budget link, which the Coder reported; step 2 must handle that.
- "As budgeted except Electric/Oil/Firewood": implemented as exclusion from flat carry (own rows only) until step 2; old behaviour retained, so no regression for those lines.
- Fail-soft vs throwing: correct. The strict loader rejects on a Budget read error for consumers that already rejected (ledger input, Forecast page, advisor, `checkBudgetOverspend`, `checkBudgetPace`), so the cron never sees a silent "no budget lines" and never creates a notification from an empty read. The date index stays fail-soft with `failed: true`. The recurring hint returns null as before. Cron behaviour (one `Promise.all`, a reject skips dispatch) is unchanged from before this change.

## Decisions on the Tester's findings

- **D1 (frontier hazard): deferral accepted, no code change in this step.** Reasoning: (a) it is not a regression, because those months are empty today and the failure mode on trigger returns the month to the pre-feature state (only the new line shows); (b) the owner's rule is literally "exists in the latest budgeted month" and any code heuristic to guess "a partially filled month" (row-count ratio, look-ahead) would invent a rule, and a wrong guess silently hides or resurrects bills, which is worse than a documented limit; (c) 2027 months stay empty until December and the owner has been told. The proper fix is the planned "Copy last month's lines" button on `/budgets` (writes real rows, so reading and writing agree). Conditions: S1 below (document the hazard where the next developer or the assistant will read it) and the button must be done before the first 2027 row is entered, i.e. before December 2026.
- **D2 (EK Consulting now carries, alerts will start): acceptable, but tell the owner.** It follows his rule and the same overspend rule already applied to EKC in September. Verified in `lib/notifications.ts`: scope key `overspend:<tagId>:<period>` dedupes per day, the title/body use the carried amount without saying it is carried (S4). Expect one "Budget alert: Utilities" for EK Consulting (361.06 spent vs 200) on the next cron run. The Forecast EKC total is $100/month (root line only; children nest), not ten itemised lines as the implementation note implies.
- **D3 (guard regex narrow): resolved by the Tester's broader scanner**, which passes on the real tree. Keep both.
- **Parallelise the setting read: defer** (nit N1). One extra ~0.5 s round trip from a laptop, negligible same-region.
- **`loadEffectiveBudgetRowsSafe` has no production caller: acceptable** (tested, step 2 consumers may use it); remove it if step 2 does not (N2).
- **Failed setting read silently falls back to the default set: should log now (S2)** and step 2 must change the semantics: an absent row means default, but a READ ERROR must not silently replace an owner-customised set (throw or treat as failed), since once a setting UI exists a transient error would flip which lines carry for that request. Today no setting exists, so there is no live effect.

## Findings

### Blocking
None.

### Should-fix
- **S1 (docs) `CLAUDE.md` "Budget carry-forward" paragraph.** It says an ended line is one absent from the entity's latest budgeted month, but does not warn that the latest month is the entity's latest month with ANY row: adding a single line to an otherwise empty future month makes every other line of that entity stop carrying into that month and later. Add one sentence plus "until `/budgets` can copy last month's lines". (ASCII only, keep CRLF.)
- **S2 `lib/budget-carry-forward-build.ts` `readSeasonalLines()`.** The `catch` returns null without a log. Add `console.error("Seasonal lines setting unreadable", err instanceof Error ? err.name : "UnknownError")` (err.name only, as elsewhere), so a misbehaving setting read is at least visible. Carry the stricter semantics into the step 2 plan (see above).
- **S3 (labelling, rule 1) `app/forecast/page.tsx` business view and Category Spend Pace.** Carried figures feed the business-bucket expense totals and the Pace table with no indication they are carried. Today this changes EK Consulting (expenses $100/month for Oct 2026 onward where it was 0). Add a muted caption when any row used has `carriedFrom` (for example "Budget figures for months without their own budget lines are carried forward from the latest earlier month"), or defer to step 2 where that page gets a UI pass anyway. The owner has to visually check these sections regardless (no browser was available to any agent).
- **S4 (notification wording) `lib/notifications.ts`.** A budget alert on a carried row does not say so. Optional suffix on the body when `budget.carriedFrom` is set. Not required for step 1; list it for the step 2 pass.

### Nits
- N1 `loadEffectiveBudgetRows` reads Budget then the setting sequentially; `Promise.all` would save a round trip.
- N2 `loadEffectiveBudgetRowsSafe` is currently dead code.
- N3 The implementation note says the EKC itemised list gains ten lines; the Tester's live replication shows one root line ($100). Treat the Tester's figure as correct.
- N4 `get_budget_status` note hard-codes "Electric, oil and firewood lines are not carried yet"; must be updated in step 2 (the Coder already noted it).

## What's good
- The resolver is small, pure and clock-free, with an independent month-stepping oracle fuzz (4000 worlds, every branch asserted to fire) and a window-independence property, which is the right way to test this kind of rule.
- Consumers were moved onto one read path with a repo-wide guard (broadened by the Tester), explicit selects, and the failure mode preserved per consumer rather than blanket-fail-soft.
- Honest reporting: the Coder flagged the frontier hazard, the SV default-set reading, the loader without an upper bound and every edited test; the Tester reproduced them with real numbers and a read-only live check.
- `/budgets`, the dashboard, monthly review and CSV export left alone, as planned; no migration; endings preserved.

## Route-back
Not applicable (APPROVED). Items S1 and S2 can be applied by the Coder in a trivial follow-up commit; S3/S4 and the stricter setting-read semantics belong in the step 2 plan. "Copy last month's lines" on `/budgets` should be scheduled as its own small task before December 2026.

## Human verification still needed (no agent has a browser)
EK Consulting and Sudden Valley business-forecast sections, the carried-note styling next to "Dated by the budget" on Solar, Category Spend Pace from 2027-01, and the first cron run (expect the EKC Utilities alert).
