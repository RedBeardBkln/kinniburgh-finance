# Test report: credit-card-full-pay

## Verdict: FAIL

One blocking defect (D1: the advisor `get_forecast` tool still funds every card from the account nicknamed "Credit Cards" and ignores paid statements and estimates). Everything else in the plan's acceptance criteria and in the requested rigor list passed; the other defects are low severity. D1 is a small, isolated fix (or an explicit, owner-accepted deferral), so if the Reviewer/owner accepts D1 as a documented follow-up this implementation is otherwise ready.

## Acceptance criteria (plan section 8) and requested checks

| # | Criterion | Result | Evidence |
|---|---|---|---|
| AC1 | Live data: Barclay Nov 5 about $2,914.91 estimate (high); Capital One Oct 12 $792.68 scheduled and Nov 12 about $72.56 estimate; jetBlue Oct 12 $51.26 and Nov 12 $21.26; Barclay Oct 5 $623.19 nowhere as unpaid; every estimate has a "why" | PASS (one plan-text discrepancy, see D3) | Live read-only run of `loadCardProjections` and `loadUpcomingLedger` (below). Capital One / jetBlue Nov 12 are `medium`, plan text said `low`: the plan's own rule (<= 10 days to close = medium; Nov 12 minus 25 days = Oct 18 = 9 days) gives medium, so the plan text was arithmetically wrong, code follows the rule |
| AC2 | Barclay + Capital One reduce Credit Cards; jetBlue reduces Primary Checking; 14-day schedule for Primary Checking lists jetBlue Oct 12 | PASS (logic and live data; the page itself not rendered) | Live: `cardPaymentEvents` 14-day for jetBlue -> Primary Checking `2026-10-12 -51.26`; Credit Cards analysis: balance 499.09, min 250, first dip 543.59 on Oct 12, peak 3,458.50 on Nov 5 (hand-checked: 499.09-792.68=-293.59; -293.59-2914.91=-3208.50) |
| AC3 | Funding account undetermined (fewer than 2 matches) -> card assigned to no account, named in muted notice, still in ledger | PASS | Oracle fuzz of `inferFundingAccount` (2000 cases), `cardPaymentEvents` = [] and `toLedgerCardInputs` still returns estimates; page note read in `app/forecast/page.tsx` (not rendered) |
| AC4 | Ledger: paid on-file statement leaves pastDue and shows a "paid" line; unpaid past-due keeps wording changed only where the check ran; totals count estimates and report `outflowEstimated`; entity scoping unchanged | PASS | HEAD differential 600+200 random card inputs byte-equal; 800-case oracle fuzz; live: Personal outflow 18,481.38 incl. 3,559.36 estimated, Capital One only in EK Consulting and ALL, Barclay Oct 5 in `paidCards` |
| AC5 | No double count; card payment neither transfer nor learned recurring | PASS | Recurring regex vs HEAD copy: the Coder's 3 new-descriptor tests FAIL against HEAD's regex (so they are meaningful); my fixed-amount series test (barclays, barclays bank delaware, barclaycard, crcardpmt, autopay pymt, amex epayment, citi card payment) not suggested, six ordinary bills still suggested; live `detection.suggestions` (18) contains no card payment |
| AC6 | Notifications: no Barclay overdue when paid; shortfall includes Capital One when paid from the funding account; low estimates never trigger; no "minimum payment" text | PASS | 14 tester notification tests + Coder's; 13 notification mutants (see below) |
| AC7 | `list_accounts` has no `minimumPayment`; Accounts page no `ccMinimumPayment`; guard passes | PASS | Whole-tree Grep: only `prisma/schema.prisma`, `lib/plaid-sync.ts`, `lib/doc-extract.ts`, `prisma/migrations`, tests, a doc comment in `lib/forecast.ts:450`. Guard mutated 8 ways (term added to 8 guarded files) -> failed every time |
| AC8 | Estimator never fabricates | PASS | 2500-case fuzz: gates return reasons and zero estimates; open-cycle amount exactly balance minus unpaid on-file statement; `cum <= 0` -> no item; stale balance (4 days) -> none |

### Requested rigor list

1. detectStatementPaid: PASS. Independent oracle, 3000 random histories (pending/outflow rows, refunds with matching outflows, partial, two partials, overpay, +-1 cent tolerance, statement 0/negative, window edges due-21 / due-22 / today / tomorrow, previous cycle's payment) agree. Documented rule 2: a non-payment-like inflow >= the statement with a same-cent outflow at -1..+5 days counts as paid (plan-specified, see Notes).
2. Next-statement estimator: PASS. Confidence thresholds pinned at exactly 3 and 10 days; balance age 3 passes / 4 fails; $5 reconcile passes / $5.01 fails; 59/60 day history; 1/2/3 payments; split payments (rows within 7 days) are one payment; typical month = median of last 3 with range from last 6, always low; no double count (estimate + unpaid statement == balance, property-tested).
3. Funding inference: PASS. Oracle fuzz; jetBlue -> Primary Checking and Barclay/Capital One -> Credit Cards (6/6 each) on live data. Grep for hard-coded "Credit Cards": see D1 (advisor tool); everything else is a comment, tests or seed data.
4. Forecast/funding integration: PASS. `analyzeCardFunding` equals HEAD for 500 random inputs when `otherFlows`/estimates are absent; with flows/estimates a 1000-case independent running-sum oracle agrees on daily balances, status, first-dip shortfall, peakShortfall (true low point), `estimatedTotalDue`. Ledger path equals HEAD (600 + 200 cases). Recurring detection (see AC5).
5. Notifications: PASS. Paid -> neither reminder (due in 2/1/0 days) nor past-due alert (-1/-4/-10 days); unpaid past-due text has no "unpaid"/"interest"/"accru"; scope keys `cc_funding:<accountId>:short|risk` and `card_overdue:<card>:<date>` unchanged and an alert already sent today is not repeated; two paying accounts give two alerts with different keys, each naming only its own cards; projection failure (`error: true`) sends nothing; low estimate never notifies, medium/high do; horizon exactly [today, +30d).
6. Minimum payment cleanup: PASS (AC7).
7. Separation / honesty: PASS. Capital One keeps entity EK Consulting on every projection, ledger row and funding due; notification entity is the funding account's; loaders use explicit `select`s and `findMany` only (asserted at the db boundary); a DB failure logs `err.name` only (asserted); no account numbers in any text (funding card shows the pre-existing `x<mask>`).
8. Untouched files: PASS. `git status` shows nothing under `prisma/`, `data/`, `specs/`, `actions/`, `lib/tax*`; the two other untracked files (`pnpm-workspace.yaml` Sep 11, `scripts/setup-eva-account.ts` Oct 1) pre-date this task. Line endings: all 17 modified files are uniformly LF or uniformly CRLF (no mixed); original per-file endings cannot be proven because HEAD blobs are LF-normalised (`core.autocrlf=true`), but they match the family pattern (older files CRLF, agent-written lib files LF).

## Tests run (real output, excerpts)

- `pnpm typecheck` -> `tsc --noEmit` clean (before and after my tests were added; I fixed 2 TS errors in my own diff test before the final run).
- `pnpm lint` -> `✖ 52 problems (0 errors, 52 warnings)` (same 52 as the Coder; none in the task's files; my files lint clean via `npx eslint lib/__tests__/card-full-pay-tester-*.test.ts`).
- `pnpm test` (Coder's state, before my tests): `Test Files 437 passed (437)`, `Tests 12318 passed | 8 skipped (12326)` (matches the Coder's claim exactly).
- `pnpm test` (final, with my tests): `Test Files 442 passed (442)`, `Tests 12381 passed | 11 skipped (12392)`. The +3 skipped are my HEAD-differential tests (they run only when `UL_OLD` / `CF_OLD` point at HEAD copies).
- HEAD differentials, run with temporary HEAD copies in `lib/zz-tester-old/` (created from `git show HEAD:...`, deleted afterwards): `UL_OLD='@/lib/zz-tester-old/upcoming-ledger' CF_OLD='@/lib/zz-tester-old/cc-funding' npx vitest run lib/__tests__/card-full-pay-tester-diff.test.ts` -> 10 passed, 0 skipped; also the existing `recurring-detect-tester-ledger.test.ts` + `upcoming-ledger-tester.test.ts` with `UL_OLD` -> 106 passed.

### Mutation checks (temporary copies via vitest alias config; real source never edited; all `zz` files deleted)
99 mutants over `card-next-statement.ts` (67), `cc-funding.ts` (8), `upcoming-ledger.ts` (11 new-path), `notifications.ts` (13): constants, comparison boundaries, sign flips, gate removals, paid/unpaid inversions, scope-key and entity changes.
- Killed by the Coder's tests: 75.
- Survived the Coder's tests, killed by mine: 20 (paid window 28, window-start exclusivity, `autopay` text, refund text counted as payment, rule-2 amount floor and future-outflow, ambiguous payment used, $4/$6/`<=` reconcile tolerance, error flag ignored, scope key without account id, horizon 45, only-last-account counted, plus after I added tests: paid statement still scheduled / still a funding due, due-today boundary, tight-cushion alert silent, payload `estimated` flag, notification entity).
- Survivors: 4, all equivalent (statement-age 46 / `>=` is subsumed by the "next due in the past" check which gives the same reason text; the explicit tie rule is implied by the 2/3 rule; `uniquifyIds(paidCards)` cannot collide on real input).
- Guard test mutated (8 files): failed every time.

## Live read-only checks (temporary scripts in the scratchpad, no writes, no notification dispatch)
Today 2026-10-09.

| Card | Funding (matches) | On file | Estimates |
|---|---|---|---|
| Barclay | Credit Cards 6/6 | due Oct 5 $623.19 PAID (payment received Oct 4, rule payment_inflows) | Nov 5 $2,914.91 high (2 days to close, "could reach about $3,005"); Dec 5, Jan 5 $623.19 low (median of last 3; last 6 ranged $521 to $3,290) |
| Capital One | Credit Cards 6/6 | due Oct 12 $792.68 unpaid | Nov 12 $72.56 medium (9 days to close, up to ~$180); Dec 12, Jan 12 $167.93 low |
| jetBlue | Primary Checking 6/6 | due Oct 12 $51.26 unpaid | Nov 12 $21.26 medium; Dec 12, Jan 12 $46.26 low |

Ledger (60 days): Personal = jetBlue Oct 12 scheduled; Barclay Nov 5, jetBlue Nov 12, Barclay Dec 5 estimated; Barclay Oct 5 in `paidCards` (0 past-due); outflow 18,481.38 incl. 3,559.36 estimated. EK Consulting = Capital One Oct 12 scheduled + Nov 12 estimate. ALL has both. No card payment appears among the 26 learned/18 suggested recurring series. Bank texts that pay cards: `barclays` / `barclaycard us creditcard` / `capital one crcardpmt` (one same-amount `netflix` noise row on Primary Checking is correctly ignored).
Funding analysis (30 days): Credit Cards shortfall $543.59 first dip Oct 12, peak $3,458.50 Nov 5 (identical with `minConfidence` low or medium because the only estimate in the window is high). The real notification body that this produces once deployed:
"The Credit Cards account has a current balance of $499.09 and the Capital One has a statement due balance of $792.68 ... Barclay has an expected statement payment of about $2,914.91 on November 5 (an estimate based on this cycle's charges so far; ...). ... Please transfer $543.59 ... The balance keeps falling after that: covering every payment through November 5 takes about $3,458.50 in total. Estimated amounts are not final until the statements are issued." Primary Checking: covered.

### Backtest re-done (owed series rebuilt from posted rows anchored on today's balance; close = due - lag; mean abs % error, worst in brackets)

| Estimator | Barclay | Capital One | jetBlue | Plan table |
|---|---|---|---|---|
| last statement | 67% | 142% | 228% | 67 / 142 / 228: reproduced |
| cum at close, lag 25 (implemented) | 45% (225%) | 11% (29%) | 0% | plan 0 / 15 / 0 |
| cum at close, best-fit lag | 0% (1%) at lag 27 | 18% (42%) at lag 26-27 | 0% | |
| cum, 10 days before close | 8% (34%) | 43% (75%) | 0% | plan 8 / 50 / 0: reproduced |
| cum, 20 days before close | 26% (66%) | 74% (92%) | 0% | plan 46 / 87 / 23: same direction (under) |

n is 3-5 per card, one household: indicative only (as the plan says). The one non-reproducible entry is Barclay "within $3 at close": it holds only at close lag 27; at the implemented 25 the latest cycle is 225% off because a ~$1,400 charge posted between the 27-day and 25-day close. Today's Barclay estimate is unaffected (balance is the whole cycle either way).

## Tests added
All new files are tester-named and pass; none edits source.
- `lib/__tests__/card-full-pay-tester-pure.test.ts` (33): independent-oracle fuzz of `detectStatementPaid` (3000), `inferFundingAccount` (2000), `projectCardStatements` gates/amount/confidence (2500); boundary tests (window edges, 3/10 days, balance age, $5, 59/60 days, 1/2/3 payments, split payments); `cardPaymentEvents` / `cardDuesInWindow` drop a paid statement and window `[from,to)`; due-today boundary; recurring detection of card descriptors vs ordinary bills.
- `lib/__tests__/card-full-pay-tester-diff.test.ts` (10, 3 skip without env): HEAD differential for the ledger (800 cases) and `analyzeCardFunding` (500); 800-case ledger oracle (paid cards leave items/pastDue/totals, estimates counted once per in-window in-scope row, `outflowEstimated` exact, ids unique, scoped == aggregate filtered); 1000-case funding oracle (flows, peakShortfall, estimatedTotalDue); message wording fuzz; forecast helpers (`generateCardEstimatePayments`, `monthlyDueDates` day 29-31).
- `lib/__tests__/card-full-pay-tester-notify.test.ts` (14): multi-account alerts and scope keys, no repeat after an alert today, deeper second dip wording, low estimate ignored, horizon edge, `error: true`, tight cushion, payload flags, funding account's entity, paid reminders/overdue, honest overdue wording, other card's projection not suppressing.
- `lib/__tests__/card-full-pay-tester-loader.test.ts` (7): `loadCardProjections` / `loadScheduledFlows` at the db boundary (Barclay and jetBlue end to end, read-only, explicit selects, 200-day NY window, fail-soft with `err.name` only, entities preserved).
- `lib/__tests__/card-full-pay-tester-advisor.test.ts` (2, one `it.fails`): pins D1; flip to a plain `it` when fixed.

## Defects found

**D1 (Medium, blocking per the requested "no hard-coded 'Credit Cards' anywhere" check): advisor `get_forecast` still hard-codes the card funding account and ignores paid statements and estimates.**
Repro: `Grep` for `CARD_FUNDING_NICKNAME` -> `lib/advisor/tools/get-forecast.ts:22` (`= "Credit Cards"`), used at `:37` and `:64-70`; run `npx vitest run lib/__tests__/card-full-pay-tester-advisor.test.ts` (first test shows a jetBlue-like card is drawn from "Credit Cards" instead of Primary Checking). Its loader (`lib/advisor/queries/forecast.ts:108`) also reads only personal-entity cards, so Capital One (paid from Credit Cards) is missing, and no estimated statement (Barclay Nov 5 $2,914.91) or paid-statement check is applied. Expected: the same account/amounts as the Forecast page (inferred funding, paid dropped, estimates labelled) or an explicit documented exclusion. Actual: the advisor's "projected minimum balance" for Credit Cards omits roughly $3,000 of payments the page now shows, and attributes jetBlue to the wrong account. The existing advisor test `advisor-tools-business.test.ts:325` pins the old behaviour. Not in the plan's file list, but it contradicts the task's purpose and the requested check.

**D2 (Low): an existing unit test now talks to the real database.** `lib/__tests__/recurring-detect-tester-loader.test.ts` mocks `loadUpcomingLedgerInput` but not the new `loadCardProjections` call inside `loadUpcomingLedger`. Repro: copy that test, run with `DATABASE_URL=postgresql://x:y@127.0.0.1:1/z` and read `console.error` calls -> `Card statement projections unavailable PrismaClientInitializationError` (~2 s wait). With the real `.env` it performs the loader's read-only SELECTs against the live DB; the test passes either way because the loader is fail-soft. Fix: `vi.mock("@/lib/card-next-statement-build", ...)` in that test.

**D3 (Low, plan/accuracy note):** (a) the plan text calls the Capital One and jetBlue Nov 12 estimates `low`; the implementation (by the plan's own thresholds) says `medium` and the Coder documented it; I confirm the arithmetic. Medium is mildly optimistic for Capital One because its close lag (15-32 days in the fit) is an unpinned assumption, and medium estimates can feed funding notifications (today $72.56, immaterial). (b) `CLOSE_LAG_DAYS = 25` for every card makes the plan's "Barclay within $3 at close" claim non-reproducible (see backtest); the "high" label can over-include a few days of charges that fall after the true close. Not a code defect.

**D4 (Low):** `loadScheduledFlows` (called inside `checkCcFundingShortfall` per funding account) is not fail-soft; a database error there rejects the cron route's `Promise.all`, which returns 500 and skips `dispatchPending()` for notifications that other checks had already created in that run. Same class as every other DB call in that function (so not new in kind), but a new throw site. Read from `app/api/cron/notifications/route.ts:25-47`; not executed.

**D5 (Cosmetic):** `lib/upcoming-ledger.ts` has `const inWindow =(d: Date) => ...` (missing space, introduced by this change).

## Notes (judgement calls, not defects)
- Rule 2 of paid detection (plan-specified): a non-payment-like inflow >= the statement plus a same-cent outflow -1..+5 days counts as paid, so a merchant refund exactly equal to a statement AND an identical bank outflow would be called paid; a refund alone never is.
- The loader caps bank-side amount lookups at 400 distinct amounts in unspecified order (a card with a very large number of distinct credits could lose recent payment amounts; failure direction is "not paid / not determined").
- Monthly anchor drift: if Plaid's on-file due date was already clamped (e.g. Feb 28 for a day-31 card), later estimates use day 28 until Plaid refreshes.
- Expect the funding-shortfall notification to fire right after deploy (Credit Cards $499.09 vs Capital One $792.68 on Oct 12 and the Barclay Nov 5 estimate); the Coder already flagged it. Wording is observational and honest.

## Not tested / could not verify
- The rendered Forecast page and Upcoming agenda (no browser, no DOM test env; `app/forecast/page.tsx` is a DB-bound server component). Verified by reading the diff plus running the same functions it calls on live data. The Coder's list of visual checks (section "Needs human visual verification" in 02-implementation.md) still stands.
- `pnpm build` / `next build` (not run: touches the shared DB and is flaky here, same as the Coder).
- Real notification dispatch (forbidden; only function-boundary tests and message-building on live data).
- Statistical accuracy of the estimator beyond 3-5 cycles per card.
- Original per-file line endings of the 17 modified files (only uniformity checked).

---

# Re-test (round 1)

## Verdict: PASS

D1-D5 are fixed and independently verified. No blocking defect remains; four low-severity observations are listed at the end (none changes the verdict).

| Item | Result | Evidence |
|---|---|---|
| (a) typecheck / lint / full suite | PASS | `pnpm typecheck` clean; `pnpm lint` `52 problems (0 errors, 52 warnings)` (same 52 as before; my files lint clean with `npx eslint lib/__tests__/card-full-pay-tester-*.test.ts`); `pnpm test` with `DATABASE_URL`/`DIRECT_URL` = `postgresql://x:y@127.0.0.1:1/z`: `Test Files 444 passed (444)`, `Tests 12419 passed \| 11 skipped (12430)`; 0 output lines matching PrismaClient / "Card statement projections" / "Scheduled flows unavailable" / P1001 / ECONNREFUSED, so no test reaches a database. (The Coder's own run was 443 files / 12,402 passed; the difference is my new tests. One run of mine died with `spawn node.exe ENOENT`, an environment glitch of the same kind as the transient ENOENT seen earlier; a clean re-run passed.) |
| (b) Edits to my test files | LEGITIMATE (one weakness found and repaired) | see below |
| (b) `inferCloseLag` verification | PASS | independent rule oracle (1500 histories), truth-recovery and false-positive fuzz, 31 mutants all killed after added tests |
| (c) D1 advisor `get_forecast` | PASS | see below; live comparison with the Forecast page logic |
| (d) D4 `loadScheduledFlows` fail-soft | PASS | see below |
| (e) D5 typo | PASS | `const inWindow = (d: Date) => ...` (line 907); `lib/upcoming-ledger.ts` still CR=LF=1778, `notifications.ts` 1028/1028, `forecast.ts` 550/550, `app/forecast/page.tsx` 1269/1269, `CLAUDE.md` 123/123 (no mixed endings) |
| (f) live + backtest with the inferred lag, accuracy claims | PASS (with the in-sample caveat below) | see below |
| (g) prisma / tax code | PASS | `git status` shows nothing under `prisma/`, `data/`, `specs/`, `actions/`, `lib/tax*`; no `zz` files, scripts or configs left in the repo |
| D2 (non-hermetic test) | PASS | `recurring-detect-tester-loader.test.ts` now mocks `@/lib/card-next-statement-build`; the whole suite against an unreachable DB shows no DB access |
| D3 (errata, lag inference) | PASS | plan errata read and correct (9 days = medium; the 0% was lag 27); no accuracy claim in code, UI or CLAUDE.md (grep for accura/backtest/within $: only a comment saying "No accuracy is claimed" and one comment pointing at the pipeline folder) |

## (b) The Coder's edits to my test files, judged against the rule (re-derived, not copied from code)

The rule: close = due - lag; lag inferred only when the card's own history pins it (>= 3 conclusive cycles within +-1 day, >= 2 narrow, none disagreeing, amounts within $5), otherwise 25 days is assumed and confidence is capped at medium; then high <= 3 days, medium <= 10, else low.
- `card-full-pay-tester-pure.test.ts`, two boundary expectations high -> medium: legitimate. Those random-history cards cannot pin a lag, so the assumed lag caps "2 days to close" and "3 days to close" at medium by the rule; 4 and 10 days (medium) and 11 (low) are unchanged. Re-derived by hand: on-file Oct 5 -> next due Nov 5 -> close Oct 11 -> 2 days; on-file Oct 6 -> 3 days; both medium when the lag is assumed.
- Same file, confidence oracle: the Coder's edit read `closeLagInferred` / `closeLagDays` from the code's own output, which made the oracle partly circular (it would accept a wrongly claimed inference). I strengthened it: the random-history fuzz now asserts `closeLagInferred === false` and `closeLagDays === 25` (false-positive control), and the high / 3 / 4 / 10 / 11-day boundaries are tested on lag-pinned histories in the new lag file.
- `card-full-pay-tester-loader.test.ts`, Barclay end-to-end now `medium`: legitimate (that fixture has six payments but no consistent statement cycles, so no lag can be inferred); the nullable return of `loadScheduledFlows` is handled with `!`.
- `card-full-pay-tester-advisor.test.ts`, first test rewritten and `it.fails` flipped to `it`: legitimate. The old first test pinned the defect (card drawn from "Credit Cards"); the new one asserts jetBlue is drawn from its inferred Primary Checking and uses the new `cardProjections` input shape. The source scan (`not.toMatch(/CARD_FUNDING_NICKNAME|"Credit Cards"/)`) now passes as a plain test, which is the D1 acceptance. I also removed the stale defect-probe header comment.

### `inferCloseLag` verification (new file `lib/__tests__/card-full-pay-tester-lag.test.ts`, 14 tests)
- Independent re-implementation of the stated rule compared on 1500 random synthetic histories (true lag 15..32, anchors 1/5/12/28/31, sparse to dense, payment noise): identical answers on all (>150 inferred, >150 null).
- Known-lag generator: dense charges recover the exact lag for every lag 15..32 and anchors 5/12/31; sparse charges (1500 histories) never infer a lag more than 3 days from the truth and often return null; one cycle on a different consistent lag makes the answer null; $5 fits, $5.01 does not; 2 cycles never infer; pending payments are ignored.
- Mutation: 31 mutants of `inferCloseLag` and its wiring (tolerance 4/6, min cycles 2/4, narrow 1/3 and size 3/6, lag range, contradictions allowed/ignored, exact-only and +-2 agreement, tie rules, history-reach check, duplicate-payment handling, attach distance, payments counted as charges, empty fit sets, window bounds, pending rows, confidence cap removed, inferred flag/lag/text, anchor day hard-coded). The Coder's suite killed 19; the other 12 survived it and are killed by my tests, 5 of them (history reach, duplicate payment, attach distance 12 days, pending rows, hard-coded anchor) only after I added targeted 3-cycle tests. Final: 31/31 killed.
- A finding from the fuzz worth knowing: chance fits happen (about 5% per cycle that an unrelated candidate lag lands within $5 of a ~$7,000 statement), so a cycle that really disagrees can look like it agrees within the +-1 day tolerance. The rule survives this because every conclusive cycle must agree, but it is why a "corrupted cycle" test has to exclude such coincidences.

## (c) D1: advisor `get_forecast`
- Read: `lib/advisor/tools/get-forecast.ts` and `queries/forecast.ts`: no `CARD_FUNDING_NICKNAME`; cards come from the shared `loadCardProjections`; every `findMany` in `queries/forecast.ts` still has an explicit `select` (the new `entity.findMany` selects `id, name`); no writes; the registry/tool-count and exclusion guards pass unchanged in the full suite.
- New tester tests (5 in `card-full-pay-tester-advisor.test.ts`): a paid on-file statement is absent; estimates carry `estimate: true` and "(estimate)"; the other-entity card is labelled "(Eric Kinniburgh Consulting, LLC card)" and own-entity cards are not; each card sits on its inferred account only; an undetermined card with something to pay is listed in `cards_without_paying_account` (an undetermined card with nothing to place is not); balance math equals 1000 - 792.68 - 2914.91 - 72.56; account filter; horizon; load-failure note; the 60-event cap sets `events_truncated` and `event_count` while the balance projection still includes the dropped events. 9 mutants of the builder: 7 killed by the Coder's tests, 2 by mine (card events beyond the horizon; unassigned list including paid-only cards, killed by a case I added).
- Live read-only comparison with the Forecast page logic (`cardPaymentEvents` per account over 90 days): every card event the advisor shows is on the page (0 extra). The 4 page events missing from the advisor list are the far-out low-confidence typical-month estimates (Barclay Dec 5 and Jan 5, Capital One Dec 12, jetBlue Dec 12), dropped by the 60-event cap (146 events in total, `events_truncated: true`, `event_count: 146`). They remain in the balance projection, so Credit Cards shows a minimum of -$4,695.37 on 2027-01-05 with 87 breach days, the same as the page chart.
  Shown: Capital One Oct 12 -792.68 (labelled, Credit Cards), jetBlue Oct 12 -51.26 (Primary Checking), Barclay Nov 5 -2,914.91 (estimate), Capital One Nov 12 -72.56 (estimate), jetBlue Nov 12 -21.26 (estimate). No Barclay Oct 5.

## (d) D4: `loadScheduledFlows` fail-soft
- Returns `null` on any error, logs `err.name` only, never rejects. `notifyFundingAccount` returns 0 for that account when flows are null (that account's alert is skipped this run); other accounts still alert; the scope key is unchanged, so no storm; the cron route (`Promise.all` then `dispatchPending`) is untouched.
- Mutants: logs the full error, returns `[]` on error (treated as "no inflows"), missing `await`, null flows analysed as none, null flows aborting all accounts: all 5 killed by the Coder's tests.

## (f) Live re-run (read-only, 2026-10-09)
- Barclay: funding Credit Cards, Oct 5 statement paid Oct 4; Nov 5 estimate $2,914.91, `high`, 0 days to close, lag 27 INFERRED ("from your past statements"). Capital One $72.56 and jetBlue $21.26 on Nov 12: lag 25 assumed, 9 days, `medium`, text says "(assumed 25 days before the due date), so more may post". Funding unchanged (Barclay and Capital One -> Credit Cards; jetBlue -> Primary Checking).
- Backtest with the inferred lag: Barclay at lag 27 is 0% (worst 1%) in-sample on 5 cycles, as the Coder reports.
- In-sample risk, checked by hold-out: inferring the lag only from rows available well before each cycle (due - 32 days) and predicting at that lag. Barclay needs three conclusive cycles, so only the Sep and Oct cycles can be tested out of sample; both infer 26 (not 27). Sep: 0% error. Oct: the 1-day lag error moves a ~$956 charge across the close, so the prediction is $1,579 against $623 paid (153%). Capital One and jetBlue never meet the rule (lag stays assumed, medium cap). Conclusion: one honest out-of-sample bad miss from a +-1 day lag error. The code claims no accuracy and labels the lag source, but "high" for Barclay should be read as "the close date is believed to be now", not as precision.

## Observations (none blocking)
1. The rule accepts a lag within +-1 day of each cycle's fit, so the inferred lag can be off by one day (hold-out above); a large charge on the boundary day changes the estimate a lot. The text says "based on this cycle's charges so far" and "could reach", and shows the lag source; acceptable.
2. When `loadScheduledFlows` keeps failing, funding alerts for that account are silently suppressed (only a log line). Safer than a possibly false shortfall, but silent.
3. The advisor's 60-event cap drops the far-out typical-month estimates from the event list (flagged by `events_truncated` / `event_count`), while the balance projection counts them.
4. Credit Cards projects to -$4,695 by Jan 5 on the advisor and the page because low-confidence typical-month estimates are counted by owner decision (Q2); unchanged and labelled.

## Tests added or changed in this round (all tester-named)
- NEW `lib/__tests__/card-full-pay-tester-lag.test.ts` (14).
- EXTENDED `card-full-pay-tester-advisor.test.ts` (now 5 tests) and `card-full-pay-tester-pure.test.ts` (lag false-positive assertions in the random-history fuzz).
- The temporary mutation runner, alias configs and live scripts were in the scratchpad or `lib/zz-*` and are deleted (`git status` shows no leftovers).

## Not tested (unchanged)
Rendered pages (no browser), `pnpm build`, real notification dispatch, accuracy beyond 3-5 cycles per card.
