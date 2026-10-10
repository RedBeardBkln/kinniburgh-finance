# Test report, STEP 2 (seasonal energy model v0 + oil price + McCarthy marks)

**Verdict: FAIL** (one blocking defect, D1: an owner "Not heating oil" mark on a pending bank row is lost when the row posts. Everything else in the brief passes. No other blocker.)

Tester run 2026-10-10 against HEAD 62d79c5 + the uncommitted step 2 working tree. Nothing staged or committed, no source or Coder test file edited by me, every live check read-only (SELECT only, temporary repo-root scripts, all deleted; `git status` shows no `zz-*`, no `vitest.zz.config.ts`, no stray `_x.ts`).

## Acceptance checklist

### (1) lib/seasonal-energy.ts model

| Check | Result | Evidence |
|---|---|---|
| Gated result carries NO number (keys pinned) | PASS | electric, oil, firewood gated objects are exactly `{status, kind, reason}` (my oracle fuzz asserts the key set on every gated world: ~1,000 gated electric worlds + ~1,700 gated oil worlds) |
| Electric = net dollars by season, heating Nov-Mar / other Apr-Oct | PASS | 3,000-world BigInt-rational oracle (independent of the Coder's code): every month's estimate, low, high, own-observation count, annual, confidence equal the code; >300 estimate and >300 gated worlds; mutants "March not heating", "October heating", "k=2", "sign flipped" killed |
| Credit / near-zero months kept as data | PASS | tested: a -$12 month and a $0.00 month are observed and used; net-credit month yields no outflow event (plan month null) |
| Only payments on/after 2023-03 for the Personal house | PASS | boundary test: 2023-02 dropped, 2023-03 kept (mutant `<=` killed); Sudden Valley has `solarLiveFrom: null` |
| Gate: 6 different months, >=2 per season, newest within 90 days | PASS | boundary tests: exactly 90 days passes, 91 gates; 5 months gates, 6 passes; 1 heating month gates; 5 heating + 1 other gates. 36-month window and future payments pinned (mutants killed) |
| Confidence low until every calendar month seen (medium then, high at twice) | PASS | oracle + mutants `high needs only 1`, `medium on any` killed |
| Live 12-month Personal table recomputed from raw rows by my own SQL | PASS, exact to the cent | my SQL (Personal entity, payee ~ eversource or Electric tag, since 2023-03, net per month): 2025-11 235.66, 12 445.42, 2026-01 665.09, 02 583.22, 04 63.60, 05 161.51, 08 41.49, 09 247.89. Heating mean **482.35**, other **128.62**. Months Jan..Dec: 573.72, 532.78, 482.35, 96.11, 145.07, 128.62, 128.62, 85.06, 188.26, 128.62 (Oct), 359.00, 463.88. Annual **3,312.09**. The real loader (`loadSeasonalEnergy`) returns the same |
| Leave-one-out $145.26 vs flat $195.84 | PASS | my own SQL-fed leave-one-out: n=8, model 145.26, flat 172 = 195.84; also pinned in a test from the 8 raw payments |
| Oil needs >=2 owner prices 6+ months apart | PASS | oracle (3,000 worlds, each gate branch >20), month-end clamp cases (Aug 31 -> Feb 28 passes, Jan 31 -> Jul 30 gates), future-dated price not in force |
| Every counted payment on/after the first price, else gated naming the date | PASS | fuzz asserts the reason contains a YYYY-MM-DD; render test: first price 2026-02-01 gates and says "Enter the price in force on or before 2025-12-02" |
| Trailing 12 months restated at today's price, spread evenly; +$0.50/gal sensitivity | PASS | oracle on a high-precision Decimal clone: annual, monthly, sensitivity, as-paid equal in every estimate world; mutants (inverted restate, monthly from as-paid, step 1.00, 366-day window) killed |
| Yearly furnace service $292.46 excluded | PASS | exact-cents rule: 29246 excluded, 29245 and 29247 counted; Sudden Valley has no service amount; live: 2025-10-31 (EK card) and 2026-09-11 left out, suggestion shown |
| Firewood always gated | PASS | code + view-model tests (live: 2 purchases, 1 season) |

### (2) McCarthy handling

| Check | Result | Evidence |
|---|---|---|
| Personal house reads the 3 EK-card McCarthy rows, labelled "charged by mistake" | PASS | live: Dec 2 2025 $679.65, Jan 26 2026 $1,225.25, Feb 9 2026 $67.10 are in Personal's oil history flagged `[EK]`; card text "paid on the Eric Kinniburgh Consulting, LLC card by mistake; read here, nothing changed" (render test) |
| Sudden Valley never receives another entity's rows; Personal never reads Sudden Valley's | PASS | 2,000 random ledgers over 5 entities (incl. null slug): the only cross-entity read is Personal <- EK, McCarthy-heating-oil payee, oil kind. Loader test: SV with its own oil row stays separate, prices and marks are per entity. Mutants (SV reads EK, any entity, any kind) killed. Live SV: 5 Eversource months, 0 oil payments |
| $1,036.75 Oct 9 Barclay furnace repair untagged, listed under "Check these McCarthy charges", counted until marked | PASS | live loader: listed ("not tagged Utilities / Oil"), included in the $7,514.63 as-paid total (12 counted payments); render test: marking it moves it to "Left out of the oil history" with "Count it again" and drops the total by exactly $1,036.75 |
| No ids / amounts hard-coded | PASS with note | repo-wide grep (source, not tests): no transaction id, no 1,036.75, no Barclay-specific code. The ONLY amount is `serviceCharges: [{cents: 29246}]` in `ENERGY_SITE_FACTS` (owner answer 4). Note: any other charge of exactly $292.46 would be classed as service |
| `setMcCarthyNotOil`: requireAuth first | PASS | anonymous / user-less session rejected before any db call; mutant "no auth" killed |
| validates exists, not archived, McCarthy payee, site or EK-for-Personal | PASS | 13-pair site x owner matrix (5 allowed, 8 refused incl. SV<-Personal, SV<-EK, Personal<-SV, EK<-Personal); lookup carries `archivedAt: null`; archived site/owner entity refused; non-McCarthy payees refused; malformed ids refused before lookup |
| Saves ONLY ids in `oil_not_heating:<entityId>`, cap 200, idempotent both ways | PASS | stored value is a JSON array of id strings (payee/phone text absent); cap 200 refuses a 201st, no-op success for an id already there, removal at cap works; second mark / second unmark writes nothing and no audit row; corrupt stored list never overwritten; AuditLog `after` keys exactly `entityId, transactionId, entries` |
| Marked rows excluded from every figure, listed with "Count it again" | PASS | oil facts, estimate gate, as-paid total, check list, UI lists |

### (3) Price actions

| Check | Result | Evidence |
|---|---|---|
| addOilPrice / removeOilPrice requireAuth first | PASS | tested + mutants killed |
| >0, sane upper bound, 2-4 decimals | PASS | 20 invalid strings rejected (empty, "3.", ".5", "1e1", "0x10", "3,5", Arabic-Indic digits, "20.01", "0", "-1", "+3", "Infinity", "NaN", 5 decimals, "1000", "349", inner space) and 11 valid forms stored as decimal STRINGs (3 -> 3.00, 3.4990 kept, $3.50, 20, 20.0000); numeric NaN/Infinity/1e21/1e-7 refused. Dates: real-date check, 2015 floor, today+30 allowed / +31 refused, ISO-with-time and padded strings refused |
| Cap 60, removal only marks removed | PASS | at 60 (half removed) add refused, remove works, list length unchanged, only the one entry gets `removed: true`, all others byte-identical; unknown id errors; corrupt list never overwritten |
| AuditLog ids/counts only | PASS | keys exactly `entityId, entryId, entries`; no price/date/note text |
| Note rules | PASS | 120 ok / 121 refused / control char refused / blank dropped / SSN-like refused |

### (4) Integration

| Check | Result | Evidence |
|---|---|---|
| `generateBillOccurrencesBudgetDated(..., plan)` re-amounts monthly bill events, labels "(estimate)" | PASS | 2,500-world fuzz: every model event has the plan's month amount (negated), description `<payee> (estimate)`, `estimate` mark, inside [from,to), sorted; plan months with null/zero produce no event; weekly/biweekly/quarterly/annual/semiannual static bills unchanged |
| No plan = byte-identical to before | PASS | differential vs `git show HEAD:lib/bill-dates.ts` over 5,000 random bills/indexes/draws/windows: events, keys and order identical, `effectiveSchedule` identical; plus 2,500-world check that plan null / undefined / `{}` options agree and equal the plain generator where it did |
| Hand draws win in range; model only after the last draw's month; no month holds both | PASS | fuzz asserts hand events == plain generator's draw events exactly, every model event >= first of the month after the last draw, no shared month; last-day-of-month draw edge; replaceDraws removes draws only when opted in |
| "No events after last draw" fix only when a plan exists | PASS | HEAD differential (no plan) identical; live: gated Oil/Firewood keep draws only ("Nothing projected after Mar 25, 2027" as documented) |
| Reaches Forecast chart/funding/14-day, account-scheduled-flows, envelope, ledger (tier estimated), Pace, assistant (25 tools) | PASS | code read of all call sites; live (real plan, real bills): Electric (Eversource) events Oct 20 -129 ... Sep 20 -188 with plan vs flat -172 without; Upcoming ledger items "Electric (Eversource) -128.62 / -359 / -463.88" tier estimated "seasonal estimate, low confidence"; all unrelated bills unchanged; Oil/Firewood hand draws unchanged. Assistant tool-count pin passes in the full suite |
| NOT in notification reminders / business forecast / /budgets / dashboard budgets | PASS with doc note | `seasonal-energy*` is imported by none of them (grep). See D3: the dashboard "Next 30 days" widget reads the Upcoming ledger and therefore shows the estimate |

### (5) The deviation (carryVariable: true)

| Check | Result | Evidence |
|---|---|---|
| Intentional per plan | PASS | plan 4.1: "A variable line still carries its flat amount forward (it is the fallback)"; step 1 had deferred it to step 2 |
| Exactly what changes in 2027 months (live, read-only) | listed | any month with no Budget row (2027-01 and later): 59 lines -> 64. Newly carried, all from 2026-12: Personal Electric (Eversource) $172.00 (day 20), Personal Oil $308.00, Personal Firewood $80.00, Sudden Valley Arbor Retreat / Oil $240.00, Arbor Retreat / Electricity $100.00. Entity sums of explicit budgeted: Personal 14,626.58 -> 15,186.58 (+560), Sudden Valley 1,059 -> 1,399 (+340), EK Consulting 1,205 unchanged. Consumers affected: business-bucket forecast (SV +$340/month), assistant budget rows + overview "Total budgeted", Category Spend Pace (Personal, 2027-01+: Electric target = model estimate, Oil/Firewood flat), recurring-expense budget hint, the two Budget notifications (Oil/Firewood/Electric can now raise overspend/pace alerts against the carried figure) |
| One-line revert works | PASS | mutating `carryVariable: true` -> `false` in `resolveLoaded` leaves all seasonal tests green and fails exactly the 9 assertions the Coder rewrote for this decision (3 in budget-carry-forward-build, 3 consumers, 3 tester-consumers); a revert therefore also needs those 9 assertions restored. Pure resolver on live rows with the flag false = 59 lines (step 1 baseline) |
| Failed seasonal-lines setting read now fails the read: no consumer regresses | PASS | consumers: date index (wrapped in its own catch), seasonal loader (Safe wrapper), forecast page business budget + Pace (no catch, but a Budget read error already threw there identically), notifications / advisor / hint / ledger input (already propagated a Budget read error). Same database as the Budget read, so no practical new failure mode; a garbage VALUE still falls back to the default set (tested) |

### (6) UI, loaders, hygiene

| Check | Result | Evidence |
|---|---|---|
| Seasonal bills card renders (tests) | PASS | real `SeasonalCard` server render from a fixture shaped like the live books: electric table/headline/LOO sentence, oil gated text + budget figure, check list with one button per row (count read from the page), EK rows "by mistake", service suggestion, firewood gated, marked-row move, estimate branch with sensitivity, SV gated electric (no solar text, no McCarthy text), gated view-model has headline/basis null and empty table |
| No account numbers | PASS | rendered text contains no digit run of 5+, no phone fragment (the live payee text "860 4432839" never reaches the UI), no uuid in attributes; loader selects account `nickname` only (mask-selecting mutant killed) |
| Observational wording | PASS | no "should/recommend/CPA/accountant"; card says "Not a guarantee, and not advice" |
| Loaders read-only, explicit selects, fail-soft | PASS | no create/update/upsert/raw SQL in the loader; select key set pinned; archived rows, transfer legs, 37-month window, 4000 ceiling (ceiling counts as FAILED, never a silent partial); failure logs only the error NAME (test with a connection-string message, mutant killed) |
| No migration / prisma / tax-code changes | PASS | `git status`: no change under `prisma/`, `lib/tax*`, `lib/tax2025/**`, `lib/tax-review/**`; untracked `pnpm-workspace.yaml` (Sep 11) and `scripts/setup-eva-account.ts` (Oct 1) predate this task |
| Line endings | PASS | `git ls-files --eol`: no mixed endings; new files LF (CR count 0); the 5 files that were CRLF in the working tree (`CLAUDE.md`, `app/forecast/page.tsx`, `actions/envelope.ts`, `lib/upcoming-ledger.ts`, `lib/__tests__/notifications.test.ts`) stay CRLF; the CLAUDE.md Seasonal paragraph is pure ASCII |
| The 8 Coder-changed test files legitimate | PASS | read every hunk: 3 files re-assert behaviour that changed by documented decision D1 (variable lines now carry; setting-read error now throws) with equal or stronger assertions; 4 files add the `appSetting.findUnique` mock that the loader now needs (a missing mock used to be swallowed as "default set"); `recurring-detect-tester-loader` mocks the new seasonal loader so that test cannot reach a real database. No assertion weakened elsewhere |
| Stray `_x.ts` at the repo root | PASS | gone |

## Tests run (real output)

- `pnpm typecheck` -> `tsc --noEmit`, exit 0 (after I fixed a BigInt-literal typing error in my own test file).
- `pnpm lint` -> `51 problems (0 errors, 51 warnings)`, exit 0 (the same 51 as the Coder; none in a seasonal or tester file).
- `npx vitest run` (full, normal env): `Test Files 487 passed (487)`, `Tests 13330 passed | 11 skipped (13341)`, exit 0. (Coder's run: 482 files / 13196 passed; difference = my 5 files / 134 tests.)
- Same with `DATABASE_URL` and `DIRECT_URL` = `postgresql://x:y@127.0.0.1:1/z`: `Test Files 487 passed (487)`, `Tests 13330 passed | 11 skipped (13341)`, exit 0; 0 output lines matching PrismaClientInit / Can't reach database / ECONNREFUSED (so no test touches a real database).
- Mutation testing on temporary copies via a vitest alias config (nothing in `lib/` or `actions/` edited): 86 mutants on `seasonal-energy.ts`, `seasonal-energy-prices.ts`, `actions/seasonal-settings.ts`, `bill-dates.ts` + 18 on the loader and view model + the D1 revert. Identity mutants survived (harness sane). First pass (86 real mutants): the Coder's tests killed 77, my first-draft tests killed 1 more (`bd09`), 8 survived (check-low threshold, caps 61 and 201, id regex, three generator edge semantics, one equivalent). Second file: 18 mutants, the Coder's tests killed 11, 7 survived until I added the loader/render tests. After my added tests every mutant is killed except `bd11` (equivalent: the mutated line is unreachable once `replaceDraws` empties the draws).

## Tests added (all tester-named, no source changed)

- `lib/__tests__/seasonal-energy-tester-oracle.test.ts` (19 tests): BigInt-rational electric oracle (3,000 worlds), oil oracle (3,000 worlds), entity-separation fuzz (2,000 ledgers), gate boundaries, solar boundary, credit months, leave-one-out numbers, month-end clamp, service amount, check-list thresholds (exactly 0.25x / 3.00x not flagged), marked-id hygiene, plus an `it.fails` pinning defect D2.
- `lib/__tests__/seasonal-energy-tester-actions.test.ts` (87 tests): site x owner matrix, archived/non-McCarthy/malformed refusals, stored-value and audit shape, idempotence, literal caps 200/60, price/date/note edge matrix.
- `lib/__tests__/seasonal-energy-tester-generator.test.ts` (9 tests): no-plan equivalence and with-plan invariants on 2,500 random worlds each, plus the three edge semantics found by mutation.
- `lib/__tests__/seasonal-energy-tester-build.test.ts` (7 tests): per-entity prices/marks, opt-in parsing, query shape, ceiling, log-leak, setting-read failure.
- `lib/__tests__/seasonal-energy-tester-render.test.tsx` (15 tests): live-shaped card render.
- One-off (deleted afterwards): HEAD-vs-working-tree differential of `bill-dates.ts` over 5,000 worlds, identical.

## Defects found

**D1 (medium, BLOCKING): an owner "Not heating oil" mark on a pending bank row is lost when the row posts.**
- Cause: marks are stored as Transaction ids. This app's Plaid sync archives a pending row and creates the posted row with a NEW id (`lib/plaid-sync.ts` handles `removed` by archiving and `added` by upsert on the new `plaidTransactionId`; `pending_transaction_id` is declared but never used).
- Evidence (live, read-only SQL): 12 archived pending rows from the last week each have a non-archived posted twin (same account and amount, 0-1 days later) with a different id, e.g. -53.33 `08ee3aba` -> `9e61a0a5`, -168.00 `1a3eda06` -> `af3e4af8`. Three McCarthy rows are pending right now: Oct 8 $1,529.50, Oct 8 $180.80 and the Oct 9 $1,036.75 Barclay furnace repair (the one the owner is expected to mark).
- Repro: on /forecast?bucket=personal click "Not heating oil" on the Oct 9 $1,036.75 row (it is stored under `oil_not_heating:<personalId>`); let Barclay post it and the next sync run. Expected: the posted charge stays out of the oil history. Actual: the pending id is archived, the posted twin has a new id, so it is counted again and reappears under "Check these McCarthy charges" (the stale id stays in the setting and uses a cap slot). Once two prices are entered this adds about $1,037 x (today's price / price when paid) to the restated annual oil figure until the owner notices and marks it again.
- Suggested fix directions (Coder's choice): remember a durable signature next to the id (account + amount cents + payee text + date window) and treat a later non-archived row matching an archived marked row as marked; or exclude pending rows from the figures and the check list until they post; at minimum show a "pending: mark it again after it posts" note on pending rows. Add a test that a marked pending row's posted twin stays excluded.

**D2 (low): the oil basis miscounts other-entity rows.** `otherEntityCount` counts all payments in the window including the yearly service and marked rows, so the basis says "N of the payments sit on another entity's books" with N greater than the number of counted payments. Live: 4 (includes the EK-card $292.46 service of Oct 31, 2025) versus 3 counted. Pinned with an `it.fails` in `seasonal-energy-tester-oracle.test.ts`; flip it to a normal test when fixed (a candidate fix `counted.filter(...)` made the pin fail as expected).

**D3 (low, doc): CLAUDE.md says the dashboard is NOT changed**, but the dashboard "Next 30 days" widget reads the Upcoming ledger, so it now shows the Electric estimate (tier estimated). Reword to "the dashboard budget screens".

**D4 (low): a row the model counts as oil by TAG cannot be marked.** `selectSitePayments` counts any own-entity row tagged `Utilities / Oil` even when the payee is not McCarthy, but `setMcCarthyNotOil` accepts only McCarthy-payee rows. None exists live today.

**D5 (low, observation): no lower sanity bound on the oil price** (0.0001 is accepted, so a 0.35-for-3.50 typo passes and would distort the restated figure about 10x). The plan asked only for an upper bound.

**D6 (low, performance): the seasonal loader runs three times per /forecast render** (page plans, Seasonal card, Upcoming ledger) plus once per funding-analysis account; about 17 sequential round trips, 8.5 s each on this laptop (about 480 ms RTT). Probably fine at production latency; consider one per-request memo.

Pre-existing, not caused by this change: none new found.

## Not tested

- No browser (there is none): the card layout, buttons, "Count it again" click path and the real Server Action write were verified only by server-render tests plus the mocked action matrix. The one real write the Coder asked a human to try (marking the Oct 9 row) was NOT performed (read-only brief); D1 says what to expect after posting.
- The estimate branches of Oil (prices) were verified on synthetic prices only; the live books have none (by design: gated).
- Firewood second-season behaviour (step 3), the history upload, `UtilityUsage` migration: not built, not tested.
- `next build` / `pnpm build`: not run (shared DB, flaky on Windows), same as the Coder.
- Cron / notification paths were checked by code read and the existing mocked tests only (no live notification run).
- Real Plaid pending-to-posted behaviour for the three pending McCarthy rows can only be confirmed when they post; D1 rests on 12 historical pairs plus the sync code.

Files: `D:\Repos\Personal\kinniburgh-finance\lib\__tests__\seasonal-energy-tester-{oracle,actions,generator,build}.test.ts`, `seasonal-energy-tester-render.test.tsx`; this report.


---

# Re-test (step 2 round 1)

**Verdict: FAIL** (one remaining defect in the D1 fix, R1 below; D2 to D6 and S2, S3, S4, N2, N3 all pass). The fix is small and local.

Run 2026-10-10 against the working tree with the round 1 changes. Read-only throughout: SELECT-only live scripts (deleted), no staging, no commits, no source or Coder test edited by me; temporary `lib/zz-*`, `vitest.zz.config.ts` and `zz-tester-*` files are gone (`git status` is clean of them).

## R1 (medium, blocking): the payee compared by the durable-mark matcher is the JOINED descriptor, so the "whole-word prefix" tolerance never works

- Cause: the loader and `setMcCarthyNotOil` both build `payee` as `[payeeNormalized, payeeRaw, description].join(" ")`, and the signature and the matcher compare `payeeKey` of that. A pending row "Mccarthy Heating Oil" becomes the key `mccarthy heating oil mccarthy heating oil`; the posted "Mccarthy Heating Oil Ser" becomes `mccarthy heating oil ser mccarthy heating oil ser`. Neither is a whole-word prefix of the other, so only an identical descriptor inherits a mark. The Coder's unit tests feed single strings, so they never see it.
- Live replay (read-only SQL, real archived-pending rows of the last 150 days; the mark is placed on the pending row and the matcher is run against that account's live rows within +-10 days): 524 pending rows have a posted twin (same account and cents, 0 to 7 days later). **409 (78%) inherit exactly their twin, 115 (22%) do not.** With one descriptor (payeeNormalized, else raw, else description) 460 (88%) inherit; the rest are genuinely different merchant texts (for example "ATM DEBIT BIG Y 5 MYSTIC" becoming "Big Y"). Of the 53 most recent twin pairs: 46 inherit now, 51 would with a single descriptor.
- The McCarthy shapes specifically: the pending Barclay Oct 9 $1,036.75 row ("Mccarthy Heating Oil") posts on Barclay as the identical text (Apr 5 and Jul 8 history), so **the owner's main case does inherit**. The two pending Heating & Electric rows (Oct 8 $1,529.50 and $180.80) read "Mccarthy Heating Oil" while every posted McCarthy row on that account reads "Mccarthy Heating Oil Ser"; a mark on either would NOT carry over when they post. The $180.80 (tagged Home Repair) is a plausible row for the owner to mark.
- Pinned with an `it.fails` in `seasonal-energy-tester-marks.test.ts` ("DEFECT D1b") plus a passing control for the Barclay case.
- Fix: build the signature and matcher payee from ONE descriptor (the first non-empty of payeeNormalized, payeeRaw, description) in the loader (when it makes the `MarkRow`) and in the action's `signatureOf(...)`; keep the joined text only for supplier-kind detection. Optionally also strip digit runs of 5 or more from the key (bank reference numbers vary between pending and posted).

## (1) D1 durable marks: everything else passes

| Requirement | Result | Evidence |
|---|---|---|
| Signature {account, cents, payee key, date}; inherit from same account, same cents, alike payee, +-5 days | PASS (modulo R1) | window edges day 0, +5, -5 inherit and +6, -6 do not; other account, 1 cent more or less, unrelated payee and mid-word prefix all refuse; case and punctuation insensitive |
| Each mark covers at most one row; a row claimed by another mark is skipped | PASS | two identical charges with one mark: exactly one row excluded in either arrival order, deterministic; two marks, two rows; three rows with two marks: two excluded |
| Marking a posted row whose pending predecessor is stored replaces that slot | PASS | length unchanged, old id gone; at the cap of 200 the twin still replaces its slot while an unrelated new entry is refused |
| A live marked row is never taken over by a look-alike | PASS | the look-alike gets its own entry; live row plus look-alike posted: only the live row is excluded |
| "Count it again" removes id and signature | PASS | by own id or by the stale twin; a live look-alike's entry survives |
| Legacy bare-id storage still read | PASS | bare strings and `{id}` are read as marks by id, never inherited, upgraded with a signature on the next click; malformed signatures dropped, unique ids, capped at 200 |
| Cap 200, idempotence | PASS | marking twice and counting twice write nothing the second time |
| Signature never reaches AuditLog | PASS | audit `after` keys are exactly `entityId, transactionId, entries`; no payee, cents, date, `sig` or account id (test, and the mutant "signature into audit" is killed) |
| My own oracle / fuzz of pending -> posted re-id | PASS | 2,500 random worlds (shuffled arrival order, 0-1 day posting delay, descriptor extensions, identical charges, two accounts): never more exclusions than marks, every excluded row is a twin of some marked charge, group-wise exact when descriptors agree. It also surfaced a greedy-assignment limitation (below) |
| Mutation check of the matcher on temporary copies | PASS | 26 mutants of `seasonal-energy-marks.ts` (window 4 and 6, account or cents ignored, claimed rows reusable, one mark covering many rows, no id match, no ordering preferences, live takeover, twin ignoring account, cents or window, no slot replacement, no count-again twin, cap off by one, legacy upgrade, signed cents, duplicate ids, parse cap, punctuation): all killed (25 by the Coder's tests, 1 by mine: empty payees); the identity mutant survived |

Limitation (low, pinned with `it.fails`): the matcher is greedy, not a best overall assignment. Two marks on identical cents whose posted descriptors differ can both pick the same row, leaving one mark without a row. It needs two same-amount charges on one account within 5 days, so it is theoretical.

## (2) Other round 1 items

| Item | Result | Evidence |
|---|---|---|
| D2 count | PASS | live loader: `otherEntityCount` 3 (was 4), basis says "3 of the payments"; `otherEntityRows` keeps the read count for the site note; a mutant re-introducing the old count is killed |
| D3 CLAUDE.md sentence | PASS | "NOT changed: notification bill reminders, the business-bucket forecast amounts, /budgets, the dashboard budget screens (the dashboard 'Next 30 days' widget reads the Upcoming ledger and therefore DOES show the Electric estimate)"; CRLF kept (`git ls-files --eol` shows no mixed endings); the Seasonal paragraph is ASCII |
| D4 any counted oil row markable | PASS | 10-case matrix through the real action: McCarthy on own books with any tag, McCarthy on EK for Personal, and a tag-only own-books row are accepted; Eversource tagged Oil, firewood payee tagged Oil and an untagged non-supplier row are refused; a tag-only row on EK or Sudden Valley for Personal is refused; a McCarthy row on Personal or EK for the Sudden Valley site is refused. Mutants "tag overrides payee kind" and "other entity accepts tag-only row" killed |
| D5 price bounds | PASS | $1.00 and $20.00 accepted; 0.99 and 0.35 refused with "probably a typing slip (for example 0.35 for 3.50)"; 0 and 0.00 refused with the separate "greater than zero" message; 20.01 and 25 refused with the upper-bound message; `addOilPrice("0.35")` stores nothing; mutants min 0.5 and exclusive-min killed |
| D6 once-per-request `cache()` | PASS | `cache` keyed by calendar day around the Safe loader; outside a render (actions, cron, tests) two calls read the database twice and a change between calls is seen by the second; a shared failure returns `{plans: [], failed: true}` on every call, never rejects, logs only strings. Memoisation inside a real Next render is verified by reading only (no Flight renderer in vitest); the Coder's `once` test covers the wiring |
| S2 only medium/high plans reach the funding notification | PASS | `notifiablePlans = plans.filter(confidence !== "low")` in `account-scheduled-flows.ts` only; the Forecast page and envelope still pass all plans; mutants "low plans reach it" and "medium dropped" killed |
| S3 caption | PASS | `carriedCaption` is pure; mutants (no seasonal sentence, shown with no carried rows) killed |
| S4 alert wording | PASS | `budgetAlertNote` appended in `checkBudgetOverspend` and `checkBudgetPace`; an own row without an estimate keeps the old wording; mutants dropping either sentence killed |
| N2 text | PASS | "Prices between your entries are assumed unchanged until the next entry ..." is in the basis (Coder's test) |
| N3 within 20% of $292.46 | PASS | rows within +-20% but not exactly $292.46 are listed with "close to the yearly furnace service amount ($292.46); it may be the next yearly furnace service, not oil" (30% mutant killed); the exact amount stays an exact-cents exclusion; the only survivor `se51` (exact amount also listed) is equivalent because exact rows are never in the counted list |

## (3) Shared test edits

All legitimate; none weakens a guarantee. My `seasonal-energy-tester-actions.test.ts`: the stored shape is now `[{id, sig}]` with an exact-key assertion on `sig` (`a, c, on, p`); the dropped "no payee text stored" assertion is replaced by that exact shape, and the audit assertion (no payee, amount, date or signature in the AuditLog) remains. `seasonal-energy-tester-oracle.test.ts`: the D2 `it.fails` became a normal test and the check-list case now expects the $250 row under N3 (the exact service amount and marked rows are still never listed). `seasonal-energy-tester-build.test.ts` and `seasonal-energy-build.test.ts`: the pinned Transaction select gained `accountId` and `pending` (internal id and flag, no account number) and the other-entity count changed 2 -> 1. `seasonal-energy.test.ts`: otherEntityCount 4 -> 3.

Is a normalised payee key in the AppSetting acceptable? Yes, with a note. It is the same descriptor text that already sits in `Transaction.payeeRaw` and `payeeNormalized`, it is read only server-side (never in the client payload, the audit log or logs), and the account part is an internal uuid, not an account number. Live examples are merchant names ("mccarthy heating oil serv 860 4432839 ct": 860-4432839 is McCarthy's phone). Bank descriptors can carry long reference digit runs (live example "dda purchase ap 12098201 madison tpke e ..."), which could reach an oil row only through the tag-only path (D4); stripping digit runs of 5 or more from the key would avoid storing them and would also improve matching, since they differ between pending and posted. Low.

## (4) Full runs (real output)

- `pnpm typecheck`: exit 0.
- `pnpm lint`: `0 errors, 51 warnings` (the same 51; my one new warning was fixed).
- `npx vitest run`: `Test Files 492 passed (492)`, `Tests 13445 passed | 11 skipped (13456)`, exit 0 (Coder: 490 files / 13400; the difference is my 2 new files and 45 tests).
- Same with `DATABASE_URL` and `DIRECT_URL` set to `postgresql://x:y@127.0.0.1:1/z`: `Test Files 492 passed (492)`, `Tests 13445 passed | 11 skipped (13456)`, exit 0; 0 lines matching PrismaClientInit, Can't reach database or ECONNREFUSED.
- Mutation: 42 mutants this round (26 marks, 2 prices, 4 action, 2 funding, 2 caption, 5 near-service / alert / D2) plus identity mutants; every one killed except the identity mutants and the equivalent `se51`.
- Tests added: `D:\Repos\Personal\kinniburgh-finance\lib\__tests__\seasonal-energy-tester-marks.test.ts` (21 tests, 2 `it.fails` pins) and `seasonal-energy-tester-round1.test.ts` (25 tests).

## Not tested

- Real pending -> posted behaviour of the three pending McCarthy rows (they have not posted; no write was made). R1 rests on the matcher run against 524 real archived-pending / posted pairs.
- React `cache()` memoisation inside an actual Next render (static reading only); browser views of the new caption, the "Pending: the mark carries over" lines and the alert wording.


---

# Re-test (step 2 round 2)

**FINAL VERDICT: PASS.** R1 is fixed and confirmed on the real code path and on live data. No blocking defect remains.

Read-only throughout: SELECT-only live scripts (deleted), no source or Coder test edited by me, no staging, no commits; temporary `lib/zz-*`, `vitest.zz.config.ts` and `zz-tester-*` files are gone.

## (1) My `it.fails` "DEFECT D1b" flip is legitimate

The Coder renamed it "FIXED in Round 2" and made it a plain `it`, and changed its inputs from a hand-built joined string to the single descriptors ('Mccarthy Heating Oil' pending vs 'Mccarthy Heating Oil Ser' posted). That edit is correct: the old test reproduced the production join by hand, which production no longer does, so keeping the joined inputs would have tested code that no longer exists. The real proof is not that unit test but my new real-path test below, which does not hand-build any key. The Barclay control still passes.

## (2) Real code path: action -> stored AppSetting -> loader -> `buildSiteEnergy`, all three text columns populated

New `lib/__tests__/seasonal-energy-tester-round2.test.ts` (7 tests) over a stateful mocked database (the action writes the setting, the loader reads it back, rows are swapped from pending to posted with new ids):

- The three live pending shapes: Barclay Oct 9 $1,036.75 ("Mccarthy Heating Oil" both sides) and Heating & Electric Oct 8 $1,529.50 and $180.80 (pending "Mccarthy Heating Oil", posted "Mccarthy Heating Oil Ser") all inherit; the stored list stays at 3 entries (no extra slots).
- Window edges through the loader: posted 0, 1 and 5 days after inherit, 6 days after does not.
- Different account, different cents (1 cent), different supplier do not inherit; a changed bank reference number ("860-9999999" vs "860-4432839") does inherit.
- The longer-descriptor-first direction (pending "... Oil Ser", posted "... Oil") inherits. This case also kills the mutant that makes the loader fall back to the joined text, which the shorter-first direction cannot see.
- 2,000 random worlds (two accounts, repeated amounts, 3 descriptor variants, reference digits changed, +0/+1 day posting, shuffled order): for an unambiguous charge every mark finds exactly its twin and no unmarked row is excluded; with repeated same-amount charges never more exclusions than marks; no row is excluded unless its account and cents carry a mark.

Live replay of the real matcher (round 2 code, read-only SQL, archived pending rows of the last 150 days, 605 rows): 524 have a posted twin; **460 (87.8%) inherit exactly their twin** (round 1: 78%). The 64 that do not are different merchant texts ("herbaceous cater" -> "herbaceous catering" is a mid-word truncation the whole-word rule deliberately refuses; "ATM DEBIT BIG Y 5 MYSTIC" -> "Big Y"). One replay hit a non-twin row: a pending Chewy -440.78 whose own twin posted 6 days earlier and a second identical -440.78 "chewy com" charge one day later in the window; that is the documented identical-charge ambiguity, not a new defect.
The three pending McCarthy rows replayed as they will post: Heating & Electric $1,529.50 and $180.80 ("mccarthy heating oil") inherit when they post as the account's usual "mccarthy heating oil ser"; Barclay $1,036.75 inherits when it posts with the identical text (and also as "... ser").

## (3) Digit-run stripping and mutation check

- Stripping runs of 5 or more digits cannot make different suppliers match: the letters still decide ("Valero 12345678" vs "McCarthy Heating Oil 12345678" are not alike); a descriptor that is only a reference number has an empty key and never matches anything (even another reference-only row). The whole-word-prefix tolerance is intact ("mccarthy heating" is a prefix of "mccarthy heating oil", "mccarthy heat" is not). A dropped run becomes a space, so it never glues the words around it ("abc12345def" -> "abc def"). Residual, low: two payees that differ only in a long number (for example "check 20101" and "check 20102") share a key, but they still need the same account, cents and a 5 day window.
- Mutation on temporary copies, 13 mutants of `descriptorOf` / `payeeKey` / the loader / the action: normalized-raw order, description first, blank string accepted, digit threshold 4 and 6, all digits dropped, digits kept, run removed without a space, loader without descriptor, loader joined, action joined: all killed (6 by the Coder's tests, 4 only by mine: the glue case and the two loader mutants). Identity survived. One equivalent survivor (`d04`, a joined fallback that is only reachable when all three columns are blank, where it also yields a blank key).

## (4) Full runs (real output)

- `pnpm typecheck`: exit 0.
- `pnpm lint`: `51 problems (0 errors, 51 warnings)` (unchanged; my new test file is clean).
- `npx vitest run`: `Test Files 494 passed (494)`, `Tests 13467 passed | 11 skipped (13478)`, exit 0 (Coder: 493 files / 13460; the difference is my new round 2 file and my extra tests).
- Same with `DATABASE_URL` and `DIRECT_URL` set to `postgresql://x:y@127.0.0.1:1/z`: `Test Files 494 passed (494)`, `Tests 13467 passed | 11 skipped (13478)`, exit 0; 0 lines matching PrismaClientInit, Can't reach database or ECONNREFUSED.
- Temp files deleted (`ls`, `ls lib` and `git status` show no `zz-*`); no DB writes; nothing staged or committed.

## Not tested

- Real pending -> posted of the three pending McCarthy rows (they have not posted yet); the replay uses real historical pairs and the account's usual posted descriptor.
- A browser view of the "Pending: the mark carries over" lines.
- Remaining known low item, unchanged: greedy assignment for two identical-cent marks with different posted descriptors (pinned with an `it.fails`).
