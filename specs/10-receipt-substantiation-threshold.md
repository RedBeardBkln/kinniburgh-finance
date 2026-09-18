# 10 — Receipt Substantiation Threshold

Sourced 2026-09-18 directly from primary/official material (IRS Publication 463 and the underlying
Treasury Regulation), not blog summaries. Written because an existing checklist item in this app
(`prisma/seed.ts`'s EKC checklist, "Collect receipts for deductions > $250") appears to conflate this
rule with a **different, unrelated** IRS provision — see "Known confusion" below. Any code that
auto-flags a transaction as needing a receipt must cite this file, not re-derive or guess the number.

## The real rule: $75, not $250

**IRS Publication 463 / Treas. Reg. §1.274-5(c)(2)(iii): a formal receipt is not required for an
expense under $75** (lodging is the one exception — always requires a receipt regardless of amount).
Above $75, the taxpayer must keep a receipt. Below $75, a receipt specifically isn't required, but the
underlying expense still must be substantiated some other way (amount, date, place, business purpose) —
the $75 line only removes the *receipt* requirement, not the recordkeeping requirement itself.

**Scope caveat — read before applying broadly.** The codified $75 rule in Pub. 463 / §1.274-5 is stated
for **travel, transportation, gift, and entertainment** expenses specifically. There is no equivalently
codified dollar threshold for ordinary business expenses generally (office supplies, software,
professional services, etc.) — those are governed by the general recordkeeping requirement (IRC §6001),
which doesn't specify a dollar floor at all; technically every deductible business expense should be
substantiated regardless of amount. In practice, $75 is the figure commonly applied as a receipt-required
threshold across all expense categories by bookkeeping tools and practitioners (Expensify, Ramp, Brex all
described this way in the sources reviewed), since it's the only codified per-expense dollar line the IRS
actually publishes. **Recommendation for this app: apply $75 as the receipt-required threshold across all
EK Consulting expense categories** (not just travel/T&E) as a practical, defensible default — but the
code and any user-facing copy must describe it accurately ("commonly-applied $75 threshold," not
"IRS requires receipts for all expenses over $75") so it isn't overstated as a universal codified rule.

## Known confusion — the $250 figure is a different, unrelated rule

$250 is real, but it's **IRC §170(f)(8) — written acknowledgment required for a single charitable
contribution of $250 or more** — a completely different provision (personal itemized charitable
deductions, not business expense substantiation). The existing checklist text
("Collect receipts for deductions > $250") likely picked this number up by conflating the two rules.
**Recommend fixing that checklist item's wording** to reference the real $75 business-expense threshold
instead, next time it's touched.

## What this does NOT cover

- Mileage/vehicle expense substantiation has its own separate rules (a mileage log, not a per-expense
  receipt) — already tracked via `MileageEntry`, unaffected by this file.
- Meals: the $75 receipt threshold applies, but meals also have a 50%-deductible-in-general rule
  (with some exceptions) that this file doesn't address — that's a tax-computation question, not a
  receipt-substantiation one; don't conflate the two when this constant is used.
- This file is about *when a receipt is required*, not about *how much of an expense is deductible*.

## Sources

IRS Publication 463 (Travel, Gift, and Car Expenses), `irs.gov/publications/p463`; Treas. Reg.
§1.274-5(c)(2)(iii). Cross-checked against multiple independent secondary summaries (Ramp, Brex,
Shoeboxed, Fyle) that all state the same $75 figure and travel/T&E scoping — consistent across
independent sources, unlike some of tonight's earlier CT tax-bracket secondary-source errors.
