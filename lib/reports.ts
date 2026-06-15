import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export interface PLLine {
  glCodeId: string;
  code: string;
  name: string;
  total: Prisma.Decimal;
}

export interface PLReport {
  incomeLines: PLLine[];
  expenseLines: PLLine[];
  totalIncome: Prisma.Decimal;
  totalExpenses: Prisma.Decimal;
  netIncome: Prisma.Decimal;
  periodFrom: Date;
  periodTo: Date;
}

export async function computePL(
  entityId: string,
  fromDate: Date,
  toDate: Date
): Promise<PLReport> {
  // Sum amounts by GL code for non-archived, non-transfer, GL-coded transactions
  const grouped = await db.transaction.groupBy({
    by: ["glCodeId"],
    where: {
      entityId,
      archivedAt: null,
      transferPairId: null,
      glCodeId: { not: null },
      postedAt: { gte: fromDate, lte: toDate },
    },
    _sum: { amount: true },
  });

  if (grouped.length === 0) {
    return {
      incomeLines: [],
      expenseLines: [],
      totalIncome: new Prisma.Decimal(0),
      totalExpenses: new Prisma.Decimal(0),
      netIncome: new Prisma.Decimal(0),
      periodFrom: fromDate,
      periodTo: toDate,
    };
  }

  const glCodeIds = grouped.map((g) => g.glCodeId as string);
  const glCodes = await db.glCode.findMany({ where: { id: { in: glCodeIds } } });
  const glMap = new Map(glCodes.map((g) => [g.id, g]));

  const incomeLines: PLLine[] = [];
  const expenseLines: PLLine[] = [];

  for (const row of grouped) {
    const id = row.glCodeId as string;
    const gl = glMap.get(id);
    if (!gl) continue;
    const total = row._sum.amount ?? new Prisma.Decimal(0);

    if (gl.type === "income") {
      // Income transactions are positive inflows
      incomeLines.push({ glCodeId: id, code: gl.code, name: gl.name, total: total.abs() });
    } else if (gl.type === "expense") {
      // Expense transactions are negative outflows — store as positive for display
      expenseLines.push({ glCodeId: id, code: gl.code, name: gl.name, total: total.abs() });
    }
  }

  incomeLines.sort((a, b) => a.code.localeCompare(b.code));
  expenseLines.sort((a, b) => a.code.localeCompare(b.code));

  const totalIncome = incomeLines.reduce((s, l) => s.add(l.total), new Prisma.Decimal(0));
  const totalExpenses = expenseLines.reduce((s, l) => s.add(l.total), new Prisma.Decimal(0));

  return {
    incomeLines,
    expenseLines,
    totalIncome,
    totalExpenses,
    netIncome: totalIncome.sub(totalExpenses),
    periodFrom: fromDate,
    periodTo: toDate,
  };
}

const LIABILITY_TYPES = new Set(["credit_card", "mortgage", "loan"]);
const ASSET_TYPES = new Set(["checking", "savings", "investment"]);

export interface BalanceSheetLine {
  id: string;
  label: string;
  mask: string | null;
  amountCents: number;
  isLiability: boolean;
}

export interface BalanceSheetReport {
  assets: BalanceSheetLine[];
  liabilities: BalanceSheetLine[];
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  equityCents: number;
  asOfDate: Date;
}

export async function computeBalanceSheet(
  entityId: string,
  asOfDate: Date
): Promise<BalanceSheetReport> {
  const accounts = await db.account.findMany({
    where: {
      entityId,
      archivedAt: null,
      currentBalance: { not: null },
    },
  });

  const assets: BalanceSheetLine[] = [];
  const liabilities: BalanceSheetLine[] = [];

  for (const acct of accounts) {
    const balance = acct.currentBalance as Prisma.Decimal;
    const amountCents = Math.round(balance.abs().toNumber() * 100);
    const line: BalanceSheetLine = {
      id: acct.id,
      label: acct.nickname,
      mask: acct.mask,
      amountCents,
      isLiability: LIABILITY_TYPES.has(acct.accountType),
    };
    if (ASSET_TYPES.has(acct.accountType)) {
      assets.push(line);
    } else if (LIABILITY_TYPES.has(acct.accountType)) {
      liabilities.push(line);
    }
  }

  const totalAssetsCents = assets.reduce((s, a) => s + a.amountCents, 0);
  const totalLiabilitiesCents = liabilities.reduce((s, l) => s + l.amountCents, 0);

  return {
    assets,
    liabilities,
    totalAssetsCents,
    totalLiabilitiesCents,
    equityCents: totalAssetsCents - totalLiabilitiesCents,
    asOfDate,
  };
}
