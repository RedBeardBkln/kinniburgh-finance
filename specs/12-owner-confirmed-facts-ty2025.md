# 12. Owner-confirmed facts, TY2025 (and what carries forward)

Status: written 2026-10-07 at the end of the TY2025 self-preparation work. These are facts the owner (Eric Kinniburgh) confirmed himself or that were read from documents he verified. They are NOT tax rules (those live in `specs/09-*`, each with an irs.gov / ct.gov source) and they are NOT verified by this app beyond the documents. **Read this before asking the owner a question, and update it (and `OWNER_STATEMENTS_TY2025` in `lib/tax-review/llm/owner-statements.ts`, currently version 5) whenever a fact changes.** No Social Security numbers, EINs, account numbers, or dates of birth belong in this file.

## How the platform uses this

- The engine computes only from documents, recorded answers and decisions; it never reads this file.
- The AI Return Reviewer is shown a scrubbed, allow-listed subset of these facts (`OWNER_STATEMENTS_TY2025`, no names, addresses or entity names) so it stops asking about settled points. The recorded decisions and their reasons are also sent: keep the reasons consistent with this file (an out-of-date reason produced false findings once).
- For a future tax year: start from this file, re-confirm only what could have changed (employers, balances, the estate, the properties), then add a `specs/12-...-tyYYYY.md`. A runtime carry-forward store now exists (table `TaxFact`, migration `20261010000000_tax_facts`, owner page `/tax/facts`, code in `lib/tax-facts/**`): append-only versioned facts, each with a carry-forward policy, loaded from this file by an owner-triggered, idempotent seed whose every entry is anchored to a verbatim sentence here (a test enforces it). The store is a recall aid only: it is NOT read by the engine, the return fingerprint or the AI reviewer, and `OWNER_STATEMENTS_TY2025` is still maintained by hand. The migration is applied only with the owner's explicit OK.

## Household and roles

- Joint (MFJ) return of Eric Kinniburgh ("Taxpayer M") and Eva-Laura Ramirez-Wisiackas ("Taxpayer F"). No children, no electric vehicle, no dependents. Eric is the self-preparer of record (the CPA retired); no paid review wanted; the AI reviewer is software, not a CPA.
- Eric materially participates in Eric Kinniburgh Consulting, LLC (Schedule C). Sudden Valley Property Management LLC was formed Feb 2026 (not a 2025 item). Mezzo is not formed and is left out of discussions until the owner adds it manually.

## Income documents (verified)

- W-2 box 1 total 273,291; Connecticut withholding 15,591.07. Eric: two employers through PEOs (Rippling PEO 1 and TriNet HR III); the second has Social Security tax 2,147 over the cap, so the excess Social Security credit is 2,147 (Schedule 3 line 11, two employers). Eva-Laura: Seacoast Mushrooms (box 14 OT PREMIUM 2,408; FLSA-covered, non-exempt employee, owner statement) and Fox Farm Brewery (box 7 tips 4,545.80, job on the IRS tipped-occupation list; box 12 code D 540.89; retirement-plan box checked; box 8 blank). No single employer paid over 200,000 (Additional Medicare Tax owed, none withheld). Schedule 1-A line 13b = tips 4,546 + overtime 2,408 = 6,954; no car-loan or senior amounts.
- Interest: TD Bank 1,124.32; PennyMac 13.72; estate savings-bond interest 1,894.50 (see Estate). Dividends about 4. No 1099-G; the 348 CT refund is not taxable (2024 took the standard deduction). No 1099-NEC/MISC/K beyond the documents.
- Robinhood 1099-B: short-term box A proceeds 5,872.31, cost 5,285.50, wash sale 5.99; long-term box D 17,001.68 / 12,037.28. One Form 8949 summary row per category (codes M and W), broker detail pages attached. No carryover from 2024, no other broker adjustments.

## EK Consulting (Schedule C) and decisions

- Receipts 6,000; expenses 13,705; loss 7,705. Software expenses are all for the LLC and 2025. No single item over 2,500, nothing to depreciate, no de minimis safe-harbor statement. No 2025 business mileage. No SE health insurance or SE retirement plan. GL tagging complete.
- Decisions recorded by the owner (with reasons): X1 home office = simplified (a 2025 loss allows nothing either way; revisit for 2026 if profitable); X5 56 Arbor Rd property tax = deduct on Schedule A; X6 Internet & Phone business share = 50% (owner statement, no document); X7 federal overpayment = refund all; X8 CT overpayment = refund all (no CHET, no charity contribution; bank lines are hand-entered).

## Retirement, donations, payments

- 7,000 traditional IRA contribution (Eric) made in 2025, nondeductible (AGI above the phase-out end; Eva-Laura is covered at work). Form 8606 prior basis 7,300 (owner-sourced; not confirmable from the 2024 return); basis carried to 2026 is 14,300. Betterment Form 5498 on file.
- Donations: 100 cash to Waterford Public Library on 2025-12-23 with a written acknowledgment (Schedule A line 11). A 2,800 noncash gift dated 2026-02-11 is a 2026 gift.
- No federal or CT estimated payments for 2025; no 2024 overpayment applied; no 2024 CT balance paid. No margin or investment interest. No Section 965(i) event.

## Homes

- 27 Old Barry Rd (primary residence): the PennyMac loan on the Form 1098 bought it (home acquisition debt, interest 18,882.69, real estate taxes 6,143.22, mortgage insurance premiums not deductible); motor-vehicle tax 540.78 on Schedule A line 5c; solar installed 2022 with the credit already taken (no 2025 Form 5695). A barn office / food-lab structure: depreciation and Form 8829 are a 2026+ question.
- 56 Arbor Rd, Griswold (second home, no mortgage; "other property A"): a warranty deed filed with the town in March 2019 gave Eva-Laura a 90% joint tenancy (right of survivorship) with her mother; her mother died August 2024 and Eva-Laura became the sole beneficiary; probate completed December 2025 (distribution letter dated December 9, 2025). 2025 property tax 3,283.90, both installments paid in 2025 from personal funds, deducted on Schedule A line 5b (X5). About 90,000 of 2025 renovations paid with estate cash are capital improvements (not deducted). Personal second home in 2025; short-term rental (stays under 7 days) through Sudden Valley only from April 2026. The 2019 deed was not a gift (owner statement); whether a gift tax return was needed is OPEN.

## Estate of Eva-Laura's mother (Patricia Wisiackas)

- Eva-Laura is executor and sole beneficiary; the estate has its own EIN. The estate's 2024 Form 1041 was filed: no bond interest (the bonds had not been cashed), no Schedule K-1 ever issued, 2024 bank interest under 2. No final 2024 Form 1040 was filed for the mother.
- The savings bonds were cashed in 2025: a 2025 Form 1099-INT was issued to the estate (box 3 = 1,894.50; boxes 1, 2, 4 blank; no redemption date). The estate's 2025 Form 1041 has not been filed. Decision (2026-10-07): report the 1,894.50 on the 2025 joint return as interest passing from the estate (line 2b; Schedule B payer names the estate; CT Schedule 1 line 39 subtracts it; Form 8815 exclusion statement = none), to be matched by the estate's final Schedule K-1. No estate account or security was in Eva-Laura's own name in 2025 earning interest or dividends.

## Open items (do not close without the owner)

Estate 2025 Form 1041 and K-1 for 1,894.50 (probably late; the app cannot build a 1041); the 2024 Form 1041 period (an estate's first year normally starts at the date of death) and whether the mother needed a final 2024 Form 1040; the 2019 deed gift-tax question; the basis of 56 Arbor Rd for 2026 depreciation; written confirmation from Seacoast that the 2,408 is FLSA overtime premium; re-check CT line 39 against a Schedule CT-1041 K-1 when it exists.
