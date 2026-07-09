import { db } from "@/lib/db";
import { monthlyEquivalentCents } from "@/lib/recurring-expenses";

function fmt(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDollars(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function monthYear(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export async function buildAdvisorContext(): Promise<string> {
  const now = new Date();
  const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000);

  const [
    goals,
    accounts,
    latestNetWorth,
    currentBudgets,
    recentTx,
    incomeSources,
    recurringExpenses,
    upcomingBookings,
    insurancePolicies,
    scheduledTransfers,
  ] = await Promise.all([
    db.financialGoal.findMany({ where: { status: "active" }, orderBy: { priority: "asc" } }),
    db.account.findMany({
      where: { archivedAt: null },
      include: { entity: { select: { name: true, type: true } }, institution: { select: { name: true } } },
      orderBy: { nickname: "asc" },
    }),
    db.netWorthSnapshot.findFirst({ orderBy: { date: "desc" } }),
    db.budget.findMany({
      where: { period: currentPeriod },
      include: { tag: true, entity: { select: { name: true } } },
    }),
    db.transaction.findMany({
      where: { postedAt: { gte: ninetyDaysAgo }, archivedAt: null },
      include: { tags: { include: { tag: { select: { name: true } } } } },
      orderBy: { postedAt: "desc" },
    }),
    db.incomeSource.findMany({
      where: { active: true },
      include: { entity: { select: { name: true } }, account: { select: { nickname: true } } },
    }),
    db.recurringExpense.findMany({
      include: { entity: { select: { name: true } }, tag: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
    db.rentalBooking.findMany({
      where: { endDate: { gte: now } },
      orderBy: { startDate: "asc" },
    }),
    db.insurancePolicy.findMany({
      where: { archivedAt: null },
      include: { entity: { select: { name: true } } },
    }),
    db.scheduledTransfer.findMany({
      where: { active: true },
      include: { fromAccount: { select: { nickname: true } }, toAccount: { select: { nickname: true } } },
    }),
  ]);

  const lines: string[] = [];
  const h2 = (s: string) => lines.push(`\n## ${s}`);
  const li = (s: string) => lines.push(`- ${s}`);
  const tx = (s: string) => lines.push(s);

  tx(`# Financial Snapshot — ${now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`);

  // ── Goals ────────────────────────────────────────────────────────────────────
  h2("Financial Goals");
  if (goals.length === 0) {
    tx("No goals defined yet.");
  } else {
    const priorityLabel = (p: number) => p === 1 ? "High" : p === 2 ? "Medium" : "Low";
    for (const g of goals) {
      let line = `[${priorityLabel(g.priority)} priority] ${g.title} (${g.category})`;
      if (g.targetAmountCents) {
        line += ` — target: ${fmt(g.targetAmountCents)}`;
        if (g.currentAmountCents) {
          const pct = ((g.currentAmountCents / g.targetAmountCents) * 100).toFixed(0);
          line += `, progress: ${fmt(g.currentAmountCents)} (${pct}%)`;
        }
      }
      if (g.targetDate) line += `, by ${monthYear(new Date(g.targetDate))}`;
      li(line);
      if (g.description) tx(`  Notes: ${g.description}`);
    }
  }

  // ── Accounts ─────────────────────────────────────────────────────────────────
  h2("Account Balances");
  const byEntity = new Map<string, typeof accounts>();
  for (const a of accounts) {
    const key = a.entity.name;
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key)!.push(a);
  }
  for (const [entityName, accts] of byEntity) {
    tx(`**${entityName}:**`);
    for (const a of accts) {
      const bal = a.currentBalance ? fmtDollars(Number(a.currentBalance)) : "balance unknown";
      const when = a.currentBalanceAt
        ? ` (as of ${new Date(a.currentBalanceAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`
        : "";
      li(`${a.nickname} [${a.accountType}] ${a.institution.name}: ${bal}${when}`);
    }
  }

  // ── Net worth ─────────────────────────────────────────────────────────────────
  if (latestNetWorth) {
    h2("Net Worth");
    tx(`As of ${shortDate(new Date(latestNetWorth.date))}`);
    li(`Net worth: ${fmt(latestNetWorth.netWorthCents)}`);
    li(`Total assets: ${fmt(latestNetWorth.totalAssetsCents)}`);
    li(`Total liabilities: ${fmt(latestNetWorth.totalLiabilitiesCents)}`);
  }

  // ── Current month budget ──────────────────────────────────────────────────────
  if (currentBudgets.length > 0) {
    h2(`Budget Performance — ${currentPeriod}`);

    // Aggregate actual spend from transactions this month by tagId
    const actualByTag = new Map<string, number>();
    for (const t of recentTx.filter((t) => new Date(t.postedAt) >= startOfMonth)) {
      const amt = Number(t.amount);
      if (amt >= 0) continue; // skip income
      for (const tt of t.tags) {
        const key = tt.tag.name;
        actualByTag.set(key, (actualByTag.get(key) ?? 0) + Math.abs(amt));
      }
    }

    let totalBudgeted = 0;
    let totalActual = 0;
    for (const b of currentBudgets) {
      const budgeted = Number(b.budgeted);
      const actual = actualByTag.get(b.tag.name) ?? 0;
      const variance = budgeted - actual;
      totalBudgeted += budgeted;
      totalActual += actual;
      const status = variance >= 0 ? `under by ${fmtDollars(variance)}` : `OVER by ${fmtDollars(Math.abs(variance))}`;
      li(`${b.tag.shortName} (${b.entity.name}): budgeted ${fmtDollars(budgeted)}, spent ${fmtDollars(actual)} — ${status}`);
    }
    tx(`Total budgeted: ${fmtDollars(totalBudgeted)} | Total spent: ${fmtDollars(totalActual)} | Net: ${fmtDollars(totalBudgeted - totalActual)}`);
  }

  // ── Cash flow (30 and 90 day) ─────────────────────────────────────────────────
  h2("Cash Flow");
  const last30 = recentTx.filter((t) => new Date(t.postedAt) >= thirtyDaysAgo);
  const last30Income = last30.filter((t) => Number(t.amount) > 0).reduce((s, t) => s + Number(t.amount), 0);
  const last30Expenses = last30.filter((t) => Number(t.amount) < 0).reduce((s, t) => s + Math.abs(Number(t.amount)), 0);
  const last90Income = recentTx.filter((t) => Number(t.amount) > 0).reduce((s, t) => s + Number(t.amount), 0);
  const last90Expenses = recentTx.filter((t) => Number(t.amount) < 0).reduce((s, t) => s + Math.abs(Number(t.amount)), 0);
  tx("Last 30 days:");
  li(`Income: ${fmtDollars(last30Income)}`);
  li(`Expenses: ${fmtDollars(last30Expenses)}`);
  li(`Net: ${fmtDollars(last30Income - last30Expenses)}`);
  tx("Last 90 days:");
  li(`Income: ${fmtDollars(last90Income)}`);
  li(`Expenses: ${fmtDollars(last90Expenses)}`);
  li(`Net: ${fmtDollars(last90Income - last90Expenses)}`);

  // ── Top spending categories (30d) ─────────────────────────────────────────────
  const spendByTag = new Map<string, number>();
  for (const t of last30.filter((t) => Number(t.amount) < 0)) {
    for (const tt of t.tags) {
      const key = tt.tag.name;
      spendByTag.set(key, (spendByTag.get(key) ?? 0) + Math.abs(Number(t.amount)));
    }
  }
  if (spendByTag.size > 0) {
    h2("Top Spending Categories (Last 30 Days)");
    [...spendByTag.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .forEach(([tag, amount]) => li(`${tag}: ${fmtDollars(amount)}`));
  }

  // ── Income sources ────────────────────────────────────────────────────────────
  h2("Regular Income Sources");
  if (incomeSources.length === 0) {
    tx("None configured.");
  } else {
    for (const s of incomeSources) {
      li(`${s.description} (${s.entity.name}): ${fmtDollars(Number(s.amount))} ${s.cadence} → ${s.account.nickname}`);
    }
  }

  // ── Recurring expenses ────────────────────────────────────────────────────────
  h2("Recurring Expenses");
  const totalMonthlyRecurring = recurringExpenses.reduce(
    (sum, e) => sum + monthlyEquivalentCents(e.amountCents, e.frequency) / 100,
    0
  );
  tx(`Total monthly equivalent: ${fmtDollars(totalMonthlyRecurring)}`);
  for (const e of recurringExpenses) {
    const mo = monthlyEquivalentCents(e.amountCents, e.frequency) / 100;
    li(`${e.name} (${e.entity?.name ?? "—"}): ${fmtDollars(e.amountCents / 100)} ${e.frequency}${mo !== e.amountCents / 100 ? ` ≈ ${fmtDollars(mo)}/mo` : ""}`);
  }

  // ── Scheduled transfers ───────────────────────────────────────────────────────
  if (scheduledTransfers.length > 0) {
    h2("Scheduled Transfers (Automation)");
    for (const t of scheduledTransfers) {
      li(`${t.fromAccount.nickname} → ${t.toAccount.nickname}: ${fmtDollars(Number(t.amount))} ${t.cadence}`);
    }
  }

  // ── Rental income ─────────────────────────────────────────────────────────────
  if (upcomingBookings.length > 0) {
    h2("Upcoming Rental Revenue (Sudden Valley)");
    const totalRental = upcomingBookings.reduce((s, b) => s + Number(b.grossEarnings), 0);
    tx(`Total upcoming confirmed revenue: ${fmtDollars(totalRental)}`);

    // Group by month
    const byMonth = new Map<string, number>();
    for (const b of upcomingBookings) {
      const key = monthYear(new Date(b.payoutDate));
      byMonth.set(key, (byMonth.get(key) ?? 0) + Number(b.grossEarnings));
    }
    for (const [mo, total] of byMonth) {
      li(`${mo}: ${fmtDollars(total)}`);
    }
    tx("Bookings:");
    for (const b of upcomingBookings) {
      li(`${b.guest}: ${shortDate(new Date(b.startDate))} – ${shortDate(new Date(b.endDate))} (${b.nights} nights) — ${fmtDollars(Number(b.grossEarnings))}`);
    }
  }

  // ── Insurance ─────────────────────────────────────────────────────────────────
  if (insurancePolicies.length > 0) {
    h2("Insurance Policies");
    const totalMonthlyPremiums = insurancePolicies.reduce(
      (s, p) => s + (p.monthlyPremiumCents ?? 0) / 100,
      0
    );
    tx(`Total monthly premiums: ${fmtDollars(totalMonthlyPremiums)}`);
    for (const p of insurancePolicies) {
      let line = `${p.insurer} (${p.policyType}, ${p.entity.name})`;
      if (p.monthlyPremiumCents) line += ` — ${fmt(p.monthlyPremiumCents)}/mo`;
      if (p.faceAmountCents) line += `, coverage: ${fmt(p.faceAmountCents)}`;
      if (p.effectiveDate) line += `, effective: ${shortDate(new Date(p.effectiveDate))}`;
      li(line);
    }
  }

  return lines.join("\n");
}
