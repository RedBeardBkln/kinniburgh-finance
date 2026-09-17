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
  consistent post-OBBBA summaries (Venable LLP SALT Alert, HCVT, Bipartisan Policy Center) — not yet
  cross-checked against the actual 2025 Schedule A instructions/worksheet; do that before finalizing if
  MAGI is anywhere near the $500,000 phase-down threshold (unlikely to bind at this household's income
  level, but verify rather than assume).

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

## Known real data gaps (not fabricated — genuinely missing from the system as of 2026-09-17)

See `.claude/pipeline/tax-compute-engine/00-request.md` (or wherever this build's request doc lives) for
the current list — kept there rather than duplicated here since it will change as the owner supplies
answers.
