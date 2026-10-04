# 09 — Tax Year 2025 Constants (Federal + Connecticut)

Sourced 2026-09-17 directly from primary/official documents (not blog summaries — several secondary
sites returned materially wrong Connecticut bracket thresholds; verify against these citations, don't
re-derive from search snippets). Scope: only what's needed for the personal 1040 (MFJ, Eric + Eva) and
CT-1040 return for tax year 2025, plus Schedule C (Eric Kinniburgh Consulting LLC, single-member
disregarded entity). Sudden Valley PM LLC and Mezzo have no 2025 filing obligation (see
`specs/07-source-data-notes.md` — Sudden Valley's first filing is TY2026, due Q1 2027; Mezzo not formed).

**These are the only figures the tax-compute engine should hardcode.** Never let generated code
re-derive or approximate a bracket/rate — reference this file's constants directly, and re-verify here
(not in code) if a future tax year needs updating.

## Federal (IRS, tax year 2025)

Standard deduction and rates reflect the One Big Beautiful Bill Act (OBBBA, enacted mid-2025), which
raised the standard deduction above the original Rev. Proc. 2024-40 figures but left the bracket
*rates and dollar thresholds* unchanged from Rev. Proc. 2024-40.

- **Standard deduction, MFJ: $31,500.** (Rev. Proc. 2024-40 originally set $30,000; OBBBA raised it to
  $31,500. Source: multiple consistent post-OBBBA summaries — GuideStone, H&R Block, Fidelity. The
  IRS.gov newsroom page for TY2025 (IR-2024-273) is stale and still shows the pre-OBBBA $30,000 —
  confirmed live 2026-09-17, do not trust that specific page without cross-referencing OBBBA coverage.)
- **Tax brackets, MFJ** (rates/thresholds confirmed unchanged by OBBBA; source: irs.gov/newsroom
  IR-2024-273, Rev. Proc. 2024-40):
  | Rate | Taxable income (MFJ) |
  |---|---|
  | 10% | $0 – $23,850 |
  | 12% | $23,851 – $96,950 |
  | 22% | $96,951 – $206,700 |
  | 24% | $206,701 – $394,600 |
  | 32% | $394,601 – $501,050 |
  | 35% | $501,051 – $751,600 |
  | 37% | $751,601+ |
- **Self-employment tax (Schedule SE):** net SE earnings = 92.35% of Schedule C net profit (IRC §1402,
  fixed by statute). 12.4% OASDI portion applies up to the **$176,100** wage base for 2025 (SSA
  announcement, confirmed via multiple payroll-industry sources citing the SSA release). 2.9% Medicare
  portion is uncapped. Combined rate below the wage base: 15.3%.
- **Additional Medicare Tax:** 0.9% on combined wages + SE income above **$250,000 for MFJ** (statutory
  threshold, not inflation-indexed — do not confuse with the $200,000 single-filer/employer-withholding
  threshold, which is a different number for a different purpose).
- **QBI deduction (§199A):** 20% of qualified business income. For 2025, MFJ phase-in range (relevant
  only if taxable income is high enough to matter) is **$394,600–$494,600** (OBBBA widened the phase-in
  band; below $394,600 the 20% deduction applies in full regardless of SSTB status).
- **Standard mileage rate, 2025: 70¢/business mile** (IRS Notice 2025-5, up from 67¢ in 2024).
- **Home office simplified method: $5/sq ft, capped at 300 sq ft** (long-standing IRS figure, unchanged
  in recent years).

- **SALT (state and local tax) deduction cap, 2025: $40,000** (MFJ; $20,000 MFS), up from the prior
  $10,000 cap — OBBBA raised it for tax years 2025–2029. Phases down by 30% of the amount MAGI exceeds
  **$500,000** (MFJ), with a floor of $10,000 (i.e., never drops below the old cap). Source: multiple
  consistent post-OBBBA summaries (Venable LLP SALT Alert, HCVT, Bipartisan Policy Center), and
  **cross-checked 2026-10-03 against the actual 2025 Schedule A instructions/worksheet**
  (`https://www.irs.gov/instructions/i1040sca`): worksheet line 1 = $40,000; line 6 = MAGI excess over
  $500,000; line 7 = line 6 x 30%; line 9 = the larger of line 8 or $10,000. The earlier "not yet
  cross-checked" caveat is closed. Property tax is deductible if assessed before 2026 and paid.

## Connecticut (DRS, Form CT-1040 TCS, Rev. 12/25 — fetched directly from portal.ct.gov 2026-09-17)

All tables below are Married Filing Jointly / Qualifying Surviving Spouse columns only (that's Eric +
Eva's filing status).

**Table A — Personal exemption**, based on CT AGI: $24,000 at CT AGI ≤ $48,000, stepping down $1,000
per $1,000 of CT AGI above that, reaching $0 at CT AGI ≥ $71,000.

**Table B — Initial tax** (applied to CT taxable income = CT AGI − Table A exemption):
| CT taxable income | Tax |
|---|---|
| ≤ $20,000 | 2.00% |
| $20,000 – $100,000 | $400 + 4.5% of excess over $20,000 |
| $100,000 – $200,000 | $4,000 + 5.5% of excess over $100,000 |
| $200,000 – $400,000 | $9,500 + 6.0% of excess over $200,000 |
| $400,000 – $500,000 | $21,500 + 6.5% of excess over $400,000 |
| $500,000 – $1,000,000 | $28,000 + 6.9% of excess over $500,000 |
| > $1,000,000 | $62,500 + 6.99% of excess over $1,000,000 |

**Table C — 2% rate phase-out add-back** (based on CT AGI): $0 until CT AGI > $100,500, then adds $50
per $5,000 of CT AGI above that, capping at $500 once CT AGI > $145,500.

> **Corrected 2026-10-03 (defect D7).** Re-read from the printed table in `ct-1040-tcs_1225.pdf`, the
> MFJ column is: CT AGI <= $100,500 -> $0; more than $100,500 but not more than $105,500 -> $50; ($105,500,
> $110,500] -> $100; ... ($140,500, $145,500] -> $450; more than $145,500 -> $500. The step count is
> therefore `ceil((CT AGI - 100,500) / 5,000)` capped at 10 (so AGI exactly $105,500 is $50, $105,501 is
> $100, $145,500 is $450, $145,501 is $500). The earlier `floor(excess / 5,000) + 1` reading was wrong at
> every exact band edge, and the worry above that the table was "one step short" was a misreading of the
> printed bands, not a defect in the source. Table A (MFJ) as coded matches the printed table.

**Tax Calculation Schedule mechanic (Form CT-1040 TCS, page 1, lines 1–10) — how A–E combine.** This
resolves what was flagged as an "unverified assumption" during the tax-compute-engine build: the
Personal Tax Credit decimal (Table E) does **not** multiply Table B's initial tax alone. The literal
sequence from the primary source is:
1. Line 1: CT AGI. 2. Line 2: Table A exemption. 3. Line 3: CT taxable income (Line 1 − Line 2).
4. Line 4: Table B initial tax (applied to Line 3). 5. Line 5: Table C phase-out add-back (based on
Line 1/CT AGI). 6. Line 6: Table D recapture (based on Line 1/CT AGI). **7. Line 7: Add Lines 4, 5,
and 6** (initial tax + phase-out add-back + recapture). 8. Line 8: Table E decimal (based on Line
1/CT AGI). **9. Line 9: Multiply Line 7 (not Line 4 alone) by the Line 8 decimal.** 10. Line 10 = CT
income tax = Line 7 − Line 9.
So: `ctTax = (initialTax + phaseOutAddback + recapture) × (1 − personalCreditDecimal)`, not
`initialTax + phaseOutAddback + recapture − (initialTax × personalCreditDecimal)`.
**Note this is structurally moot for every realistic filer** (worth implementing correctly for
defensibility anyway, since a CPA reviewing the math shouldn't find an avoidable inaccuracy): Table E's
decimal is only ever nonzero at CT AGI ≤ $100,500, while Table C only ever produces a nonzero add-back
above CT AGI $100,500 and Table D only above CT AGI $210,000 — so whenever the decimal is nonzero,
`phaseOutAddback` and `recapture` are always $0 by construction, making the two formulas numerically
identical in every real scenario. Implement the literal (Line 7 − Line 9) formula anyway rather than
relying on that coincidence.

**Table D — Tax recapture, MFJ/QSS (full interior table — NOT a clean formula, do not interpolate).**
CT AGI more-than → less-than-or-equal-to → recapture amount:
$0–$210,000: $0. Then $10,000 steps of +$50 each: $210k–$220k $50, $220k–$230k $100, $230k–$240k $150,
$240k–$250k $200, $250k–$260k $250, $260k–$270k $300, $270k–$280k $350, $280k–$290k $400,
$290k–$300k $450. **Flat band:** $300k–$400k stays at $500 (no step). Then $10,000 steps of +$180 each:
$400k–$410k $680, $410k–$420k $860, $420k–$430k $1,040, $430k–$440k $1,220, $440k–$450k $1,400,
$450k–$460k $1,580, $460k–$470k $1,760, $470k–$480k $1,940, $480k–$490k $2,120, $490k–$500k $2,300,
$500k–$510k $2,480, $510k–$520k $2,660, $520k–$530k $2,840, $530k–$540k $3,020, $540k–$550k $3,200,
$550k–$560k $3,380, $560k–$570k $3,560, $570k–$580k $3,740, $580k–$590k $3,920, $590k–$600k $4,100,
$600k–$610k $4,280, $610k–$620k $4,460, $620k–$630k $4,640, $630k–$640k $4,820, $640k–$650k $5,000,
$650k–$660k $5,180, $660k–$670k $5,360, $670k–$680k $5,540, $680k–$690k $5,720. **Flat band:**
$690k–$1,000,000 stays at $5,900 (no step). Then $10,000 steps of +$100 each up to the $6,800 cap:
$1.00M–$1.01M $6,000, $1.01M–$1.02M $6,100, $1.02M–$1.03M $6,200, $1.03M–$1.04M $6,300,
$1.04M–$1.05M $6,400, $1.05M–$1.06M $6,500, $1.06M–$1.07M $6,600, $1.07M–$1.08M $6,700,
$1.08M and up: $6,800. (This table has two flat bands where the amount does NOT increase across a
$100,000 span — a linear/formula reconstruction would be wrong there; use this literal table.)

**Table E — Personal tax credit decimal, MFJ/QSS (full interior table).** CT AGI more-than →
less-than-or-equal-to → decimal: $0–$24,000: **not stated in the source table** (see note below).
$24,000–$30,000: .75. $30,000–$30,500: .70. $30,500–$31,000: .65. $31,000–$31,500: .60.
$31,500–$32,000: .55. $32,000–$32,500: .50. $32,500–$33,000: .45. $33,000–$33,500: .40.
$33,500–$40,000: .35. $40,000–$40,500: .30. $40,500–$41,000: .25. $41,000–$41,500: .20.
$41,500–$50,000: .15. $50,000–$50,500: .14. $50,500–$51,000: .13. $51,000–$51,500: .12.
$51,500–$52,000: .11. $52,000–$96,000: .10. $96,000–$96,500: .09. $96,500–$97,000: .08.
$97,000–$97,500: .07. $97,500–$98,000: .06. $98,000–$98,500: .05. $98,500–$99,000: .04.
$99,000–$99,500: .03. $99,500–$100,000: .02. $100,000–$100,500: .01. $100,500 and up: **.00**.
Note: the source table's first row starts at $24,000 (matching Table A's MFJ full-exemption ceiling of
$48,000 minus... actually the two tables use different bases — Table E keys off CT AGI directly, Table A
off CT AGI too, so there's no obvious reason Table E is silent below $24,000). Most likely explanation:
below $24,000 CT AGI, Table A's exemption ($24,000 full exemption up to $48,000 AGI) already zeroes out
CT taxable income, making the Table E credit moot (multiplying $0 initial tax by any decimal is still
$0) — but this is inference, not something the source PDF states outright. Treat CT AGI < $24,000 as
"credit is moot because initial tax is already $0 via Table A," not as an unverified numeric gap.

Both tables' full source: same PDF as Table A–C above (`ct-1040-tcs_1225.pdf`, pages 4–5).

**Property tax credit (Schedule 3) — now primary-sourced and CORRECTED** (fetched directly from
`2025-ct-1040-instructions_1225.pdf`, pages 14–15 and 27, 2026-09-17). An earlier version of this file
cited a secondary-source claim of a $56,500 MFJ income ceiling and an age-65/dependents eligibility
restriction — **both were wrong**; the actual 2025 instructions state no such age/dependents
restriction (eligibility is simply: CT resident, paid qualifying property tax on a primary residence
and/or up to two motor vehicles if MFJ, and Form CT‑1040 Line 10 is nonzero).
- **Max credit: $300/return**, regardless of filing status.
- Qualifying property tax = tax on primary residence + up to 2 motor vehicles (MFJ; 1 for other filing
  statuses), **paid during 2025** (installments due in 2025 or prepaid-in-2025-but-due-in-2026 count;
  late payments and any interest/fees don't).
- **MFJ full credit (no phase-out) at CT AGI ≤ $70,500.** Above that, multiply the tentative credit
  (lesser of qualifying property tax paid or $300) by `(1 − phaseOutDecimal)` using this MFJ table:
  CT AGI $70,500–$80,500: .15 phase-out (85% of credit remains); $80,500–$90,500: .30;
  $90,500–$100,500: .45; $100,500–$110,500: .60; $110,500–$120,500: .75; $120,500–$130,500: .90;
  $130,500 and up: **1.00 (fully phased out, $0 credit)**.
- Not refundable, no carryforward; can only offset the current year's CT income tax (Form CT-1040
  Line 10 → Line 11).

Full source PDF (all 5 tables, exact text): `https://portal.ct.gov/-/media/drs/forms/2025/income/ct-1040-tcs_1225.pdf`

## Additional TY2025 constants (verified 2026-10-03)

Fetched from irs.gov / portal.ct.gov on 2026-10-03 (text read, TY2025 editions) by the
`filing-packet-compute-roadmap` planner (`.claude/pipeline/filing-packet-compute-roadmap/01-plan.md`,
section 5.1). The code registry for these is `lib/tax2025/constants.ts`: every entry there carries the
`url` and `verifiedOn` below, and a test fails if one is missing. **Only these values may be hardcoded by
the TY2025 return engine (`lib/tax2025/`)**; anything in the "not verified" list further down is emitted as
`needs_cpa_rule_unverified` instead of being estimated.

| Item | Verified value | Source URL |
|---|---|---|
| Standard deduction MFJ | $31,500 (single/MFS $15,750; HOH $23,625) | `https://www.irs.gov/instructions/i1040gi` (What's New) |
| Tax Table rule | Taxable income under $100,000 must use the Tax Table; otherwise the Tax Computation Worksheet. A row's tax is the tax at the row midpoint, rounded. Row widths from the printed table: 5 below $5, 10 from $5 to $25, 25 from $25 to $3,000, 50 from $3,000 to $100,000. **Re-verified 2026-10-04 against the full printed MFJ column (2,062 contiguous rows, $0 to $100,000, fixture `lib/__tests__/fixtures/tax-table-2025-mfj.json`)**: the midpoint rule reproduces every row (e.g. 95,000-95,050 = $10,926; 98,000-98,050 = $11,394) | same |
| Rounding | May round to whole dollars; if so, round **all** amounts; add with cents, round the total | same ("Rounding Off to Whole Dollars") |
| QDCG worksheet thresholds | $96,700 (0% limit, MFJ), $600,050 (15% limit, MFJ) | same |
| Schedule 1-A (new for 2025) | Tips: max $25,000 total (not per spouse), reduced starting at MAGI $300,000 MFJ by $100 per $1,000 over (rounded down). Overtime: max $25,000 MFJ, same MAGI/reduction. Car-loan interest: max $10,000, MAGI start $200,000 MFJ, reduced $200 per $1,000 over (rounded **up**); vehicle bought in 2025, personal use, VIN, US final assembly. Seniors: $6,000 each (born before Jan 2, 1961), MAGI start $150,000 MFJ, reduced by 6% of the excess. Valid SSN required; must file jointly. Result goes to 1040 line 13b | `https://www.irs.gov/pub/irs-pdf/f1040s1a.pdf`, `https://www.irs.gov/instructions/i1040gi` |
| Overtime reporting for 2025 | No W-2 change; the employer may show it in box 14; otherwise the taxpayer figures the FLSA overtime premium | `i1040gi` (Schedule 1-A) |
| SALT cap | $40,000 ($20,000 MFS); reduced by 30% of MAGI over $500,000; floor $10,000 | `https://www.irs.gov/instructions/i1040sca` |
| Mortgage interest limit | $750,000 of acquisition debt for loans after Dec 15, 2017 | `i1040sca` |
| Noncash gifts | Form 8283 required if the deduction is over $500 | `i1040sca` |
| Schedule SE | 92.35% (line 4a); $400 floor (line 4c); wage base $176,100 (line 7); line 8a = W-2 boxes 3 + 7; 12.4% on the smaller of line 6 or line 9; 2.9% on line 6; half to Schedule 1 line 15 | `https://www.irs.gov/pub/irs-pdf/f1040sse.pdf`, `https://www.irs.gov/instructions/i1040sse` |
| Additional Medicare Tax | Not indexed: MFJ $250,000, MFS $125,000, others $200,000; Form 8959 required if any W-2 box 5 is over $200,000 or combined wages + SE is over the threshold; Part V reconciles withholding; line 24 goes to 1040 line 25c | `https://www.irs.gov/instructions/i8959`, `i1040gi` |
| NIIT | 3.8% of the lesser of net investment income or MAGI over the threshold; MFJ $250,000 | `https://www.irs.gov/instructions/i8960` |
| QBI | Form 8995 if taxable income before QBI is at most $394,600 MFJ ($197,300 others), else 8995-A; phase-in band to $494,600 MFJ; limited to 20% of (taxable income before QBI minus net capital gain including qualified dividends); QBI is net of the deductible half of SE tax, SE health insurance and qualified-plan contributions | `https://www.irs.gov/instructions/i8995` |
| HSA | $4,300 self-only, $8,550 family, +$1,000 age 55 or older; reduced by employer contributions; none for months on Medicare or if someone's dependent | `https://www.irs.gov/instructions/i8889` |
| IRA | $7,000 ($8,000 age 50 or older); deduction phase-out if covered by a workplace plan: MFJ MAGI $126,000-$146,000; not covered but spouse is: $236,000-$246,000 | `https://www.irs.gov/publications/p590a` (2025) |
| Saver's credit | Contribution cap $2,000 per person; MFJ credit rates 50% to $47,500, 20% to $51,000, 10% to $79,000, 0% above; the form states no credit if 1040 line 11a is more than $79,000 MFJ; line 2 includes 401(k)/403(b)/457(b)/SEP/SIMPLE/TSP deferrals including designated Roth; MFS is in the "all other filers" column | `https://www.irs.gov/pub/irs-pdf/f8880.pdf`, `https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-savings-contributions-savers-credit` |
| Form 5695 | 30% for property placed in service 2022-2025; no residential clean energy credit for expenditures after Dec 31, 2025; under 80% nonbusiness use -> only the nonbusiness-allocable cost; carryforward handled on the form | `https://www.irs.gov/instructions/i5695` |
| Schedule 3 line map | 1 foreign tax; 4 saver's; 5a Form 5695 line 15; 8 total to 1040 line 20; 10 extension payment; 11 excess Social Security; 15 total to 1040 line 31 | `https://www.irs.gov/pub/irs-pdf/f1040s3.pdf` |
| Foreign tax direct credit | No Form 1116 if all foreign income is passive 1099 interest/dividends and total foreign tax is at most $300 ($600 MFJ) | `i1040gi` |
| Schedule C | 70 cents/mile; meals generally 50%; simplified home office $5/sq ft, max 300 sq ft, per-year irrevocable election; de minimis safe harbor exists; 100% bonus for property acquired and placed in service after Jan 19, 2025 | `https://www.irs.gov/instructions/i1040sc` |
| Form 4562 | Section 179 max $2,500,000, reduced above $4,000,000 of 179 property; SUV cap $31,300; bonus changes for property acquired after Jan 19, 2025 | `https://www.irs.gov/instructions/i4562` |
| MACRS 39-year (Pub 946 Table A-7a) | Nonresidential real property, mid-month, straight line: year 1 (placed in service in July) = 1.177%; years 2-39 = 2.564% | `https://www.irs.gov/pub/irs-pdf/p946.pdf` |
| AMT | 2025 exemption $137,000 MFJ; phase-out begins $1,252,700; 26% on the first $239,100 of the excess, 28% above | `https://www.irs.gov/instructions/i6251` |
| Form 2210 | Penalty if payments are under the smaller of 90% of 2025 tax or 100% of 2024 tax (110% if 2024 AGI is over $150,000); none if tax minus withholding is under $1,000; the IRS will figure the penalty for you | `https://www.irs.gov/instructions/i2210` |
| Underpayment interest rates | 2025: 7% each quarter. 2026: Q1 7%, Q2 6%, Q3 7%, Q4 7% | `https://www.irs.gov/payments/quarterly-interest-rates` |
| CT-1040 | Line 1 = federal 1040 line 11a; line 6 tax (tax tables if CT AGI is at most $102,000, else TCS or calculator; $24,000 or less MFJ = $0); line 9 CT AMT via CT-6251 only if federal AMT was required; line 11 property-tax credit (max $300, MFJ full at CT AGI at most $70,500, decimal table to 1.00 above $130,500); line 15 use tax (must enter 0 or an amount); line 18 CT withholding; 19 CT estimates (including 2025 estimates paid in 2026); 20 CT-1040 EXT payment; 27 late payment penalty 10%; 28 interest 1% per month; Schedule 1 additions include line 36 (100% of 168(k) bonus) and 36a (80% of 179); subtractions include line 39 (US-obligation interest) and 42 (state refunds) | `https://portal.ct.gov/-/media/drs/forms/2025/income/2025-ct-1040-instructions_1225.pdf` |
| CT TCS tables | Tables A-E and the property-tax decimal table re-read; consistent with this file after the Table C correction above | `https://portal.ct.gov/-/media/drs/forms/2025/income/ct-1040-tcs_1225.pdf` |

### Phase 1b constants and corrections (read directly from the 2025 forms / instructions on irs.gov and portal.ct.gov, 2026-10-03 to 2026-10-04)

These come from the printed 2025 forms themselves (pdftotext of the PDFs) and the instruction pages, and are what
`lib/tax2025/constants.ts` and the 1b rules (`lib/tax2025/rules/`) implement. Two corrections to the table above:
the Schedule 1-A **overtime** limit is $12,500 ($25,000 MFJ) on form line 15 and its MAGI start is the same
$150,000 ($300,000 MFJ) as tips; and the Form 2210 **withholding timing** rule IS verified (see below), so it is no
longer in the not-verified list.

| Item | Verified value | Source |
|---|---|---|
| Schedule 1-A (form lines 3-38) | Part I MAGI = Form 1040 line 11b + lines 2a-2e. Tips: line 7 = smaller of line 6 or $25,000 (combined, not per spouse); line 9 start $300,000 MFJ ($150,000 others); line 11 = excess / $1,000 rounded DOWN; line 12 = x $100; line 13 = 7 - 12. Overtime: line 15 = smaller of line 14c or $25,000 MFJ ($12,500 others); same start and reduction. Car-loan interest: line 24 = smaller of line 23 or $10,000; start $200,000 MFJ ($100,000 others); line 28 = excess / $1,000 rounded UP; line 29 = x $200; interest deducted on Schedule C/E/F is excluded (column ii); VIN required. Seniors: $6,000 per person born before Jan 2, 1961 with a valid SSN; start $150,000 MFJ ($75,000 others); line 34 = 6% of the excess; line 35 = 6,000 - 34, not below zero. Valid SSN needed for the person who received tips / overtime or claims the senior deduction; MFJ required | `https://www.irs.gov/pub/irs-pdf/f1040s1a.pdf`, `https://www.irs.gov/instructions/i1040gi` (Instructions for Schedule 1-A) |
| Overtime and tips amounts for 2025 | The 2025 W-2 / 1099 do not separately report them. Overtime: the "half" of time-and-a-half (FLSA premium); an employer may show it in W-2 box 14 and an amount the employer provides can be relied on; if a statement shows total pay for overtime hours (premium plus regular wages) divide by 3 (Example 1: 15,000 -> 5,000). Tips: W-2 box 7 or tips reported to the employer (Form 4070); mandatory service charges and automatic gratuities are not qualified tips | `https://www.irs.gov/instructions/i1040gi` |
| Form 8889 | Line 3: $4,300 self-only / $8,550 family; line 7 additional $1,000 for age 55+ and married with family coverage (for self-only it is part of line 3); if either spouse has family coverage and both are eligible both are treated as family; last-month rule (eligible on December 1 = eligible all year, must stay eligible through the end of the next year); otherwise month by month / 12; line 6 equal split for spouses with separate HSAs and family coverage; line 9 = W-2 box 12 code W; line 12 = 8 - 11; line 13 = smaller of line 2 and line 12; no deduction for months in Medicare or as someone's dependent | `https://www.irs.gov/pub/irs-pdf/f8889.pdf`, `https://www.irs.gov/instructions/i8889` |
| IRA deduction (Pub. 590-A Worksheets 1-1 and 1-2; the 1040 instructions carry the same worksheet) | Modified AGI = Form 1040 line 9 minus Schedule 1 lines 11-19a, 23 and 25. Covered by a workplace plan, MFJ: line 1 = $146,000, no deduction at MAGI of $146,000 or more, no reduction when line 1 - MAGI is $20,000 or more, line 4 = line 3 x 35% (40% age 50+). Not covered but the spouse is: line 1 = $246,000, gap of $10,000 or more = no reduction, line 4 = x 70% (80% age 50+). Line 4 is rounded UP to a multiple of $10 and is at least $200. Deduction = smallest of line 4, compensation (a spouse with less compensation adds the other spouse's compensation less their traditional and Roth IRA contributions) and the contribution capped at $7,000 ($8,000 age 50+). **The Pub's own Example 1 prints $6,825 where the written rule gives $6,830; the written rule is implemented** | `https://www.irs.gov/publications/p590a`, `https://www.irs.gov/instructions/i1040gi` |
| Form 8880 | No credit if Form 1040 line 11a is more than $79,000 (MFJ); each person's contributions capped at $2,000 (line 6); decimals (MFJ) 0.5 to $47,500, 0.2 to $51,000, 0.1 to $79,000; line 4 reduces by distributions received after 2022; not available to a person born after January 1, 2008, claimed as a dependent, or a full-time student for part of 5 months; credit limited to tax (Credit Limit Worksheet: Form 1040 line 18 minus Schedule 3 lines 1-3, 6d, 6l) | `https://www.irs.gov/pub/irs-pdf/f8880.pdf` |
| Form 2210 (regular method) | Part I: line 1 = Form 1040 line 22; line 2 = Schedule 2 lines 4, 8 (additional tax on distributions only), 9, 11, 12, 14, 15, 16, 17a, 17c-17j, 17l, 17z, 19; line 3 = refundable credits (EIC, additional child tax, refundable American opportunity, refundable adoption, premium tax credit, fuel credit, section 1341); line 4 under $1,000 = no penalty; line 5 = 90% of line 4; line 6 = Form 1040 line 25d + Schedule 3 line 11; line 7 under $1,000 = no penalty; line 8 = 2024 tax (Form 1040 line 22 + Schedule 2 lines 4, 8 (distributions only), 9, 10, 11, 12, 14, 15, 16, 17a, 17c-17j, 17l, 17z, 19, minus refundable credits; Additional Medicare Tax (line 11) and NIIT (line 12) ARE included, so the extracted 2024 total tax differs only by Schedule 2 lines 5-7, 13 and the refundable credits) x 100% (110% if 2024 AGI over $150,000; a joint 2025 return with a non-joint 2024 return adds both spouses' tax); line 9 = smaller of 5 and 8. Part III: four installments of 25% of line 9 due 4/15/25, 6/15/25, 9/15/25, 1/15/26; **withholding is treated as paid one quarter on each due date unless shown otherwise (using actual dates is box D)**; a 2024 overpayment applied is generally treated as paid April 15, 2025; payments are applied first to the oldest unpaid installment; penalty = underpayment x days / 365 x 0.07 in each of the four rate periods (4/16-6/30/25, 7/1-9/30/25, 10/1-12/31/25, 1/1-4/15/26; period 4 follows the printed form although the IRS quarterly table shows 6% for Q2 2026); days 365 / 304 / 212 / 90 for an installment unpaid to 4/15/26. The IRS figures the penalty itself and bills it | `https://www.irs.gov/pub/irs-pdf/f2210.pdf`, `https://www.irs.gov/instructions/i2210` |
| Standard deduction with the age / blind boxes (Form 1040 line 12d) | MFJ standard deduction by boxes checked (each spouse: born before Jan 2, 1961; blind): 1 = $33,100, 2 = $34,700, 3 = $36,300, 4 = $37,900, i.e. $31,500 + $1,600 per box (the dependents worksheet line 4b also multiplies the box count by $1,600). A person is considered to reach age 65 on the day before the 65th birthday. Not for a filer who can be claimed as a dependent | `https://www.irs.gov/instructions/i1040gi` (Standard Deduction Chart for People Who Were Born Before January 2, 1961, or Were Blind) |
| Form 8995 line 11 | Taxable income before the QBI deduction = Form 1040 line 11a minus lines 12e and 13b | `https://www.irs.gov/instructions/i8995` |
| CT individual use tax | General rate 6.35% of the purchase price minus tax paid to another state (worksheet Section B); 7.75% (most motor vehicles over $50,000, jewelry over $5,000 each, clothing / footwear over $1,000 each, handbag, luggage, umbrella, wallet or watch over $1,000), 1% (computer and data processing services), 2.99% (vessels) are separate worksheet sections (not computed by the engine); CT-1040 line 15 must be "0" if none is due | `https://portal.ct.gov/-/media/drs/forms/2025/income/2025-ct-1040-instructions_1225.pdf` |
| Child tax credit (copy fix) | 2025 maximum $2,200 per qualifying child ($1,700 refundable portion); credit for other dependents $500 | `https://www.irs.gov/instructions/i1040gi` |

### Not verified (the engine emits `needs_cpa_rule_unverified`, never an estimate)

- Charitable AGI limits for gifts (60% cash to public charities): only the 30%/20% sentences were found.
  The engine therefore deducts gifts in full only up to 20% of AGI (the lowest limit that can apply) and
  flags anything above that.
- Whether home mortgage insurance premiums (1098 box 5) are deductible for 2025; treatment of points (box 6).
- Form 8829 actual-method line rules beyond the Part III basis lines; the Section 179 taxable-income
  limitation; Pub 946 Table A-1 (5- and 7-year property).
- Self-employed health insurance (Form 7206) eligibility and SEP/solo-401(k) establishment deadlines.
- Form 2210: the annualized income installment method (Schedule AI) and waiver rules (the withholding timing rule is verified above).
- Late filing / late payment penalty rates (federal) and any further extension beyond Oct 15; the CT
  late-payment minimum penalty and month-counting rule.
- CT: the printed CT tax table used for CT AGI up to $102,000; CT Schedule 3/4 forms, CT-6251, CT-2210.
- The AMT exemption phase-out reduction rate above $1,252,700, and Form 6251 Part III (preferential-rate
  AMT).

## Known real data gaps (not fabricated — genuinely missing from the system as of 2026-09-17)

See `.claude/pipeline/tax-compute-engine/00-request.md` (or wherever this build's request doc lives) for
the current list — kept there rather than duplicated here since it will change as the owner supplies
answers.
