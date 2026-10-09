# Plan: recurring-detection (forecast step 2, history-learned recurring bills)

## 1. Restated goal
A pure detector learns recurring payees from past transactions and (a) suggests the ones not yet modelled as a ScheduledBill / Budget schedule / RecurringExpense, (b) flags an expected bill that has not posted, (c) flags a changed amount on a steady bill, and (d) fills the Upcoming ledger's reserved `learned` tier in a clearly labelled block that is NOT in the totals. The owner can turn a suggestion into a RecurringExpense or dismiss it. No migration is required (recommended path).

## 2. Scope
In: new pure module, one DB-aware loader, one small server-actions file, small additive changes to `lib/upcoming-ledger.ts` / view / loader, one new UI component + mounts on `/forecast` and the dashboard widget, tests, a CLAUDE.md paragraph.
Out (unchanged): `lib/forecast.ts`, `lib/business-forecast.ts`, `lib/notifications.ts`, `lib/spend-forecast.ts`, cash-flow engine output, `prisma/**`, reminders, seasonal/variable-by-month modelling, forecast accuracy, tax projections, advisor tools (tests pin exactly 25 tools; do not touch).

## 3. Live calibration (read-only, 2026-10-08; temp scripts deleted; names/counts/amounts only)

Data shape. 3,587 live non-archived transactions. Primary Checking 2,729 rows from 2025-05-08 (2,677 outflow, 52 inflow); EK Capital One 223 rows from 2025-01-20; every other account from 2026-03/04. Account types in the DB: checking 8, credit_card 3, loan 2, mortgage 1, investment 1, insurance 1, savings 1.

Payee cleanliness is the main finding. `payeeNormalized` is NOT clean on Primary Checking: 995 distinct values, 1,627 of 2,729 rows longer than 30 chars. About 60% of rows are raw bank descriptions ("dda purchase ap 403482 lowe s 2938 lisbon ct", "visa dda pur ap 469216 apple com bill 866 712 7753 ca", "dda purch w cb ...") while the rest are clean ("lowe s", "stop shop"). The same merchant therefore appears under 2-4 keys ("toyota" / "toyota ach rtl", "tmna" / "tmna subscription", "enerbank usa acct" / "... paymt", "soapy noble" / "soapy noble niantic"). Barclay (1 of 95 rows has digits), JCSB (5 of 132) and Capital One are mostly clean. 6 rows have a null payee (skipped; 4 more on Credit Cards). The detector must therefore canonicalize payees itself (rules in 5.1) and cannot trust grouping on `payeeNormalized` alone. Do not "fix" stored data.

Signs and duplicates. No sign problem found: on Primary Checking every payee is consistently negative except payroll, refunds (lowe s 9 inflows), provisional credit, venmo. No duplicate-shaped rows (same account+day+amount+payee) among non-archived rows, so the dedupe engine already handled the memory-noted duplicates. Loan-side rows are mirrors and must be excluded: PennyMac loan account shows "payment 3,255.80" and "principal reduction 1,079.89" as inflows; credit-card accounts show "payment received" inflows. 109 Primary Checking rows are transfer-paired (excluded by `transferPairId`), but UNPAIRED transfer-looking rows remain ("online xfer transfer to sv/ck xNNNN" 74+63+52+30+22 rows, "betterment sec transfer" 35, "paypal inst xfer", "nontd atm fee"): exclude by a transfer-word regex.

Candidate list with the prototype rules below (822 canonical groups; 606 seen once; 30 transfer/interest/payroll-like skipped; 34 too few occurrences; 11 stale = last seen longer ago than 1.5 cycles + 7 days, e.g. OpenAI, an old QuickBooks Comcast): 26 active series.
- 5 already modelled by tag: PennyMac mortgage (3 rows incl. 2 loan-side mirrors to exclude by account type), Enerbank/Solar 505.76, and "toyota" 250.00.
- 21 outflow candidates not tagged to a modelled item. About 18 look genuinely recurring and unrecorded: Comcast (Personal, varies ~75), Netflix ~19, YouTube Premium 28.70, Google One 21.76, github 4.25, HBO Max 19.66, tmna 15.15 (untagged), onlinenexu 34.95 (untagged), aff cozyla 109.18, Ring 21.26, ARSTRAT 137.94 (Slush Funds), bank "maintenance fee" 15.00 on two accounts, quarterly "waterford ct utility" ~88 and "newlondon" ~53 (both untagged), SV Xfinity 65.95, SV Amica insurance 167.90, two annual EK subscriptions seen twice (proton 119.88, teacher ai 147.00). About 3 are noise: "invoice cloud webpayment" 0.95 quarterly (tiny; add a $2 amount floor), the two 2-occurrence annuals if shown as more than "low".
- False positives from grocery/gas/retail: 0 of 26. Costco (weekly fit 0.62), Aldi (0.56), Big Y (0.43), Stop & Shop, Shell, Dunkin (0.38), Citgo, Hannaford, Target, Amazon were all rejected by interval fit. Barclay "smbmarket" passed as weekly-varies n=15 (a lunch spot): fixed by "weekly/biweekly must be fixed-amount".
- Misses (acceptable, conservative): Xfinity Mobile (21 rows, median gap 25 days, roughly twice a month), soapy noble when the two keys are merged (fit 0.71; passes when split, so evaluate sub-groups when the merged group fails), Eversource at SV (amounts too wide), ueni (price change), Instant Ink (fit 0.67).
- Suppression check against live modelled items (17 active bills, 8 Oct Budget schedules, 1 RecurringExpense, 2 income sources): by tag key, Mortgage, Solar, Lexus and Toyota-tag series are suppressed. SV bills are untagged (all 5, null day): "Amica - Home insurance (Arbor Retreat)" vs series "amica insurance" shares the word "amica" so the ledger's `nameWords` rule suppresses it; SV bill "Comcast" 65.95 vs series "xfinity" 65.95 shares NO word, so suppression needs the same-entity + close-amount rule (day null on the bill counts as compatible). Without that rule the owner would be offered "Xfinity" for a bill that already exists as "Comcast". Payroll series (Alpine, Seacoast) are suppressed by the income-source name match and by a "payroll" skip word.
- PennyMac "mortgage insurance disbursement" 101.83 and the PennyMac loan-side rows sit on the loan account, so the account-type exclusion removes them (in the prototype they showed as candidates).
- Genuinely missing from the books: the ~18 above minus SV Amica and SV Xfinity (both suppressed by the rules above) are unmodelled.

Findings about MODELLED items that the detector should surface (they drove the late/amount rules):
- Lexus: the bill says $250 monthly (undated). History under tag "Payment, Lexus" (payee "toyota") is $250 about every week: 74 payments since 2025-05, 4-5 per month, last 2026-10-05 (about $1,083/month if real). This is the largest disagreement found. Surface as "history differs from the record" (section 5.5), do not change the bill.
- Posting lag: Mortgage bill day 1 posts on the 2nd-5th; Northwestern Mutual day 2 posts the 3rd-7th as two payments (400.00 + 358.73). So the "expected date" for late-checks must be the OBSERVED median day, with a 5-day grace, never the stated day alone.
- Eversource amounts swing 41 to 665 (seasonal): price-change flags must be restricted to steady (fixed-amount) series or Eversource would flag every month.
- Doggy Daycare weekly 77.64 recently vs older 285-298 rows: history thin; no flag unless 4 prior matches.

## 4. Approach (ordered steps)

### Step 1. `lib/recurring-detect.ts` (pure; imports only `Decimal` and helpers exported from `lib/upcoming-ledger.ts`: `nameWords`, `startOfDayUTC`, plus newly exported `amountsClose`; no DB, clock, "use server"). `today: Date` (UTC midnight of the New York date) is a parameter.

Types (exported):
```ts
type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";
type Confidence = "low" | "medium" | "high";
interface TxRow { id?: never; entityId: string; accountId: string; accountType: string; payee: string | null;
  amount: Decimal /*signed*/; postedAt: Date; tagIds: string[]; }
interface ModelledRef { source: UpcomingSource; sourceId: string; entityId: string; accountId: string | null;
  label: string; tagKey: string | null /* `${entityId}|${tagId}` */; monthly: Decimal | null;
  day: number | null; cadence: Cadence | "semiannual" | null; expectedAmount: Decimal | null; }
interface Series { key: string; entityId: string; accountId: string; kind: "outflow"|"inflow"; payee: string /*display*/;
  cadence: Cadence; typicalDay: number|null; dayRule: string; typicalAmount: Decimal; minAmount: Decimal; maxAmount: Decimal;
  amountMode: "fixed"|"varies"; occurrences: number; firstSeen: Date; lastSeen: Date; nextExpected: Date;
  confidence: Confidence; why: string[]; dominantTagId: string|null; tagShare: number; stale: boolean;
  suppressedBy: null | {kind:"tag"|"name"|"amount_day"; label: string; source: UpcomingSource}; }
interface Flag { type: "late"|"amount_change"|"history_differs"; seriesKey: string|null; modelled: ModelledRef|null;
  text: string /* observational wording */; usualDay?: number; was?: Decimal; now?: Decimal; }
interface DetectResult { suggestions: Series[] /*unsuppressed, active*/; suppressedCount: number; flags: Flag[]; staleCount: number; }
function detectRecurring(input: { rows: TxRow[]; modelled: ModelledRef[]; today: Date }): DetectResult
```
`Series.key` = `${entityId}|${accountId}|${out|in}|${canonicalName}` (stable id, no account number or tag text beyond the canonical payee).

### 5. Exact algorithm (all thresholds are constants at the top of the file, each with a comment citing section 3)

5.1 Row filter and grouping
1. Drop: `payee` null/blank; account types `mortgage|loan|investment|insurance` (loan/mirror rows); `credit_card` inflows (payments received); inflows on non-checking/savings; amounts with |amount| < $2 (interest pennies, $0.95 invoice fee). Transfer/skip regex on canonical name: `xfer|transfer|zelle|venmo|paypal inst|betterment|atm|provisional|acctverify|creditcard|card pay|interest|payroll|refund|reversal|return`. Rows already excluded by the loader: archived, pending, `transferPairId` set.
2. Canonical name: lower-case; strip leading `(visa )?dda (purchase|purch|pur|ref)( w cb| ap| ref)?`; drop every token containing a digit; drop trailing 2-letter US state tokens; collapse spaces; fall back to the original if empty.
3. Group key = entityId + accountId + sign + canonical name (a payee on two accounts or two entities is always two series). Prefix merge: a group whose tokens start with a shorter group's tokens (same entity/account/sign, shorter name at least 4 chars) is merged into the shorter. Evaluate the MERGED group first; if it fails the cadence/amount tests, evaluate each pre-merge sub-group separately (rescues "soapy noble").
4. Same-day rows are one occurrence for cadence (distinct UTC calendar days of `postedAt`). If rows > 1.5 x distinct days the group is rejected as "several charges, not one bill" (Google Workspace on Capital One: 20 rows on 9 days).

5.2 Cadence (intervals in whole days between consecutive distinct dates; median interval picks the candidate cadence)
| cadence | median interval | min occurrences | notes |
|---|---|---|---|
| weekly | 6-8 | 5 | amount must be `fixed` |
| biweekly | 12-16 | 4 | amount must be `fixed` |
| monthly | 26-35 | 3 | works with 6 months of history |
| quarterly | 84-98 | 3 | needs about 6+ months of history |
| annual | 350-380 | 2 | needs 12+ months: the two dates must be 350-380 days apart; always `low`, listed as suggestion only, never placed on the calendar |
Fit: at least 80% of intervals within the cadence band +-1 day, or within 2x the band (one skipped cycle allowed). Reject otherwise (this is what removed Costco/Aldi/Big Y/gas).

5.3 Amount (median of absolute amounts, Decimal)
- `fixed`: at least 80% of occurrences within +-10% or +-$2 of the median (larger of the two).
- `varies`: not fixed but at least 80% within +-50% or +-$5; label "amount varies". Weekly/biweekly may not be `varies`.
- otherwise reject. Range = min..max of the occurrences. (Wider band for strong-cadence utilities is NOT included in v1; the missed SV Eversource is already a modelled bill. Mention as a future tweak.)

5.4 Day rule, next date, staleness, confidence
- Monthly: `typicalDay` = median day-of-month (UTC); spread is circular on a 30-day wrap (live: "google store" 1st..30th showed a false spread of 28 without wrap handling). `dayRule` text: "usually around the 14th" (spread <= 3), "mid-month, day varies" (4-7), else "day not steady" (confidence capped low). Weekly/biweekly: `typicalDay` null, rule "about every 7 / 14 days", next = last + interval. Monthly next = next month at `typicalDay` clamped to month length. Quarterly = +3 months same rule; annual = +1 year.
- Stale: `today - lastSeen > 1.5 x cadence + 7` days (monthly: > 52 days). Stale series are counted (`staleCount`) and never suggested.
- Confidence: `high` = fixed amount, fit >= 0.9, day spread <= 3 (monthly), and occurrences >= 6 (monthly), >= 5 (weekly/biweekly), >= 4 (quarterly). `medium` = fixed or varies, fit >= 0.8, occurrences >= 4 monthly / 3 quarterly (varies is capped at medium). `low` = anything else that passed (minimum occurrences exactly, day not steady, annual). `why` lists the facts in plain words ("Seen 6 times, 28-32 days apart, always about $28.70, usually around the 5th"). Live estimate: about 11 high, 5 medium, 5 low.

5.5 Suppression (reuse the ledger's helpers; modelled refs come from a new exported `collectModelledRefs(input: UpcomingLedgerInput)` in `lib/upcoming-ledger.ts` that applies the SAME active/schedule filters as the builder: active bills, Budgets with a schedule, RecurringExpenses, orphan envelopes with draws, and income sources)
A series is `suppressedBy` the first match of: (1) tag: >= 50% of its rows carry a tag whose `${entityId}|${tagId}` equals a modelled `tagKey`; (2) name: same entity, accounts compatible (`!a || !b || a === b`), and `nameWords(series.payee)` shares a distinct word with `nameWords(ref.label)`; (3) amount+day: same entity, accounts compatible, `amountsClose(median, ref.monthly)` (5% or $1) and (ref.day null or within 3 days of typicalDay). Suppressed series are not returned as suggestions (`suppressedCount` only) but ARE used for modelled-item comparison below. Tag rule is first because 95% of recent rows are tagged but only 40-50% before 2026-04, so tags are a hint, never a requirement.

5.6 Flags (observational wording, never advice)
- Late ("expected, has not posted"): for each modelled ref with cadence monthly/weekly/biweekly OR a `high` unsuppressed series, find matching history rows (tag key, else the same name/amount rules, same entity). Require >= 3 matches. Expected date this cycle = observed median day (fallback the ref's day) clamped to month length; for weekly/biweekly last + interval. Late if `today >= expected + grace` (monthly 5 days, weekly 3, biweekly 4) AND no matching row on/after `expected - 10 days` (monthly). Stop flagging when `today >= expected + 25` (monthly; next cycle takes over). Quarterly/annual/semiannual modelled items are NEVER flagged late in v1 (not enough history to be confident). Text: "Usually posts around the 14th; none seen yet this month." Live example: Mortgage (observed day 2-5 -> flagged from the 8th if nothing posted by then).
- Amount change: for `fixed` series (modelled-matched or unsuppressed) with >= 4 prior occurrences: median of the prior (up to 8) vs the LATEST; flag if `abs(diff) >= 10%` AND `>= $2`. Text: "Was about $19.13, latest was $22.99." If the last two occurrences agree on the new amount, say "now about $22.99 (2 in a row)". `varies` series (Eversource, utilities) are never flagged. Verify the 10%/$2 pair against live Netflix/Comcast in the Tester pass (read-only), adjust the constants only with evidence.
- History differs (new, small, falls out of the same matching; ask owner, section 11 Q5): for a modelled item whose matched history has a different cadence (weekly vs monthly) or a median amount differing > 25% from the record. Text: "Your records say $250 monthly; history shows about $250 every week." Live: Lexus.

Dates: all rows converted with `getUTC*` only (stored postedAt is UTC wall-clock, Postgres `timestamp`); display is the caller's job. Tests include dates straddling DST (2026-03-08, 2026-11-01) and a 23:30Z timestamp to prove no local-time dependence.

### Step 2. Ledger integration (additive, `learned` kept OUT of `items` and totals)
Decision and justification: put learned items in a NEW array `UpcomingLedger.learned: UpcomingItem[]` and `learnedTotals: { outflow: Decimal; count: number }`; they never enter `items`, `undated`, `pastDue`, `totals`, `totalsByEntity` or `biggest`. Reason: the existing totals promise "scheduled or labelled estimate"; a guessed series could double count a bill the owner has under another name, and this leaves every existing ledger test and the Personal cash-flow untouched. Only `high` and `medium` outflow series with a dated `nextExpected` inside the window, monthly/biweekly/weekly/quarterly, are placed in `learned`, each as an `UpcomingItem` with `tier: "learned"`, `source: "learned_history"` (new member of `UpcomingSource`; update `sourceLabel`), `amountStatus: "known"` (median, rounded to cents; "varies" series carry `amount` = median and the note "amount varies, about $X-$Y"), `tierNote` = the series `why`, `notes` = ["Looks recurring from your history, not in your budget"], link `{ page: "forecast", anchor: "looks-recurring" }`. Weekly/biweekly series list every date in the window. `low` confidence and all annual series NEVER get a date; they appear only in the review list. Inflow series never enter `learned` (revenue is volatile; they appear only in the review list under "Regular deposits").
Changes in `lib/upcoming-ledger.ts`: widen `UpcomingSource`; export `amountsClose`, `accountsCompatible`; add exported `collectModelledRefs`; `UpcomingLedgerInput` gains optional `learned?: LearnedSeriesRow[]` (structural plain row: key, entityId, accountId, payee, cadence, typicalDay, amount, minAmount, maxAmount, amountMode, nextExpected dates already expanded or the series, confidence, why) so the ledger never imports the detector; `buildUpcomingLedger` re-checks each learned row against its own kept obligations with `likelySameObligation` and drops matches (belt and braces) into `learnedDropped` count; scope by `inScope`. No existing field changes meaning; existing outputs for inputs without `learned` are byte-identical (a test asserts `learned: []`, `learnedTotals.count: 0`).

### Step 3. Loader (DB-aware, read-only, no auth, fail-soft)
New `lib/recurring-detect-build.ts`: `loadRecurringDetection({ entityId, now, input })` does ONE `db.transaction.findMany` with explicit `select` (entityId, accountId, account.accountType, payeeNormalized, amount, postedAt, tags.tagId), where `archivedAt: null, transferPairId: null, pending: false, postedAt >= today - 18 months`, entity-scoped like the ledger (null = every entity, series still per entity/account), then `detectRecurring`. `loadUpcomingLedger` calls it inside its own try/catch AFTER assembling the input, computes `collectModelledRefs(input)`, then passes `learned` into `buildUpcomingLedger`. On any throw: ledger renders without learned, `LoadedUpcomingLedger.detection = null` and the UI shows one muted line "Recurring-pattern checks are unavailable right now." (render-tested). Reads about 2,800 rows for Personal plus a tag join; measure once and, if the dashboard slows, move the widget behind `Suspense` (flagged, not pre-built). Dismissal read (5.7) is in the same try/catch.
Returned alongside the ledger: `detection: { suggestions: Series[] (not dismissed), dismissedCount, flags, suppressedCount }` serialized by a new `toUiDetection()` in `lib/upcoming-ledger-view.ts` (strings only, no Decimal/Date to components, same as `toUiLedger`).

### Step 4. Owner actions (`actions/recurring-suggestions.ts`, "use server", every export starts with `requireAuth()`, zod-validated)
- `addSuggestedRecurringExpense({ entityId, seriesKey })`: the SERVER re-runs the loader and finds the series by key (refuses if missing, now suppressed, or low-confidence annual with no date; never trusts client amounts). Creates the row through the same `db.recurringExpense.create` shape as `createRecurringExpense` (do not call that action; avoid a second auth hop; reuse its zod schema by exporting it or duplicating the 8 lines): `name` = Title-Cased canonical payee, `amountCents` = median cents, `frequency` = cadence (annual -> "annually"), `dueDay` = typicalDay for monthly else null, `nextDueDate` = nextExpected, `tagId` = dominant tag only if tagShare >= 60% and that tag key is not already modelled, else null, `notes` = "Added from a recurring pattern in your transactions." Then `revalidatePath("/forecast")`, `("/")`, `("/budgets")`. Returns `{ success } | { error }`. Idempotent: a second click returns "Already recorded". One `AuditLog` row with the RecurringExpense id and counts only (`changedBy` = the user; no payee text) if the existing recurring-expense actions write none, skip it for consistency (check `actions/recurring-expenses.ts`: it writes none).
- `dismissSuggestion({ entityId, seriesKey })` / `restoreSuggestion({ entityId, seriesKey })` (5.7).
- The RecurringExpense lacks `accountId`; the account is not stored. Ledger Stage C then matches it by name/amount/day, which the name derivation above keeps working. Monthly `varies` series are created at the median amount and the note says so.

### 5.7 Dismissal persistence options (owner chooses; recommended B)
- A. New table `RecurringSuggestionDismissal(id, entityId, seriesKey unique per entity, dismissedAt, dismissedById, amountAtDismissal)`. Cleanest, queryable, allows re-surface logic. REQUIRES A MIGRATION (hand-written SQL, additive, not applied until the owner OKs the push; Vercel migrates on build). Not included in this plan's file list.
- B. (recommended, no migration) `AppSetting` key `recurring_dismissed:{entityId}` (the repo's per-entity setting convention, `lib/settings.ts`), value = JSON `{ v: 1, keys: [{ k: seriesKey, at: ISO }] }`, capped at 200, household-wide. New typed wrapper pair in `lib/settings.ts` (`getDismissedSuggestions` / `setDismissedSuggestions`), parse errors fail soft to empty. Weakness: read-modify-write can lose a dismissal if two people click within the same instant (harmless: it reappears). A dismissed key matches a series whose key equals it OR is a token-prefix of it (or vice versa) so a prefix-merge change does not resurrect it. Dismissed items are listed under a collapsed "Dismissed (N)" with "Show again".
- C. Omit dismissal in v1: rejected, the review list would nag forever.

## 6. UI placement and wording
All wording observational: "looks recurring", "usually", "about $X". No advice, no "you should". Labels: tier badge "Learned from history" (distinct from "Estimate"). Never claim certainty; every suggestion row shows its `why` and confidence ("Strong pattern / Likely / Weak pattern, 3 times").
1. `/forecast` (after the "Upcoming" agenda, wrapper `id="looks-recurring"`): new `components/upcoming/recurring-suggestions.tsx` (presentational, plus a tiny `"use client"` leaf `suggestion-actions.tsx` with `useTransition` and `window.confirm`-free buttons). Sections: "Looks recurring, not in your budget" (rows: payee, "~$28.70 monthly, usually around the 5th", confidence, why, buttons "Add as recurring expense" / "Not a bill"); "Heads up" (late items: "Mortgage usually posts around the 3rd; none seen yet this month."; amount changes: "Netflix: was about $19.13, latest was $22.99."; history differs: "Lexus Financial: your record says $250 monthly; history shows about $250 every week"); "Regular deposits" (inflow series, no buttons in v1); collapsed "Dismissed (N)". Footer line: "Based on your last 18 months of transactions. These are patterns, not bills, and are not included in the totals above."
2. Learned block inside the agenda: after the dated rows, a block "Looks recurring, not counted (N items, ~$X)" rendering `ledger.learned` with the learned badge; the summary strip is unchanged (still counted bills only).
3. Dashboard widget: no learned rows; add one muted line under the strip, only when non-empty: "3 items look recurring but are not in your budget, 1 expected bill has not posted. Review" linking to `/forecast?bucket=<slug>#looks-recurring`. Late flags are shown as amber text in this line's expanded `<details>`, max 5.
4. Aggregate buckets (taxes/projects, entityId null): suggestions show an entity chip, no Add button on the dashboard, Add allowed on the forecast page (entity comes from the series).

## 7. File list
New
- `lib/recurring-detect.ts` (pure detector)
- `lib/recurring-detect-build.ts` (read-only loader)
- `actions/recurring-suggestions.ts` (add / dismiss / restore)
- `components/upcoming/recurring-suggestions.tsx`, `components/upcoming/suggestion-actions.tsx` (client leaf)
- `lib/__tests__/recurring-detect.test.ts`, `recurring-detect-ledger.test.ts`, `recurring-suggestions-render.test.tsx`, `recurring-suggestions-actions.test.ts`
Modified
- `lib/upcoming-ledger.ts` (types, `learned`, `learnedTotals`, exports `amountsClose`/`accountsCompatible`/`collectModelledRefs`)
- `lib/upcoming-ledger-view.ts` (`sourceLabel`/`tierLabel` for `learned`, `toUiDetection`, learned in `UiLedger`)
- `lib/upcoming-ledger-build.ts` (call detection, pass `learned`, return `detection`)
- `lib/settings.ts` (dismissal wrapper pair)
- `components/upcoming/upcoming-agenda.tsx`, `upcoming-widget.tsx`, `upcoming-parts.tsx` (learned block, heads-up line, badge)
- `app/forecast/page.tsx`, `app/page.tsx` (pass `detection`, mount component; existing try/catch kept)
- `CLAUDE.md` (one paragraph "Recurring detection" after "Upcoming ledger")
Not touched: `lib/forecast.ts`, `lib/business-forecast.ts`, `lib/notifications.ts`, `prisma/**`, `actions/recurring-expenses.ts` (unchanged; its zod schema is duplicated or exported only if trivially safe), advisor files.

## 8. Test list (Vitest, pure, `makeRows` helper like `lib/__tests__/upcoming-ledger.test.ts`)
Detector: each cadence detected at its minimum and at minimum-1 (not detected); spacing tolerance edges (26/35 in, 25/36 out); one skipped cycle tolerated, two not; monthly with 6 months history; annual only with two rows 350-380 days apart, never from a 6-month history, always `low` and undated; quarterly with 3; weekly/biweekly with varying amounts rejected; `fixed` vs `varies` boundaries (+-10%/$2, +-50%/$5); payee canonicalization table (raw POS prefix, store numbers, trailing state, prefix merge, merged-fails-then-split fallback); same payee on two accounts and two entities = separate series; transfers/payroll/interest/refund words, inflows on loan/credit-card accounts, amounts under $2 excluded; payee seen once, null payee; same-day multiple rows (rows > 1.5 x days) rejected; groceries-style irregular spacing (Costco-like fixture) rejected; stale series dropped (boundary 52 days); month-end wrap (days 30,1,31) spread; Feb clamp for day 30/31 nextExpected; DST dates and 23:30Z timestamps; confidence tiers and `why` text; suppression by tag, by name word, by amount+day, null-day bill, different entity NOT suppressed, income-source name; late flag boundaries (grace-1 no, grace yes, posted-within-window no, < 3 history rows no, quarterly never, after expected+25 stops); amount change thresholds (9.9% no, 10% and $2 yes, $1.99 no, `varies` never, < 4 prior never, "2 in a row" text); history-differs (weekly vs monthly, amount > 25%); determinism (input order does not change output).
Ledger integration: no `learned` input -> output identical to today for a fixture (reuse existing fixtures; run the existing 5 upcoming test files unchanged); learned row placed only in `learned`, never in `items`/totals/`biggest`; low and annual excluded; weekly series expands dates; row matching a kept obligation dropped; entity scope; ids unique.
Render: learned block, suggestions section, heads-up wording, dismissed collapsed, "unavailable" notice, no "$0.00" for empty, banned phrases ("you should", "CPA") absent. Actions: every export begins with `requireAuth()` (source-reading test like the review-queue pin), dismissal JSON parse/cap/fail-soft, add refuses a suppressed/missing series, add maps cadence "annual" to "annually", tag link only at >= 60% share, no `deleteMany`/`upsert` on `recurringExpense` and no client-supplied amount (source test). Source-scan: `lib/recurring-detect.ts` imports no `@/lib/db`, no `next/*`, no `Date.now`/`new Date()` without args.
Tester live read-only checks: re-run the calibration (expect about 26 active series, 0 grocery/gas, Lexus history-differs flag, Mortgage not late today).

## 9. Risks / unknowns
1. Payee canonicalization is heuristic; a merchant whose descriptor changes (new POS prefix) splits into two series and may be missed, never mis-merged across entities/accounts. Conservative by design.
2. Tag-key suppression only works when history is tagged (40-50% before 2026-04); the name and amount+day rules cover the rest; a hidden-looking duplicate is better than a duplicate suggestion, so suppression errs toward hiding. The count is shown ("N hidden because they look already recorded") so nothing disappears silently.
3. Lexus finding may be a data-entry or tagging issue (weekly payments tagged "Payment, Lexus" with payee "toyota"); the plan only reports it.
4. RecurringExpense has no account and no cadence of "semiannual"; the Amica semiannual bill therefore cannot be created as a suggestion (it is modelled, so it is suppressed anyway).
5. A `fixed` series seen only 3 times can be coincidence (low); `low` never reaches the calendar.
6. Dashboard cost: one more query (about 2,800 rows plus tags). Flagged, measure in the Coder's live smoke.
7. Dismissal B is household-wide, not per user (matches the shared household model).
8. The existing `/budgets` page applies RecurringExpense as an amount override (pre-existing); a newly created suggestion-RecurringExpense linked to a tag with a Budget row could override that Budget's amount there. Mitigation: only link `tagId` when no Budget row uses that tag key (the series would normally be suppressed otherwise).
9. Assumption not verified: `Transaction.postedAt` is 00:00Z (UTC calendar date). Detector only uses UTC dates, so correctness does not depend on it.
10. Pre-existing gaps not fixed here: `/forecast` card table formats `ccDueDate` in New York time (off by one).

## 10. Acceptance criteria
1. `detectRecurring` is pure (source-scan test), deterministic and returns the types in Step 1.
2. On the live calibration data the Tester sees 20-30 active series, zero grocery/gas/retail false positives, and none of Mortgage, Solar, Toyota/Lexus-tag, payroll, SV Amica, SV Comcast/Xfinity offered as suggestions.
3. A series is `monthly` with 3+ occurrences in a 6-month history; `annual` is never produced without two dates 350-380 days apart, is `low`, and is never dated in the ledger.
4. `ledger.learned` holds only high/medium outflow series with dates; `items`, `totals`, `totalsByEntity`, `biggest` and the dashboard counted figure are unchanged for the same inputs (existing upcoming tests pass unmodified).
5. Late and amount-change flags follow the thresholds in 5.6 with boundary tests; Eversource-style varying bills are never amount-flagged.
6. Adding a suggestion creates exactly one RecurringExpense from server-derived values; a second click does nothing; the next ledger load no longer lists the series.
7. Dismissing hides a suggestion across reloads (AppSetting) and "Show again" restores it; a corrupt setting value shows no error.
8. Dashboard and `/forecast` render with detection throwing, with no history, and with zero suggestions (no crash, one muted notice).
9. Wording: no advice, no account numbers, no "CPA"; every dollar shown is "about"/"~"; learned rows carry "Learned from history".
10. `pnpm typecheck`, `pnpm lint` (0 new warnings), full `pnpm test` pass; no `prisma/**` diff; no DB write in any loader.

## 11. Owner questions (plain language, with recommended default so nothing blocks)
1. Should "looks recurring" bills be added into the 30-day "due" total? Recommend NO: show them on the calendar in their own block labelled "learned from history" with their own subtotal, and keep the main total to bills you have entered, until you confirm them with "Add as recurring expense".
2. How should "Not a bill" be remembered? Recommend the no-migration option (stored in the app settings table, shared by Eric and Eva). The alternative is a small new database table; it needs a migration that waits for your OK and gains little today.
3. Should regular deposits (income) be suggested too? Recommend they be shown in a short list but never placed on the calendar or added automatically (only the two paychecks exist today and both are already entered).
4. How late is "late"? Recommend 5 days after the day it usually posts for monthly bills, 3 for weekly (your mortgage usually posts 2-5 days after the 1st).
5. OK to also show "your record says $250 monthly but history shows about $250 every week" (Lexus today, about $1,083/month of history vs $250 entered)? Recommend yes, as a heads-up line only; nothing is changed automatically. Please check what the Lexus payment really is.
6. Should price-change heads-ups cover only steady bills (insurance, subscriptions, loan) and skip swinging bills like electric? Recommend yes (electric swings 41 to 665, it would flag every month).
