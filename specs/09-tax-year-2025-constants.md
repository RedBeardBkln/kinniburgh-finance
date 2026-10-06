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
| Schedule 1-A (new for 2025) | Tips: max $25,000 total (not per spouse), reduced starting at MAGI $300,000 MFJ by $100 per $1,000 over (rounded down). Overtime: max $25,000 MFJ, same MAGI/reduction. Car-loan interest: max $10,000, MAGI start $200,000 MFJ, reduced $200 per $1,000 over (rounded **up**); vehicle bought in 2025, personal use, VIN, US final assembly. Seniors: $6,000 each (born before Jan 2, 1961), MAGI start $150,000 MFJ, reduced by 6% of the excess. Valid SSN required; must file jointly. Result goes to 1040 line 13b | `https://www.irs.gov/pub/irs-pdf/f1040s1a.pdf`, `https://www.irs.gov/pub/irs-prior/i1040gi--2025.pdf` (Schedule 1-A instructions, pp. 101-110) |
| Overtime reporting for 2025 | No W-2 change; the employer may show it in box 14; otherwise the taxpayer figures the FLSA overtime premium | `i1040gi` (Schedule 1-A) |
| SALT cap | $40,000 ($20,000 MFS); reduced by 30% of MAGI over $500,000; floor $10,000 | `https://www.irs.gov/instructions/i1040sca` |
| Mortgage interest limit | $750,000 of acquisition debt for loans after Dec 15, 2017 | `i1040sca` |
| Noncash gifts | Form 8283 required if the deduction is over $500 | `i1040sca` |
| Schedule SE | 92.35% (line 4a); $400 floor (line 4c); wage base $176,100 (line 7); line 8a = W-2 boxes 3 + 7; 12.4% on the smaller of line 6 or line 9; 2.9% on line 6; half to Schedule 1 line 15 | `https://www.irs.gov/pub/irs-pdf/f1040sse.pdf`, `https://www.irs.gov/instructions/i1040sse` |
| Additional Medicare Tax | Not indexed: MFJ $250,000, MFS $125,000, others $200,000; Form 8959 required if any W-2 box 5 is over $200,000 or combined wages + SE is over the threshold; Part V reconciles withholding; line 24 goes to 1040 line 25c | `https://www.irs.gov/instructions/i8959`, `i1040gi` |
| NIIT | 3.8% of the lesser of net investment income or MAGI over the threshold; MFJ $250,000 (every line of Form 8960 Parts I-III is implemented: see "Schedule 1-A line by line and Form 8960" below) | `https://www.irs.gov/instructions/i8960`, `https://www.irs.gov/pub/irs-pdf/i8960.pdf` |
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
| State / local income tax refund (Schedule 1 line 1) | None of the refund is taxable if the tax was paid in a year the filer did not itemize or deducted general sales taxes instead. Otherwise the State and Local Income Tax Refund Worksheet: line 1 = refund, at most 2024 Schedule A line 5d; line 2 = 5d - 5e when 5d is more than 5e (else line 3 = line 1); line 3 = 1 - 2; line 4 = 2024 Schedule A line 17; line 5 = 2024 standard deduction (MFJ / QSS 29,200; single / MFS 14,600; HOH 21,900); line 6 = 1,550 per box (born before Jan 2, 1960 / blind; 1,950 single or HOH); line 7 = 5 + 6; line 8 = 4 - 7; line 9 = smaller of 3 and 8. Pub. 525 applies instead for the listed exceptions (other tax year, non-income-tax refund, 0% gain rate, AMT in 2024, unused credits, dependent, last 2024 estimate paid in 2025, joint state return but not filing jointly). Connecticut: CT-1040 Schedule 1 line 42 subtracts the taxable refund reported on federal Schedule 1 line 1 (included in line 50 = CT-1040 line 4) | `https://www.irs.gov/instructions/i1040gi`, `https://www.irs.gov/publications/p525`, CT-1040 instructions |
| Child tax credit (copy fix) | 2025 maximum $2,200 per qualifying child ($1,700 refundable portion); credit for other dependents $500 | `https://www.irs.gov/instructions/i1040gi` |

### Schedule 1-A line by line and Form 8960 (verified 2026-10-04)

Read by the Planner on 2026-10-04: the blank forms `f1040s1a.pdf` and `f8960.pdf` (pdftotext; sha256 equal to
`data/forms/manifest.json`), the Instructions for Form 8960 (2025) `https://www.irs.gov/pub/irs-pdf/i8960.pdf`
(dated Feb 4, 2026) and the Schedule 1-A instructions, which are printed INSIDE the 2025 Form 1040 instructions
(pp. 101-110): `https://www.irs.gov/pub/irs-prior/i1040gi--2025.pdf` (there is no standalone `i1040s1a`; both
`/instructions/i1040s1a` and `/pub/irs-pdf/i1040s1a.pdf` return 404). Implemented in `lib/tax2025/rules/schedule-1a.ts`
(all 41 printed money lines) and `lib/tax2025/rules/form-8960.ts` (all of lines 1-17 for an individual).

| Item | Verified value | Source |
|---|---|---|
| Schedule 1-A MAGI and thresholds (all MFJ) | Line 1 = Form 1040 line 11b; line 3 = line 1 + 2e (Puerto Rico, Form 2555 lines 45 and 50, Form 4563 line 15). Tips: line 7 = smaller of line 6 or $25,000; line 9 = $300,000; line 11 = line 10 / $1,000 rounded DOWN; line 12 = x $100; line 13 = 7 - 12, not below 0. Overtime: line 15 = smaller of 14c or $25,000; line 17 = $300,000; same reduction (line 19 / $1,000 rounded down, line 20 = x $100). Car-loan interest: line 24 = smaller of 23 or $10,000; line 26 = $200,000; line 28 = line 27 / $1,000 rounded UP; line 29 = x $200. Seniors: line 32 = $150,000; line 34 = line 33 x 6%; line 35 = $6,000 - line 34, not below 0 | `i1040gi--2025.pdf` pp. 101-110, the form |
| Schedule 1-A "skip" rule | When line 10 / 18 / 27 / 33 is zero or less, lines 11-12 / 19-20 / 28-29 / 34 are skipped and the capped amount (line 7 / 15 / 24; $6,000 for seniors) goes straight on line 13 / 21 / 30 / 35. A part is filled out only when that kind of income was received | the form |
| Schedule 1-A line 4 | More than one employer: enter 0 on lines 4a and 4b and use the "Qualified Tips From More Than One Employer Worksheet" for line 4c. One employer: 4c = larger of 4a (W-2 box 7) or 4b (Form 4137). Line 5 is tips in the course of a trade or business (1099-NEC / 1099-MISC / 1099-K) | the form, `i1040gi--2025.pdf` |
| Form 8960 Part I | Line 1 = Form 1040 line 2b; line 2 = line 3b; line 3 = non-qualified annuities only; line 4a = Schedule 1 lines 3 + 5 + 6; line 4b reverses, with the opposite sign, income of a trade or business that is not passive (a sole proprietor's Schedule C when the owner materially participates); line 5a = Form 1040 line 7a (signed; a capital loss is already limited to -$3,000 by Schedule D line 21) + Schedule 1 line 4; lines 6, 7 and 10 (foreign corporations, trust distributions, net operating loss, recoveries, trading expenses) need an owner statement. Line 8 = lines 1, 2, 3, 4c, 5d, 6, 7 | `i8960.pdf` |
| Form 8960 Part II (line 9b allocation) | State and local income tax deducted on Schedule A that is attributable to net investment income may be allocated by "any reasonable method"; the instructions' own example is the ratio of gross investment income (line 8) to AGI. The engine uses it for Schedule A line 5a (income tax) when itemizing and the SALT cap does not bind (line 5e equal to 5d); when the cap binds, or when the standard deduction is used, see the rule. Constant `NIIT_ALLOCATION_METHOD`. With Eric's figures 15,591 x 6,699 / 270,980 = 385 gives line 12 = 6,314 and line 17 = 240 (255 with no allocation); another reasonable method (NII / total income) gives 240 too | `i8960.pdf` ("Reasonable method allocations", "Line 9b") |
| Form 8960 line 9a / 9c | 9a = Schedule A line 9 (investment interest) when itemizing. 9c: miscellaneous investment expenses are generally no longer deductible (P.L. 119-21 section 70110 makes the disallowance of miscellaneous itemized deductions permanent; sections 67 and 68 limitations are suspended for 2025 and the "Lines 9 and 10" worksheet is "Not for use in 2025"). Constant `NIIT_MISC_INVESTMENT_EXPENSES_DEDUCTIBLE` = false | `i8960.pdf` ("Line 9c") |
| Form 8960 Part III | Line 12 not below 0; line 13 = MAGI (AGI plus Puerto Rico / Form 2555 / Form 4563 exclusions and CFC / PFIC adjustments); line 14 = $250,000 (MFJ); line 15 = 13 - 14, not below 0; line 16 = smaller of 12 or 15; line 17 = line 16 x 3.8%. Attach Form 8960 when MAGI is over the threshold | `i8960.pdf` ("Who Must File") |

Judgment calls recorded (not rules): a sole proprietor's Schedule C result is treated as NOT net investment income (the owner materially
participates), shown as the advisory `niit-sch-c-nonpassive`; the Form 8960 line 9b allocation is a method choice shown as the advisory
`niit-allocation-9b` with the no-allocation tax; the Schedule 1-A tips occupation and the character of the overtime are owner statements
(advisory `sch1a-owner-statements`). Form 8829 (the actual home-office method) is not built: the engine states whether it is required
(not under the simplified method, decision X1) and the cover lists it as not generated when the CPA chooses the actual method.

### Form 8995 loss carryforward, Form 6251 lines 1a / 1b / 2a, Schedule A line 14 (engine ty2025-1b.6, verified 2026-10-04)

Found by the independent recalculation (the L2 oracle) and re-verified by the Planner on 2026-10-04 against the current irs.gov
PDFs (pdftotext): `https://www.irs.gov/pub/irs-pdf/f8995.pdf`, `i8995.pdf`, `f6251.pdf`, `i6251.pdf` and the 2025 Form 1040
instructions `https://www.irs.gov/instructions/i1040gi`; the Coder re-read the repo copies of the two forms
(`data/forms/2025/f8995.pdf`, `f6251.pdf`) for the printed line text and the pre-printed parentheses. The regulation text
(26 CFR 1.199A-1) was read on law.cornell.edu. Implemented in `lib/tax2025/rules/qbi-8995.ts`, `rules/screens.ts`,
`rules/schedule-a.ts`; registry ids `QBI_LOSS_CARRYFORWARD_RULE`, `AMT_SENIOR_DEDUCTION_ADDBACK`, `AMT_LINE_2A_TAXES`.

| Item | Verified value | Source |
|---|---|---|
| Form 8995 line 3 | Qualified business net (loss) carryforward from the prior year (printed "3 (   )"). The engine's line 3 is the "none" statement group `qbi_carryforwards`: 0 once the owner states no loss was carried in from 2024, otherwise the line is held (the 2024 return extraction does not read Form 8995). | form, `https://www.irs.gov/instructions/i8995` |
| Form 8995 lines 4 and 8 | Line 4 = "Combine lines 2 and 3. If zero or less, enter -0-"; line 8 = "Combine lines 6 and 7. If zero or less, enter -0-". Instructions, line 4: "If you have a qualified business net loss for the year, you don't qualify for the QBI deduction unless you have qualified REIT dividends or qualified PTP income. The loss will be carried forward to next year." Line 8: "Any negative amount will be carried forward to the next year." | form, `https://www.irs.gov/instructions/i8995` |
| Form 8995 lines 16 and 17 | Line 16 = "Total qualified business (loss) carryforward. Combine lines 2 and 3. If greater than zero, enter -0-"; line 17 = "Combine lines 6 and 7. If greater than zero, enter -0-" (both printed inside parentheses). Instructions: line 16 "is the amount to be carried forward to the next year"; line 17 "must be carried forward to next year". A negative total QBI makes the QBI component 0 and the loss is treated as negative QBI from a separate trade or business in the following year (26 CFR 1.199A-1(c)(2)(i) and (d)(2)(iii)(B)). The engine emits both lines; a Schedule C loss of $9,010 gives line 2 = -9,010, line 4 = 0, line 16 = -9,010 (a carryforward to 2026, no effect on the 2025 tax). | form, `https://www.irs.gov/instructions/i8995` |
| Form 8995 filed for a loss year | The form is where the carryforward is computed and recorded, so the engine reports Form 8995 as required when line 16 or 17 is below 0 or a carry-in (line 3 / 7) is not 0, as well as when a deduction is claimed. No primary-source sentence says the form MUST be filed when the only QBI item is a loss; filing it has no 2025 tax effect (decision D1, owner default: file). The advisory `qbi-carryforward-out` and the review-sheet card tell the owner the amount to bring into 2026. | form + instructions as above |
| Sign convention for the loss lines (Form 8995 lines 3, 7, 16, 17) | The form pre-prints parentheses on these four lines ("3 (   )", "7 (   )", "16 (   )", "17 (   )"), so the engine holds a loss as a NEGATIVE amount and the PDF map (`sign: "refund"`) prints its magnitude inside the printed parentheses: -9,010 prints as 9,010. A zero or POSITIVE amount prints blank (line 16 / 17 are "-0-" in that case). So a CPA override on line 3 or 7 (a loss carried in from 2024) or on line 16 / 17 MUST be entered as a negative number ("enter a loss as a negative number"): a positive amount would print a blank box, not an error. The override dialog says so in its help text (`amountEntryHint` in `lib/tax2025/override-input.ts`). Form 8995 lines 1i(c), 2 and 6 have no printed parentheses and keep a leading minus ("-9,010"). | form (`data/forms/2025/f8995.pdf`) |
| Form 6251 line 1a / 1b | Line 1a = "Subtract Schedule 1-A (Form 1040), line 37, from Form 1040 line 14"; line 1b = "Subtract line 1a from Form 1040 line 11b (if less than zero, enter as a negative amount)"; line 4 = "Combine lines 1b through 3". Instructions, What's New: the Schedule 1-A senior deduction "is treated as a personal exemption that is added back to alternative minimum taxable income as an adjustment under section 56(b)(5)(D)". The engine's screen no longer starts from Form 1040 line 15 (floored at 0): it uses line 11b, line 14 and Schedule 1-A line 37, and a negative line 1b is kept. A stated Schedule 1-A total has no line 37: the screen is `missing_input` unless that total is 0. | `https://www.irs.gov/instructions/i6251` |
| Form 6251 line 2a | "If filing Schedule A (Form 1040), enter the taxes from Schedule A, line 7; otherwise, enter the amount from Form 1040 or 1040-SR, line 12e". Schedule A line 7 is line 5e plus line 6 (other taxes); the engine used line 5e alone before. | `https://www.irs.gov/instructions/i6251` |
| Form 6251 line 9 | "9 Tentative minimum tax. Subtract line 8 from line 7" (line 8 is the AMT foreign tax credit); line 10 is the regular tax and line 11 the AMT. The tentative minimum tax line was labelled "line 10" in the catalog and the screen: corrected to 9. | form |
| Schedule A line 14 rounding (decision D3) | Line 14 is "Add lines 11 through 13". The 1040 instructions ("Rounding Off to Whole Dollars") say: "If you have to add two or more amounts to figure the amount to enter on a line, include cents when adding the amounts and round off only the total." That sentence can be read either way (the cents behind lines 11-13, or the printed lines). DECISION (owner default, 2026-10-04): add the PRINTED whole-dollar lines 11 + 12 + 13, so the form foots (matches the L1 footing check and the independent oracle; at most $1 different from rounding once from the cents, and the same for the household's real figures). Cash 100.40 and noncash 200.40 therefore give 100 + 200 = 300 (rounding once would print 301). The 20%-of-AGI limit test stays on the whole donation total. Note the project's other conventions differ by design (CT-1040 line 18 sums per-row rounded amounts; Schedule D footing allows +-$1). | `https://www.irs.gov/instructions/i1040gi` |
| Form 8995 not relaxed above $394,600 (decision D4) | The instructions allow Form 8995 only when taxable income before QBI is at most $394,600 MFJ ("Otherwise, use Form 8995-A"). The engine blocks above it (`needs_cpa_judgment`, no estimate) even when the household has no QBI: a Schedule C loss above the limit still has to be tracked on Form 8995-A, Schedule C is never exactly 0 for this household, and QBI sources the engine does not model (K-1, rental) are excluded only through the `other_income` statement. Left as is, deliberately. | `https://www.irs.gov/instructions/i8995` |

Not done (recommendations): the 2025 Form 8995 instructions exclude section 224 qualified tips from QBI (the engine does not model tips on
Schedule C; the household's tips are W-2); the Form 6251 screen still omits line 2b (state refund, which only lowers AMTI, so the screen is
cautious) and takes the regular tax from Form 1040 line 16 alone (the form's line 10 also adds Schedule 2 line 1z and subtracts Schedule 3
line 1); Form 8995-A is not computed.

### Mortgage insurance and CT-1040 Schedule 1 (verified 2026-10-04)

Read directly by the Planner on 2026-10-04 (curl + `pdftotext -layout` of the CT PDFs). Implemented in
`lib/tax2025/constants.ts` (`MORTGAGE_INSURANCE_PREMIUM_DEDUCTION_TY2025`, `SCHEDULE_A_LINE_8D`,
`CT_SCH1_*`), `lib/tax2025/rules/schedule-a.ts` and `lib/tax2025/rules/ct-schedule1.ts`.

| Item | Verified value | Source |
|---|---|---|
| Mortgage insurance premiums (Form 1098 box 5) | IRS Publication 936 (2025), "Reminders" (for use in preparing 2025 returns): "The itemized deduction for mortgage insurance premiums has expired. You can no longer claim the deduction." They are also not points: the "Points" section's "What is not points" list names mortgage insurance premiums ("You can't deduct these amounts as points either in the year paid or over the life of the mortgage"). The engine therefore leaves box 5 out of Schedule A line 8a, never blocks on it, and shows the amount to the CPA as an advisory open item. | `https://www.irs.gov/publications/p936` |
| Schedule A line 8d | "Reserved for future use": the 2025 Schedule A has no line for box 5 | `https://www.irs.gov/instructions/i1040sca` (Line 8d) |
| CT AGI may only be modified as the statute allows | Federal AGI may not be further modified in determining Connecticut AGI except as expressly provided by Conn. Gen. Stat. 12-701(a)(20) | CT-1040 instructions (Rev. 12/25) p. 6 |
| CT-1040 Schedule 1 additions, lines 31-37 | 31: interest on state and municipal obligations other than Connecticut that is not taxed federally (not Puerto Rico, Guam, American Samoa, U.S. Virgin Islands). 32: exempt-interest dividends from a mutual fund derived from non-Connecticut obligations (only the non-Connecticut percentage; a fund with 20% Connecticut obligations: add back 80%). 33: the part of a qualified plan lump-sum distribution for which federal Form 4972 was filed that is not on Form 1040 line 5a or Schedule D. 34: beneficiary's share of the Connecticut fiduciary adjustment if greater than zero (Schedule CT-1041 K-1). 35: loss on sale or exchange of Connecticut state and local government bonds. 36: 100% of the Section 168(k) bonus depreciation deducted in federal AGI. 36a: 80% of the Section 179 amount deducted in federal AGI. 37: other (treaty income; enrolled Mashantucket Pequot / Mohegan Tribe member losses; Connecticut income tax deducted other than on Schedule A; expenses related to Connecticut-exempt income; amortizable bond premium; U.S. agency interest exempt federally but not by Connecticut; interest on debt carried to hold exempt obligations; Manufacturing Reinvestment Account distributions; Section 457A compensation; any other required addition). 38 = total. | CT-1040 instructions pp. 6-7 |
| CT-1040 Schedule 1 subtractions, lines 39-49 | 39: interest on U.S. government obligations that federal law prohibits states from taxing (savings bonds, Treasury bills and notes), to the extent in federal AGI; Series EE: only the interest subject to federal tax after the Form 8815 exclusion; not Fannie Mae, Ginnie Mae or Freddie Mac interest; not interest on a federal refund. 40: exempt dividends from a qualifying fund (at least 50% of assets in U.S. government obligations at each quarter end), the percentage reported by the fund (a $100 dividend 55% from T-bills: $55). 41: Social Security benefit adjustment (Worksheet, instructions p. 24). 42: taxable state / local income tax refunds reported on federal Schedule 1 line 1 (0 if blank). 43: Tier 1 / Tier 2 railroad retirement (federal line 5b) not already on line 41. 44: military retirement pay. 45: 50% of Connecticut Teachers' Retirement System pay (Form 1099-R from the Board). 46: fiduciary adjustment if less than zero. 47: gain on Connecticut bonds. 48: CHET contributions, maximum $5,000 per individual / $10,000 joint, excess carried forward five years. 48a: 25% of Section 168(k) added back in the four preceding years. 48b: pension and annuity income when federal AGI is under $150,000 joint (Pension and Annuity Worksheet, pp. 24-25, from federal lines 4b and 5b). 48c: business expenses of a Chapter 420f / 420h licensee not claimed federally. 48d: ABLE contributions, same $5,000 / $10,000 cap. 49: other (tribal member income, Connecticut individual development account interest, debt carried for investments taxable only by Connecticut, related expenses, CHET distributions as designated beneficiary, bond premium, interest on Connecticut obligations included in federal income, Homecare Option earnings, Manufacturing Reinvestment Account contributions, crumbling-foundation assistance, organ and bone marrow donation costs, Bioscience Venture Capital, Fallen Hero Fund, Student Loan Reimbursement Program, share-plan stock, 25% of prior Section 179 add-backs). 50 = total, to CT-1040 line 4. | CT-1040 instructions pp. 7-10 |
| 1099-INT 2025 boxes | Box 3 = interest on U.S. savings bonds and Treasury obligations (not in box 1); box 8 = tax-exempt interest; box 9 = specified private activity bond interest | `https://www.irs.gov/instructions/i1099int` |
| 1099-DIV 2025 boxes | Box 11 = FATCA filing requirement (a checkbox); box 12 = exempt-interest dividends; box 13 = specified private activity bond interest dividends. No 1099-DIV box reports a U.S.-government-obligation percentage (the fund reports it separately). The extraction field `div_box11Cents` is labelled "box 11 exempt-interest dividends": its printed box number is stale, the engine reads it as the exempt-interest dividends (see `.claude/pipeline/ty2025-mip-ct-schedule1/`) | `https://www.irs.gov/instructions/i1099div` |
| CT line 48c chapters | Chapter 420f = Palliative Use of Marijuana; Chapter 420h = Regulation of Adult-Use Cannabis (plain-language wording only, not a constant) | `https://www.cga.ct.gov/current/pub/chap_420f.htm`, `chap_420h.htm` |

How the engine treats Schedule 1 (`rules/ct-schedule1.ts`): each of the 23 detail lines is computed from a document
total or a federal line already on the return, or is a not-applicable 0 because the owner stated "none" in the
Return-completeness questionnaire (six statements: Connecticut bond sales, U.S. government bond funds, CHET and
ABLE accounts, earlier Connecticut depreciation add-backs, other additions, other subtractions), or it is blocked
(missing input / CPA). The percentages 100, 80 and 25 are only named in reasons; no bonus / Section 179 amount is
computed from them yet.

### CT-1040 lines 3-30 and Schedules 3-4 (form text verified 2026-10-04)

Read by the Planner on 2026-10-04 from `data/forms/2025/ct1040.pdf` (Rev. 12/25, `pdftotext`) and the CT-1040
instructions (`https://portal.ct.gov/-/media/drs/forms/2025/income/2025-ct-1040-instructions_1225.pdf`, pp. 2-4, 11-14,
27); the CT-2210 rule from `https://portal.ct.gov/-/media/drs/forms/2025/income/ct-2210_1225.pdf` (sha256
`9559ebc66de7385d50f7597909e505b13786944623c5b4d950d67b5ca9fe56b8`). Implemented in `lib/tax2025/return.ts` (the CT
`derive` spine), `rules/ct.ts`, `rules/ct-credits.ts`, `rules/ct-settlement.ts`.

| Line | Form text | Engine |
|---|---|---|
| 3 | "Add Line 1 and Line 2" (federal AGI plus Schedule 1 additions, NOT CT AGI) | L1 + L2 |
| 5 | CT AGI = line 3 minus line 4 | existing |
| 7 | Credit for income taxes paid to qualifying jurisdictions (Schedule 2 line 59) | owner statement `ct_other_state_tax`; never computed here |
| 8 | Subtract line 7 from line 6; "If Line 7 is greater than Line 6, enter 0" | max(0, L6 - L7) |
| 10 | Add lines 8 and 9 | L8 + L9 |
| 11 | Property tax credit (Schedule 3 line 68); "If Line 10 is zero, skip Line 11 and Line 12 and go to Line 13" | capped at line 10 |
| 12 | Subtract line 11 from line 10; "If less than zero, enter 0" | max(0, L10 - L11) |
| 13 | Allowable credits, Schedule CT-IT Credit Part 1 line 10 | owner statement `ct_other_credits`; never computed here |
| 14 | CT income tax: subtract line 13 from line 12; "If less than zero, enter 0" | max(0, L12 - L13) |
| 15 | Use tax (Schedule 4 line 69); "If no tax is due, enter 0" | existing |
| 16 | Add lines 14 and 15 | L14 + L15 |
| 17 | "Enter amount from Line 16" | = L16 |
| 18 / 19 / 20 | withholding (18a-18e Column C, 18f from CT-1040WH), estimates and prior-year overpayment, CT-1040 EXT payment. Line 18 adds Column C; the CT W-2 instruction says to enter each box 17 amount "in whole dollars" in Column C, so line 18 is the sum of the per-W-2 rounded rows (not the rounded sum of the cents; they differ by $1 when the cents do not cancel) | existing (line 18 rounding per row since ty2025-1b.4) |
| 20a-20d | CT EITC (Schedule CT-EITC line 16, 40% of the federal EIC), claim of right credit (CT-1040 CRC line 6), pass-through entity tax credit (Schedule CT-PE line 1), historic home credit | owner statement `ct_other_credits` |
| 21 | Add lines 18, 19, 20, 20a, 20b, 20c, 20d | sum |
| 22 | "If Line 21 is more than Line 17, subtract Line 17 from Line 21" (overpayment) | max(0, L21 - L17) |
| 23 / 24 / 24a / 25 | amount applied to 2026 estimated tax / CHET (Schedule CT-CHET line 4) / charities (Schedule 5 line 70) / refund = line 22 less 23, 24, 24a | owner's irrevocable elections: 23, 24, 24a blank; 25 informational |
| 26 | "If Line 17 is more than Line 21, subtract Line 21 from Line 17" (tax due) | max(0, L17 - L21) |
| 27 / 28 | late payment penalty 10% of line 26; interest 1% per month | 0 when line 26 is 0, otherwise informational (month counting not verified) |
| 29 | Interest on underpayment of estimated tax (Form CT-2210) | see below |
| 30 | Add lines 26 through 29 | sum |
| Sch 3 | 63 = 60 + 61 + 62; 64 = $300 (pre-printed); 65 = lesser of 63 and 64; 66 = decimal (0 when CT AGI is at most $70,500 MFJ); 67 = 65 x 66; 68 = 65 - 67 | `rules/ct.ts` |
| Sch 4 | 69 = 69a + 69b + 69c + 69d | `rules/ct.ts` (rule-derived use tax is all general-rate 69b) |

CT-2210 interest threshold (`CT_ESTIMATED_TAX_INTEREST_MIN`, $1,000): Part 2 line 1 is the income tax shown on the
2025 CT-1040 (line 14), line 4 = line 1 minus CT withholding (line 3) minus the pass-through entity tax credit
(line 3a); "If the result is less than $1,000, stop here. Do not complete or file this form" and "you are not subject to
interest on the underpayment". The CT-1040 instructions (line 29) repeat the test (line 14 minus line 18 and line 20c)
and let the filer leave line 29 blank so DRS bills the interest. The engine therefore prints line 29 = 0 below the
threshold and marks it informational (CT-2210 not modeled) at or above it.

### Lines the IRS says to leave blank, reserved lines, and type / description / code entries (engine ty2025-1b.7, verified 2026-10-05)

No tax number is involved in this section: it records which printed entries the packet leaves blank on purpose and why. Sources
(verifiedOn 2026-10-05): the 2025 Form 1040 instructions, `https://www.irs.gov/pub/irs-prior/i1040gi--2025.pdf` (which also contain the
instructions of Schedules 1, 2, 3 and 1-A); the 2025 Schedule A instructions, `https://www.irs.gov/pub/irs-prior/i1040sca--2025.pdf`;
the 2025 Schedule B instructions, `https://www.irs.gov/pub/irs-prior/i1040sb--2025.pdf`. Printed page numbers are the footer
numbers of the PDF (an entry that spans a page break is given to the nearest page).

**Leave blank (modeled as a fixed zero that does not depend on any owner statement).**
- Schedule 1 line 24z: "Line 24z Leave line 24z blank." (Form 1040 instructions, Schedule 1 "Lines 24a Through 24z", printed p. 100).
  Engine: `sch1.24z` is a fixed `not_applicable` 0 (rule id `irs-leave-blank`), in no none-group; the oracle (L2) states 0 independently.
- Schedule 3 line 6z: "Line 6z. Leave line 6z blank." (Form 1040 instructions, Schedule 3 "Other Nonrefundable Credits", printed p. 116).
  Engine: `sch3.6z` is a fixed `not_applicable` 0, same rule id; the oracle states 0 independently.

**Reserved for future use (no entry exists; map reason `form_na`).**
- Schedule 1 line 22: "Line 22 has been reserved for future use." (printed p. 99).
- Schedule 2 line 10: "Line 10 has been reserved for future use." (printed p. 113).
- Schedule 3 line 6e: "Line 6e. Line 6e has been reserved for future use." (printed p. 116).
- Schedule A line 8d: "Line 8d Reserved for future use" (Schedule A instructions).
- Form 1040 "other tax year" header row (beginning, ending, "20__"): the 1040 is the calendar-year form ("For the year Jan. 1-Dec. 31, 2025, or other
  tax year beginning ... ending ..."); this return is a calendar-year return, so the row has no entry (`form_na`). Schedule SE line 7 and line 14 are
  pre-printed constants (the form's own read-only widgets, `form_na`).

**Type / description / code entries beside a line that is zero for this return (map reason `zero_line_entry`, with `follows`).** Each is blank
while the line it follows is zero or not applicable; if that line ever carries an amount (an override can supply one) the packet raises an
advisory item and the review raises `L1.B5.entry-by-hand` so the entry is written by hand. The rules that call for the entry:
- Form 1040 line 1h: "The following types of income must be included in the total on line 1h. Strike or lockout benefits (other than bona fide gifts).
  Excess elective deferrals ... If the total amount you ... deferred for 2025 under all plans was more than $23,500 ... include the excess on line 1h." (printed p. 24)
- Form 1040 line 4c: "If another publication or instruction tells you to write a word or code next to line 4b, check box 3 on line 4c and enter that word or code on the
  entry space next to box 3." (printed p. 28). Line 5c is the same for line 5b (printed p. 30).
- Schedule 1 line 7: "If you received an overpayment of unemployment compensation in 2025, subtract the amount you repaid from the total amount you received. Enter the result
  on line 7. Also, check the box on line 7 and enter the amount you repaid in the entry space." (printed p. 89)
- Schedule 1 line 8z: "List the type and amount of income. If necessary, include a statement showing the required information." (Schedule 1 "Line 8z")
- Schedule 2 line 1y: "Other additions to tax. Enter the following additions to tax ... Identify as "ARPCR." ... "EPE8933." ... "NEPE8933." ... "EPGEPE." ... "6418(g)(2)."" (printed p. 111)
- Schedule 2 line 17z: "Use line 17z to report any taxes not reported elsewhere on your return or other schedules. List the type and amount of tax." (Schedule 2 "Line 17z")
- Schedule 3 line 13z: "Use line 13z to report the credit under section 960(c) ... Enter "960(c)" and the amount of the credit ... Enter "Form 8689" and the amount paid ... Identify as "1062NL."" (printed p. 117)
- Schedule A line 6: "Enter only one total on line 6 but list the type and amount of each tax included." Line 16: "List the type and amount of each expense from the following list next to line 16 and
  enter the total of these expenses on line 16. If you are filing a paper return and you can't fit all your expenses on the dotted lines next to line 16, attach a statement instead showing the type and amount of each expense."
- Schedule 1-A line 22 (Part IV): "Enter the VIN(s) of the APV(s) on line 22, column (i). If you need to report more than two VINs, attach a statement to your return showing the information required on line 22."
  The app never stores a vehicle identification number (an identifier), and `sch1a.23` is 0 for a return with no qualifying vehicle loan, so the two rows stay blank and are written by hand if a loan ever applies.

**Entries an owner statement rules out (map reason `owner_statement_na`, with a note; the first two are `zero_line_entry` with `whenOverridden`).** The Form 1040 line 16 and Schedule 2 line 4
boxes sit beside lines that are normally not zero (the tax, the self-employment tax), so their computed amount says nothing about the box: they are raised (advisory item + `L1.B5.entry-by-hand`) only when that line has an override in force.
- Form 1040 line 16 boxes and code: "Include in the total on the entry space on line 16 all of the following taxes that apply. ... Tax from Form(s) 8814 ... Tax from Form 4972 ... Tax with respect to a section 962
  election ... Check box 3 and enter the amount and "962" ... Recapture of an education credit ... Check box 3 and enter the amount and "ECR" ... Any tax from Form 8621, line 16e, relating to a section 1291 fund ... "1291TAX"
  ... Tax from Form 8978, line 14 ... "Form 8978" ... Triggering event under section 965(i): "If you had a triggering event under section 965(i) during the year and did not enter into a transfer agreement, check box 3 and enter the amount of the triggered deferred net 965 tax liability and enter "965INC" on the line next to that box."" (printed p. 33-34 and 36, the 965(i) entry follows the standard deduction table). The engine gates line 16 on the `other_taxes` statement (rule `tax-calc`), whose wording now names these taxes.
- Schedule 2 line 4 boxes and code: "If you filed Form 4361, received IRS approval, and had no other income subject to self-employment tax, check box 1 on line 4. If you filed Form 4029 and received IRS approval, check box 2 on line 4. ...
  check box 3, and enter "EAS" ... community income ... "ECI" ... notary public ... "EN"" (printed p. 112). The `se_other` statement wording now names these exemptions.
- Schedule B line 7b: "If you are required to file FinCEN Form 114, list the name(s) of the foreign country or countries in the space provided on line 7b. Attach a separate statement if you need more space." (Schedule B instructions). The foreign-account answer is "no".
- Schedule 1 (top of page 1) Form 1099-K memo: "For 2025, enter the amount reported to you on Form(s) 1099-K that was included in error or for personal items sold at a loss." (printed on the form). The `other_income` statement wording now names it.

### Form 8606 (Nondeductible IRAs), Part I (engine ty2025-1b.8, verified 2026-10-05)

Sources (read from irs.gov with `curl` and `pdftotext` on 2026-10-05): the 2025 Form 8606 (https://www.irs.gov/pub/irs-prior/f8606--2025.pdf, 2 pages, 45 AcroForm fields,
"Created 5/7/25", attachment sequence no. 48, sha256 `748a2bf2ef45918eac8d48fab8b1958c8c0c24102b7d2103c78f6f92a69486ae`, the same bytes as https://www.irs.gov/pub/irs-pdf/f8606.pdf)
and the 2025 instructions (https://www.irs.gov/pub/irs-prior/i8606--2025.pdf). The IRA deduction numbers are in the 2025 Form 1040 instructions
(https://www.irs.gov/pub/irs-prior/i1040gi--2025.pdf, "IRA Deduction Worksheet--Schedule 1, Line 20", pp. 97-98) and Pub. 590-A; the repo constants `IRA_PHASEOUT_*` already match them.

- **Who files.** "You made nondeductible contributions to a traditional IRA for 2025." A married couple files a separate Form 8606 EACH: "If you file a joint return, enter only the name and SSN of the spouse whose information is being reported on Form 8606" (Specific Instructions). The engine has one set of lines per person (`f8606a.*` for taxpayer A, `f8606b.*` for taxpayer B) and the packet files `f8606-a.pdf` / `f8606-b.pdf`.
- **Line 1** (nondeductible contributions for 2025, "including those made for 2025 from January 1, 2026, through April 15, 2026"): "If you used the IRA Deduction Worksheet in the Form 1040 instructions ... subtract line 12 of the worksheet (or the amount you chose to deduct on Schedule 1, line 20, if less) from the smaller of line 10 or line 11 of the worksheet. Enter the result on line 1" (Line 1). Line 10 is compensation, line 11 the contribution, line 12 what is deducted. The engine emits it as `ira.<slot>.nd` from `rules/ira-deduction.ts` (smaller of compensation and contribution, minus the deduction); a contribution above the compensation that counts is an excess contribution (Form 5329), which the engine blocks rather than figures. The engine always deducts the maximum (the worksheet also allows deducting less and treating the rest as nondeductible: no choice exists for Eric, whose deduction is $0).
- **Phase-out used for the deduction** (1040 instructions, IRA Deduction Worksheet): a person NOT covered by a workplace plan whose spouse is covered: worksheet line 2 is $246,000 ("But if you checked No on either line 1a or 1b, enter $246,000 for the person who wasn't covered by a plan"), full deduction at a gap of $10,000 or more (the range is $236,000-$246,000), line 7 = gap x 70% (80% at age 50 or older), rounded up to a multiple of $10, at least $200. The person who IS covered: $146,000, gap of $20,000 or more, 35% (40%).
- **Line 2** (total basis from earlier years), 2025 Form 8606 instructions (https://www.irs.gov/pub/irs-prior/i8606--2025.pdf, "Line 2" and "Total Basis Chart--Line 2", p. 9, read 2026-10-06): "Generally, if this is the first year you are required to file Form 8606, enter -0-. Otherwise, use the Total Basis Chart to find the amount to enter on line 2." The chart: for a last Form 8606 filed "for a year after 2023 and before 2025" (the 2024 form) enter "the amount from line 14 of that Form 8606 as adjusted to include the amount from line 6 of the Line 15c Worksheet, if any, you completed the last time you filed a Form 8606 with Part I completed"; for a year after 2000 and before 2024, line 14 of that form (older rows use lines 12, 14, 7 + 16, and 4 + 13). The instructions add that line 2 may need to be more than 0 even in a first year, or adjusted, for a return of excess traditional IRA contributions, a divorce transfer, or a rollover of the nontaxable part of a workplace plan into a traditional IRA not previously reported on Form 8606 line 2. The app cannot see the 2024 Form 8606 (the 2024 return facts it holds are adjusted gross income, total tax, refund, balance and filing status only), so **line 2 is the owner's answer**: the Return completeness question `ibasis_<person>` ("In <name>'s most recent filed Form 8606 (for 2024), what is the amount on line 14 ...? Enter 0 if <name> had none or never filed one."), stored as `PersonAnswers.priorBasisCents`, per person, never negative, never checked against a document (the line's reason and the `f8606-prior-basis-check` advisory say so). A missing or "not sure" answer blocks lines 2, 3 and 14 with a plain reason (never an unstated 0); a negative amount is refused. Worked example (the owner states his 2024 form shows line 14 = $7,300; how that total was built up is not known to the app): 2025 line 1 = 7,000, line 2 = 7,300, line 3 = 14,300, line 14 = 14,300. The app does not add the Line 15c Worksheet's line 6 (only a year with a distribution has one): the question's help text tells the owner to enter the adjusted amount if it applies.
- **Line 3** = line 1 + line 2. **The form's own flow box after line 3**: "In 2025, did you take a distribution from a traditional IRA, or make a Roth IRA conversion? No: Enter the amount from line 3 on line 14. Do not complete the rest of Part I. Yes: Go to line 4." So lines 4-13 (including the year-end value of all traditional IRAs on line 6) and 15a-15c are NOT completed with no distribution and no conversion, and Parts II and III (Roth conversions and Roth distributions) are blank. The Form 5498 box 5 value is therefore carried but used by no line.
- **Line 14** = total basis in traditional IRAs for 2025 and earlier years (next year's line 2). The engine prints it only when line 2 is known, the owner stated no IRA distribution (`retirement_ss_income`) AND the `ira_basis_other` statement ("no distribution from a traditional IRA, no conversion to a Roth IRA, no recharacterization and no returned contribution in 2025") is "none"; a "Yes" to `ira_basis_other` blocks lines 2, 3 and 14 and a "Yes" to a distribution blocks line 14, with a plain-language reason (lines 4-13, 15a-15c and Parts II and III are not figured from answers: the distribution path would need a Form 1099-R document type, distribution amounts and the year-end value of all traditional / SEP / SIMPLE IRAs, none of which the app has).
- **Penalties** (constants `FORM_8606_NOT_FILED_PENALTY`, `FORM_8606_OVERSTATEMENT_PENALTY`): $50 for not filing when required, $100 for overstating nondeductible contributions, unless reasonable cause ("Penalty for Not Filing", "Overstatement Penalty").
- **When to file**: "by the due date, including extensions" of the 2025 Form 1040 ("When and Where To File").
- **Information, not engine behavior** (the app does none of these): a contribution can be recharacterized by a trustee-to-trustee transfer "by the due date of your return (including extensions) and reflect it on your return", with an attached statement; "you can't take a deduction for a contribution to a traditional IRA if you later recharacterize the amount"; a contribution returned with its earnings by the same due date is not reported on Form 8606 (the earnings go on Form 1040 lines 4a/4b); a direct Roth IRA contribution needs modified AGI under $246,000 MFJ for 2025 ("What's New") ("Recharacterizations", "Return of IRA Contributions"). If the owner does one of these (or takes a distribution or makes a conversion), the `ira_basis_other` answer becomes Yes and the engine blocks instead of printing a wrong number. The Form 5498 box 5 year-end value ($49,146.79 for the owner) is information only: line 6 is skipped when there is no distribution or conversion.
- **Form 5498 (the retirement contribution document)**: box 1 is read as a fact (`income.retirementStatements`), tied out against the owner's traditional IRA answer (a conflict when they differ; box 1 includes contributions made through April 15, 2026 for 2025) and cited on Form 8606 line 1. It never replaces the answer.

### Not verified (the engine emits `needs_cpa_rule_unverified`, never an estimate)

- Charitable AGI limits for gifts (60% cash to public charities): only the 30%/20% sentences were found.
  The engine therefore deducts gifts in full only up to 20% of AGI (the lowest limit that can apply) and
  flags anything above that.
- Treatment of points (box 6): whether they are deductible in full in the year paid depends on tests that
  cannot all be read from a Form 1098, so a Form 1098 with points is not computed. (Mortgage insurance
  premiums, box 5, ARE verified: not deductible for 2025, see above.)
- CT Social Security Benefit Adjustment Worksheet and Pension and Annuity Worksheet (instructions pp. 24-25), the CHET
  maximum / carryforward and positive bonus / Section 179 add-backs: present in the CT-1040 instructions but not built;
  the engine returns `needs_cpa_judgment` for the line if a source federal line or an owner "Yes" shows one applies.
- Form 8829 actual-method line rules beyond the Part III basis lines; the Section 179 taxable-income
  limitation; Pub 946 Table A-1 (5- and 7-year property).
- Self-employed health insurance (Form 7206) eligibility and SEP/solo-401(k) establishment deadlines.
- Form 2210: the annualized income installment method (Schedule AI) and waiver rules (the withholding timing rule is verified above).
- Late filing / late payment penalty rates (federal) and any further extension beyond Oct 15; the CT
  late-payment minimum penalty and month-counting rule.
- CT: the printed CT tax table used for CT AGI up to $102,000; CT Schedule 3/4 forms, CT-6251, the CT-2210 computation (only its $1,000 threshold is verified, above).
- The AMT exemption phase-out reduction rate above $1,252,700, and Form 6251 Part III (preferential-rate
  AMT).

## Known real data gaps (not fabricated — genuinely missing from the system as of 2026-09-17)

See `.claude/pipeline/tax-compute-engine/00-request.md` (or wherever this build's request doc lives) for
the current list — kept there rather than duplicated here since it will change as the owner supplies
answers.
