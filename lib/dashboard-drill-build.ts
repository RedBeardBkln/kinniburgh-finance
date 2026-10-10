// Server-side assembly of the dashboard's drill-down payload from the month-spend model: plain strings and integer
// cents only (no Decimal reaches the client). Pure: no database, no clock, no auth. SERVER-ONLY (see the Decimal note
// in lib/month-spend.ts); it uses Decimal instance methods but imports it as a type.
import type { Decimal } from "@prisma/client/runtime/library";
import type { MonthSpendModel, SpendTag, SpendTx } from "@/lib/month-spend";
import type { EffectiveBudgets } from "@/lib/budget-effective";
import { hideTransferMask, parseOwnTransferLabel } from "@/lib/own-transfer-label";
import { buildBudgetTreeGroups, type TreeLineInput } from "@/lib/dashboard-budget-tree";
import { cadenceText, type DrillAccount, type DrillData, type DrillGroup, type DrillLine, type DrillTransfer, type DrillTx } from "@/lib/dashboard-drill";

export function toCents(d: Decimal): number {
  return d.times(100).toDecimalPlaces(0).toNumber();
}

export interface DrillBudgetRow {
  id: string;
  tagId: string;
  accountId: string;
  accountName: string;
  /** The entity the account belongs to. */
  entityName?: string | null;
  /** The stored `Budget.budgeted` (null = auto-sum). */
  rawBudgeted: Decimal | null;
  rollover: Decimal;
}

export interface DrillAccountInput {
  id: string;
  nickname: string;
  institutionName: string;
  /** The entity the account belongs to. */
  entityName?: string | null;
  accountType: string;
  currentBalance: Decimal | null;
  currentBalanceAt: Date | null;
}

export interface DrillTransferInput {
  id: string;
  fromNickname: string;
  toNickname: string;
  amount: Decimal;
  cadence: string;
  dayRules: unknown;
  purpose: string | null;
}

export interface DrillBuildInput {
  model: MonthSpendModel;
  txs: SpendTx[];
  tags: (SpendTag & { shortName: string })[];
  budgets: DrillBudgetRow[];
  effective: EffectiveBudgets;
  accounts: DrillAccountInput[];
  transfers: DrillTransferInput[];
  period: string;
  periodLabel: string;
  /** The month shown is the current one. */
  isCurrentPeriod?: boolean;
  bucket: string;
  isAllEntities: boolean;
  /** Query suffix for links back to the same month, e.g. "&period=2026-09" (empty for the current month). */
  periodQuery: string;
  /** The household's statement masks (see lib/month-spend.ts): used here only to replace a mask in a transfer label by an account name. */
  ownAccountByMask?: ReadonlyMap<string, string>;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Plain-language rule for a scheduled transfer's day rules; empty when the shape is not recognised. */
export function describeDayRules(dayRules: unknown): string {
  if (!dayRules || typeof dayRules !== "object") return "";
  const rules = dayRules as Record<string, unknown>;
  if (Array.isArray(rules["daysOfMonth"])) {
    const days = (rules["daysOfMonth"] as unknown[]).filter((d): d is number => typeof d === "number");
    if (days.length > 0) return `on the ${days.map(ordinal).join(" and ")}`;
  }
  if (typeof rules["dayOfWeek"] === "number") {
    const name = WEEKDAYS[rules["dayOfWeek"]];
    if (name) return `on ${name}s`;
  }
  if (typeof rules["dayOfMonth"] === "number") return `on the ${ordinal(rules["dayOfMonth"])}`;
  return "";
}

const BALANCE_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

/**
 * A bank transfer label carries an account mask ("... to CK x1234"). The mask is never shown: a counterpart that is one of
 * this view's accounts is named, anything else keeps the wording with the digits hidden.
 */
export function displayPayee(
  payee: string,
  ownAccountByMask: ReadonlyMap<string, string> | undefined,
  nicknameById: ReadonlyMap<string, string>
): string {
  const leg = parseOwnTransferLabel(payee);
  if (leg) {
    const counterpartId = ownAccountByMask?.get(leg.mask);
    const nickname = counterpartId ? nicknameById.get(counterpartId) : undefined;
    if (nickname) return `Transfer ${leg.direction} ${nickname}`;
  }
  // any other transfer-shaped text (extra spaces, other case, trailing words) keeps its wording with the digits hidden
  return hideTransferMask(payee);
}

export function buildDrillData(input: DrillBuildInput): DrillData {
  const { model, effective } = input;
  const tagById = new Map(input.tags.map((t) => [t.id, t]));
  const lineSpendById = new Map(model.lines.map((l) => [l.id, l]));

  // ---- transactions
  const nicknameById = new Map(input.accounts.map((a) => [a.id, a.nickname]));
  const txs: DrillTx[] = input.txs.map((t) => {
    const verdict = model.verdicts.get(t.id);
    return {
      id: t.id,
      day: t.day,
      payee: displayPayee(t.payee, input.ownAccountByMask, nicknameById),
      account: t.accountNickname,
      accountId: t.accountId,
      entity: t.entityName,
      cents: toCents(t.amount),
      cls: verdict?.cls ?? "spending",
      reason: verdict?.reason ?? "",
      pending: t.pending,
      tagIds: t.tagIds,
      tagPaths: t.tagIds.map((id) => tagById.get(id)?.name).filter((n): n is string => !!n),
      targets: verdict?.targets ?? [],
    };
  });

  // ---- lines in display order, grouped by account
  const treeInputs: (TreeLineInput & { budget: DrillBudgetRow })[] = input.budgets.map((b) => ({
    id: b.id,
    tagId: b.tagId,
    accountId: b.accountId,
    accountName: b.accountName,
    shortName: tagById.get(b.tagId)?.shortName ?? "(unknown tag)",
    fullName: tagById.get(b.tagId)?.name ?? "(unknown tag)",
    budget: b,
  }));
  const treeGroups = buildBudgetTreeGroups(treeInputs, (tagId) => tagById.get(tagId)?.parentId);

  const childrenByParent = new Map<string, string[]>();
  for (const group of treeGroups) {
    for (const row of group.rows) {
      if (row.parentId) {
        const kids = childrenByParent.get(row.parentId);
        if (kids) kids.push(row.line.id);
        else childrenByParent.set(row.parentId, [row.line.id]);
      }
    }
  }

  const lines: DrillLine[] = [];
  const groups: DrillGroup[] = [];
  for (const group of treeGroups) {
    let budgetCents = 0;
    let spentCents = 0;
    const lineIds: string[] = [];
    for (const row of group.rows) {
      const b = row.line.budget;
      const spend = lineSpendById.get(b.id);
      const resolved = effective.resolvedById.get(b.id);
      const resolvedCents = resolved ? toCents(resolved) : 0;
      const rolloverCents = toCents(b.rollover);
      const effectiveCents = resolvedCents + rolloverCents;
      const rolledCents = spend ? toCents(spend.rolledSpend) : 0;
      const ownCents = spend ? toCents(spend.ownSpend) : 0;
      const remainingCents = effectiveCents - rolledCents;
      const percentUsed = effectiveCents === 0 ? 0 : Math.min(Math.abs(rolledCents) / Math.abs(effectiveCents) * 100, 999);
      lines.push({
        id: b.id,
        tagId: b.tagId,
        label: row.line.fullName,
        shortName: row.line.shortName,
        accountId: b.accountId,
        accountName: b.accountName,
        parentId: row.parentId,
        ancestorIds: row.ancestorIds,
        depth: row.depth,
        hasChildren: row.hasChildren,
        childIds: childrenByParent.get(b.id) ?? [],
        budgetCents: resolvedCents,
        rolloverCents,
        effectiveCents,
        rawCents: b.rawBudgeted === null ? null : toCents(b.rawBudgeted),
        recurringLinked: effective.recurringLinkedIds.has(b.id),
        ownCents,
        rolledCents,
        remainingCents,
        percentUsed,
        overspent: remainingCents < 0,
        countsAsOverspent: spend?.countsAsOverspent ?? false,
        overByCents: spend ? toCents(spend.overBy) : 0,
        txIds: spend?.txIds ?? [],
      });
      lineIds.push(b.id);
      if (row.depth === 0) {
        budgetCents += resolvedCents;
        spentCents += rolledCents;
      }
    }
    const entityName = group.rows[0]?.line.budget.entityName ?? null;
    groups.push({ accountId: group.accountId, accountName: group.accountName, entityName, budgetCents, spentCents, lineIds });
  }

  // ---- accounts and transfers
  const accounts: DrillAccount[] = input.accounts.map((a) => ({
    id: a.id,
    nickname: a.nickname,
    institution: a.institutionName,
    entity: a.entityName ?? null,
    type: a.accountType,
    balanceCents: a.currentBalance ? toCents(a.currentBalance) : null,
    balanceAt: a.currentBalanceAt ? BALANCE_DATE.format(a.currentBalanceAt) : null,
  }));
  const transfers: DrillTransfer[] = input.transfers.map((t) => ({
    id: t.id,
    from: t.fromNickname,
    to: t.toNickname,
    amountCents: toCents(t.amount),
    cadence: cadenceText(t.cadence),
    rule: describeDayRules(t.dayRules),
    purpose: t.purpose,
  }));

  // ---- all-entities view: show the per-entity split of Spent (not a second blended figure)
  let entityBreakdown: DrillData["entityBreakdown"] = null;
  if (input.isAllEntities) {
    const byEntity = new Map<string, number>();
    for (const t of txs) {
      if (t.cls !== "spending" && t.cls !== "refund") continue;
      byEntity.set(t.entity, (byEntity.get(t.entity) ?? 0) - t.cents);
    }
    entityBreakdown = [...byEntity.entries()]
      .map(([entity, spentCents]) => ({ entity, spentCents }))
      .sort((a, b) => b.spentCents - a.spentCents || a.entity.localeCompare(b.entity));
  }

  const bucketQ = encodeURIComponent(input.bucket);
  return {
    period: input.period,
    periodLabel: input.periodLabel,
    isCurrentPeriod: input.isCurrentPeriod ?? false,
    isAllEntities: input.isAllEntities,
    bucket: input.bucket,
    hrefs: {
      budgets: `/budgets?bucket=${bucketQ}${input.periodQuery}`,
      envelope: `/envelope?bucket=${bucketQ}`,
      transactions: `/transactions?bucket=${bucketQ}`,
    },
    txs,
    lines,
    groups,
    rootLineIds: lines.filter((l) => l.parentId === null).map((l) => l.id),
    notInLine: model.notInAnyLine.map((b) => ({ key: `tag:${b.tagId}`, label: b.tagName, cents: toCents(b.spend), txIds: b.txIds })),
    untagged: { cents: toCents(model.untagged.spend), txIds: model.untagged.txIds },
    duplicateCents: toCents(model.duplicateAdjustment),
    excluded: model.excluded.map((g) => ({ cls: g.cls, count: g.count, cents: toCents(g.sum), txIds: g.txIds })),
    spentCents: toCents(model.spent),
    outflowCents: toCents(model.outflows),
    refundsCents: toCents(model.refunds),
    refundCount: model.refundCount,
    incomeCents: toCents(model.income),
    pendingCount: model.pendingCount,
    businessCents: toCents(model.businessTaggedSpend),
    totalBudgetedCents: toCents(effective.totalBudgeted),
    overspentCount: model.lines.filter((l) => l.countsAsOverspent).length,
    entityBreakdown,
    accounts,
    transfers,
  };
}
