// One definition of "spent this month" for the dashboard, /budgets and the drill-down dialogs.
//
// Pure: no database, no clock. SERVER-ONLY (imports Decimal as a value; a "use client" file must only `import type`
// from here, see lib/budget-nesting.ts for why). Amounts follow the app-wide rule: negative = outflow, positive =
// inflow; "spent" figures are positive dollars (money that left, net of refunds).
//
// Every transaction of the month falls in exactly one CLASS:
//   spending      money out that is a real cost (cash, card charges, the cash leg of a mortgage payment)
//   refund        money in on a spending row (a credit, a return); it REDUCES spent
//   income        money in under an Income / Revenue tag; shown separately, never in spent
//   own_transfer  a paired transfer, or tagged Transfer In / Transfer Out (moving your own money)
//   card_payment  either leg of a credit card payment (the charge was already counted when it was swiped)
//   loan_account  a row on a mortgage / loan account (the cash payment from the funding account is the spend)
// spent = outflows of class spending minus inflows of class refund. The parts (budget lines, "not in any budget line",
// "untagged") add back up to spent exactly; a tx carrying several tags is shown under each and a correcting amount
// removes the repeats (zero today, kept as a guard).
import { Decimal } from "@prisma/client/runtime/library";

import { EXCLUDED_CLASSES, type TxClass } from "@/lib/month-spend-labels";
import { parseOwnTransferLabel } from "@/lib/own-transfer-label";

export { EXCLUDED_CLASSES, CLASS_LABELS, CLASS_WHY, CLASS_CHIPS, type TxClass } from "@/lib/month-spend-labels";

export interface SpendTag {
  id: string;
  /** Full path, e.g. "Food & Drink / Groceries". */
  name: string;
  parentId: string | null;
}

export interface SpendTx {
  id: string;
  /** Calendar day, YYYY-MM-DD (stored date-only values sit at UTC midnight). */
  day: string;
  amount: Decimal;
  payee: string;
  accountId: string;
  accountNickname: string;
  accountType: string;
  entityId: string;
  entityName: string;
  pending: boolean;
  transferPairId: string | null;
  tagIds: string[];
}

export interface SpendLineInput {
  id: string;
  tagId: string;
  accountId: string;
  /** The amount that counts for the line (explicit or the auto-sum of its children). */
  resolved: Decimal;
  /** The amount the line states itself; null = it only adds up its children. */
  explicit: Decimal | null;
  /** Carried in from earlier months (positive = underspend). */
  rollover: Decimal;
}

export interface LineSpend {
  id: string;
  tagId: string;
  accountId: string;
  parentLineId: string | null;
  rootLineId: string;
  hasChildren: boolean;
  /** Net spend of transactions this line owns directly. */
  ownSpend: Decimal;
  /** Own spend plus every nested child line's rolled spend. */
  rolledSpend: Decimal;
  /** resolved + rollover */
  effectiveBudget: Decimal;
  /** Counts toward "Overspent Lines": a detailed line, or a parent with a stated amount, whose spend exceeds its budget. */
  countsAsOverspent: boolean;
  overBy: Decimal;
  /** Transaction ids this line owns directly (a multi-tag tx can appear under several lines). */
  txIds: string[];
}

export interface TagBucket {
  tagId: string;
  tagName: string;
  spend: Decimal;
  txIds: string[];
}

export interface ExcludedGroup {
  cls: TxClass;
  count: number;
  /** Signed sum as the bank records it (negative = out). */
  sum: Decimal;
  txIds: string[];
}

export interface TxVerdict {
  cls: TxClass;
  reason: string;
  /** Where the spend of this tx is shown: "line:<id>", "tag:<id>" or "untagged". Empty for excluded classes. */
  targets: string[];
}

export interface MonthSpendModel {
  /** Net money spent: outflows of class spending minus refunds. */
  spent: Decimal;
  outflows: Decimal;
  refunds: Decimal;
  refundCount: number;
  /** Signed sum of income-class rows (money in). */
  income: Decimal;
  excluded: ExcludedGroup[];
  pendingCount: number;
  lines: LineSpend[];
  rootLineIds: string[];
  notInAnyLine: TagBucket[];
  untagged: TagBucket;
  /** Amount to subtract from the parts to land on spent when a tx carries several tags (usually 0). */
  duplicateAdjustment: Decimal;
  /** Of spent, the part tagged under Business Expenses and paid from these accounts (not moved, only labelled). */
  businessTaggedSpend: Decimal;
  /** parts - duplicateAdjustment === spent, computed from the parts. */
  reconciles: boolean;
  /** Signed sum of every transaction in the month, all classes (what a naive SUM(amount) would show). */
  signedTotal: Decimal;
  verdicts: Map<string, TxVerdict>;
  txCount: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Periods

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidPeriod(value: string): boolean {
  return PERIOD_RE.test(value);
}

/** The calendar month "now" falls in for a person in New York, as YYYY-MM (not the UTC month). */
export function currentPeriodNY(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value ?? String(now.getUTCFullYear());
  const month = parts.find((p) => p.type === "month")?.value ?? String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** UTC bounds [start, end) of a YYYY-MM period; stored dates are date-only at UTC midnight. */
export function periodBounds(period: string): { start: Date; end: Date } {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Classification

const TRANSFER_TAGS = new Set(["Transfer In", "Transfer Out"]);
const CARD_PAYMENT_ROOT = "Credit Cards";
/** Under Credit Cards but a real cost: interest charged by the card. */
const CARD_SUBTREE_EXEMPT = new Set(["Credit Cards / Interest paid"]);
const INCOME_TAG_NAMES = new Set(["Income", "Misc. / Income"]);
const BUSINESS_ROOT = "Business Expenses";

function lastSegment(name: string): string {
  const i = name.lastIndexOf(" / ");
  return i < 0 ? name : name.slice(i + 3);
}

/** The tag and every ancestor, nearest first. Guards against a cyclic parent chain. */
export function tagChain(tagId: string, tagById: Map<string, SpendTag>): SpendTag[] {
  const out: SpendTag[] = [];
  const seen = new Set<string>();
  let cur = tagById.get(tagId);
  while (cur && !seen.has(cur.id)) {
    out.push(cur);
    seen.add(cur.id);
    cur = cur.parentId ? tagById.get(cur.parentId) : undefined;
  }
  return out;
}

function chainHas(chain: SpendTag[], test: (t: SpendTag) => boolean): boolean {
  return chain.some(test);
}

function isTransferChain(chain: SpendTag[]): boolean {
  return chainHas(chain, (t) => TRANSFER_TAGS.has(t.name));
}
function isCardPaymentChain(chain: SpendTag[]): boolean {
  if (chain.length > 0 && CARD_SUBTREE_EXEMPT.has(chain[0]!.name)) return false;
  // A business card-payment tag ("... / Credit card payment") is the same kind of money movement.
  if (chain.length > 0 && lastSegment(chain[0]!.name).toLowerCase() === "credit card payment") return true;
  return chainHas(chain, (t) => t.name === CARD_PAYMENT_ROOT);
}
function isIncomeChain(chain: SpendTag[]): boolean {
  return chainHas(chain, (t) => INCOME_TAG_NAMES.has(t.name) || lastSegment(t.name) === "Revenue");
}
function isBusinessChain(chain: SpendTag[]): boolean {
  return chainHas(chain, (t) => t.name === BUSINESS_ROOT);
}

/**
 * Account masks that identify exactly ONE active account of the household (mask -> account id), built by the caller from
 * the Account table. A mask shared by two accounts, or belonging to an archived or foreign account, must NOT be in it.
 * It is used only to classify a bank-labelled transfer and is never shown or put in a payload.
 */
export type OwnAccountByMask = ReadonlyMap<string, string>;

/**
 * Decide the class of one transaction. Uses the tag tree, the account type and (only for the bank's own transfer wording,
 * validated against the household's active account masks) the transfer label; never a guess from other payee text.
 */
export function classifyTx(
  tx: SpendTx,
  tagById: Map<string, SpendTag>,
  ownAccountByMask?: OwnAccountByMask
): { cls: TxClass; reason: string } {
  if (tx.transferPairId) return { cls: "own_transfer", reason: "Paired transfer between your own accounts" };
  if (tx.accountType === "mortgage" || tx.accountType === "loan") {
    return { cls: "loan_account", reason: "Entry on a mortgage or loan account" };
  }
  const chains = tx.tagIds.map((id) => tagChain(id, tagById));
  if (chains.some(isTransferChain)) return { cls: "own_transfer", reason: "Tagged Transfer In or Transfer Out" };
  // A pending transfer has no pair yet (the other leg has not posted) and may be untagged. The bank's transfer wording
  // plus a mask that is exactly one active account of the household, other than the row's own, is still a transfer.
  const leg = ownAccountByMask ? parseOwnTransferLabel(tx.payee) : null;
  if (leg) {
    const counterpart = ownAccountByMask?.get(leg.mask);
    if (counterpart && counterpart !== tx.accountId) {
      return {
        cls: "own_transfer",
        reason: leg.direction === "to" ? "Transfer to your own account, not counted" : "Transfer from your own account, not counted",
      };
    }
  }
  if (chains.some(isCardPaymentChain)) return { cls: "card_payment", reason: "Credit card payment" };
  if (chains.some(isIncomeChain)) return { cls: "income", reason: "Tagged as income or revenue" };
  return tx.amount.isNegative() || tx.amount.isZero()
    ? { cls: "spending", reason: "Money out" }
    : { cls: "refund", reason: "Money back on a spending row" };
}

// ---------------------------------------------------------------------------------------------------------------------
// The model

const zero = () => new Decimal(0);

export function buildMonthSpend(
  txs: SpendTx[],
  tags: SpendTag[],
  lines: SpendLineInput[],
  opts: { ownAccountByMask?: OwnAccountByMask } = {}
): MonthSpendModel {
  const tagById = new Map(tags.map((t) => [t.id, t]));

  // ---- lines: one owner per tag (first wins), same-account direct-parent nesting (matches lib/budget-nesting)
  const lineByTagId = new Map<string, SpendLineInput>();
  for (const line of lines) if (!lineByTagId.has(line.tagId)) lineByTagId.set(line.tagId, line);

  const accountTagToLine = new Map<string, string>();
  for (const line of lines) accountTagToLine.set(`${line.accountId}|${line.tagId}`, line.id);
  const parentOf = new Map<string, string | null>();
  const childrenOf = new Map<string, string[]>();
  for (const line of lines) {
    const parentTagId = tagById.get(line.tagId)?.parentId ?? null;
    const parentLineId = parentTagId ? accountTagToLine.get(`${line.accountId}|${parentTagId}`) ?? null : null;
    const safeParent = parentLineId && parentLineId !== line.id ? parentLineId : null;
    parentOf.set(line.id, safeParent);
    if (safeParent) {
      const kids = childrenOf.get(safeParent);
      if (kids) kids.push(line.id);
      else childrenOf.set(safeParent, [line.id]);
    }
  }

  function nearestLine(tagId: string): SpendLineInput | undefined {
    for (const t of tagChain(tagId, tagById)) {
      const hit = lineByTagId.get(t.id);
      if (hit) return hit;
    }
    return undefined;
  }

  const verdicts = new Map<string, TxVerdict>();
  const ownSpend = new Map<string, Decimal>(lines.map((l) => [l.id, zero()]));
  const ownTxIds = new Map<string, string[]>(lines.map((l) => [l.id, []]));
  const tagBuckets = new Map<string, TagBucket>();
  const untagged: TagBucket = { tagId: "", tagName: "Untagged", spend: zero(), txIds: [] };
  const excludedByClass = new Map<TxClass, ExcludedGroup>();

  let outflows = zero();
  let refunds = zero();
  let refundCount = 0;
  let income = zero();
  let pendingCount = 0;
  let duplicateAdjustment = zero();
  let businessTaggedSpend = zero();
  let signedTotal = zero();

  for (const tx of txs) {
    signedTotal = signedTotal.plus(tx.amount);
    const { cls, reason } = classifyTx(tx, tagById, opts.ownAccountByMask);

    if (cls !== "spending" && cls !== "refund") {
      verdicts.set(tx.id, { cls, reason, targets: [] });
      let group = excludedByClass.get(cls);
      if (!group) {
        group = { cls, count: 0, sum: zero(), txIds: [] };
        excludedByClass.set(cls, group);
      }
      group.count += 1;
      group.sum = group.sum.plus(tx.amount);
      group.txIds.push(tx.id);
      if (cls === "income") income = income.plus(tx.amount);
      continue;
    }

    const spend = tx.amount.negated(); // positive for money out, negative for a refund
    if (cls === "spending") outflows = outflows.plus(spend);
    else {
      refunds = refunds.plus(tx.amount);
      refundCount += 1;
    }
    if (tx.pending) pendingCount += 1;

    // Where is the spend shown? One target per distinct line / unbudgeted tag; none tagged = untagged.
    const targets: string[] = [];
    const seen = new Set<string>();
    let business = false;
    for (const tagId of tx.tagIds) {
      if (!tagById.has(tagId)) continue;
      if (isBusinessChain(tagChain(tagId, tagById))) business = true;
      const line = nearestLine(tagId);
      const key = line ? `line:${line.id}` : `tag:${tagId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(key);
    }
    if (targets.length === 0) targets.push("untagged");
    if (business) businessTaggedSpend = businessTaggedSpend.plus(spend);
    duplicateAdjustment = duplicateAdjustment.plus(spend.times(targets.length - 1));

    for (const target of targets) {
      if (target === "untagged") {
        untagged.spend = untagged.spend.plus(spend);
        untagged.txIds.push(tx.id);
      } else if (target.startsWith("line:")) {
        const id = target.slice(5);
        ownSpend.set(id, (ownSpend.get(id) ?? zero()).plus(spend));
        ownTxIds.get(id)?.push(tx.id);
      } else {
        const tagId = target.slice(4);
        let bucket = tagBuckets.get(tagId);
        if (!bucket) {
          bucket = { tagId, tagName: tagById.get(tagId)?.name ?? "Unknown tag", spend: zero(), txIds: [] };
          tagBuckets.set(tagId, bucket);
        }
        bucket.spend = bucket.spend.plus(spend);
        bucket.txIds.push(tx.id);
      }
    }
    verdicts.set(tx.id, { cls, reason, targets });
  }

  // ---- roll the lines up the nested tree
  const rolled = new Map<string, Decimal>();
  const inProgress = new Set<string>();
  function roll(id: string): Decimal {
    const cached = rolled.get(id);
    if (cached !== undefined) return cached;
    if (inProgress.has(id)) return zero();
    inProgress.add(id);
    let sum = ownSpend.get(id) ?? zero();
    for (const kid of childrenOf.get(id) ?? []) sum = sum.plus(roll(kid));
    inProgress.delete(id);
    rolled.set(id, sum);
    return sum;
  }
  function rootOf(id: string): string {
    const seenIds = new Set<string>();
    let cur = id;
    while (!seenIds.has(cur)) {
      seenIds.add(cur);
      const p = parentOf.get(cur);
      if (!p) return cur;
      cur = p;
    }
    return cur;
  }

  const lineSpends: LineSpend[] = lines.map((line) => {
    const hasChildren = (childrenOf.get(line.id) ?? []).length > 0;
    const rolledSpend = roll(line.id);
    const effectiveBudget = line.resolved.plus(line.rollover);
    const overBy = rolledSpend.minus(effectiveBudget);
    const detailedOrStated = !hasChildren || line.explicit !== null;
    return {
      id: line.id,
      tagId: line.tagId,
      accountId: line.accountId,
      parentLineId: parentOf.get(line.id) ?? null,
      rootLineId: rootOf(line.id),
      hasChildren,
      ownSpend: ownSpend.get(line.id) ?? zero(),
      rolledSpend,
      effectiveBudget,
      countsAsOverspent: detailedOrStated && overBy.isPositive() && !overBy.isZero(),
      overBy,
      txIds: ownTxIds.get(line.id) ?? [],
    };
  });

  const rootLineIds = lineSpends.filter((l) => l.parentLineId === null).map((l) => l.id);
  const notInAnyLine = [...tagBuckets.values()].sort((a, b) => b.spend.comparedTo(a.spend) || a.tagName.localeCompare(b.tagName));

  const spent = outflows.minus(refunds);

  let parts = untagged.spend;
  for (const l of lineSpends) if (l.parentLineId === null) parts = parts.plus(l.rolledSpend);
  for (const b of notInAnyLine) parts = parts.plus(b.spend);
  const reconciles = parts.minus(duplicateAdjustment).equals(spent);

  const excluded = EXCLUDED_CLASSES.map((c) => excludedByClass.get(c)).filter((g): g is ExcludedGroup => g !== undefined);

  return {
    spent,
    outflows,
    refunds,
    refundCount,
    income,
    excluded,
    pendingCount,
    lines: lineSpends,
    rootLineIds,
    notInAnyLine,
    untagged,
    duplicateAdjustment,
    businessTaggedSpend,
    reconciles,
    signedTotal,
    verdicts,
    txCount: txs.length,
  };
}
