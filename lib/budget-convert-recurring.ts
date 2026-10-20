// Pure, client-safe helpers for "Convert to recurring expense" on /budgets: which lines can be converted, which parent
// categories they can move under, and the plain-language preview shown BEFORE the owner confirms. The write itself is
// `convertBudgetLineToRecurring` in actions/budgets.ts, which re-checks every rule on the server.

import { monthlyEquivalentCents } from "@/lib/recurring-expenses";

export interface ConvertTag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

export interface ConvertLine {
  tagId: string;
  frequency: string;
  /** The stored amount in dollars; null = auto-sum (nothing to convert). */
  budgetedRaw: number | null;
  /** Recurring expenses already linked to THIS line's tag. */
  recurringCount: number;
}

export interface ConvertParentLine {
  /** The line's resolved budgeted figure in dollars. */
  budgeted: number;
  additionalAmountCents: number;
  /** Monthly sum of the recurring expenses already linked to it, in cents (0 = none). */
  recurringMonthlySumCents: number;
}

export interface ConvertRecurring {
  name: string;
  tagId: string | null;
  amountCents: number;
  frequency: string;
}

/** The tag's ancestors, nearest first (cycle-safe). */
export function ancestorTags(tagId: string, tags: readonly ConvertTag[]): ConvertTag[] {
  const byId = new Map(tags.map((t) => [t.id, t]));
  const out: ConvertTag[] = [];
  const seen = new Set<string>([tagId]);
  let next = byId.get(tagId)?.parentId ?? null;
  while (next && !seen.has(next)) {
    seen.add(next);
    const tag = byId.get(next);
    if (!tag) break;
    out.push(tag);
    next = tag.parentId;
  }
  return out;
}

/** Why a line cannot be converted (null = it can). Mirrors the server's refusals. */
export function convertBlockReason(line: ConvertLine, tags: readonly ConvertTag[]): string | null {
  if (ancestorTags(line.tagId, tags).length === 0) return "This category has no parent category to move under.";
  if (line.frequency !== "monthly") return "Only a monthly line can be converted to a recurring expense.";
  if (line.budgetedRaw === null || line.budgetedRaw <= 0) return "Set an amount on this line before converting it.";
  if (line.recurringCount > 0) {
    return "This line already takes its amount from recurring expenses. Move them to another budget line first.";
  }
  return null;
}

/** The ancestor offered first: the nearest one with a budget line this month, else the direct parent. */
export function defaultParentId(ancestors: readonly ConvertTag[], budgetedTagIds: ReadonlySet<string>): string | null {
  return (ancestors.find((a) => budgetedTagIds.has(a.id)) ?? ancestors[0])?.id ?? null;
}

function sameName(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
}

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export interface ConvertPreview {
  name: string;
  amountCents: number;
  /** An existing recurring expense of the same name under the parent: nothing new is created. */
  duplicate: ConvertRecurring | null;
  /** What happens to the parent line's budgeted figure (null when nothing changes). */
  parentEffect: string | null;
}

export function convertPreview(args: {
  lineShortName: string;
  lineBudgeted: number;
  parent: ConvertTag;
  /** The parent's budget line in the month shown, or null when it has none. */
  parentLine: ConvertParentLine | null;
  /** The entity's recurring expenses. */
  recurring: readonly ConvertRecurring[];
}): ConvertPreview {
  const { lineShortName, lineBudgeted, parent, parentLine, recurring } = args;
  const amountCents = Math.round(lineBudgeted * 100);
  const duplicate = recurring.find((r) => r.tagId === parent.id && sameName(r.name, lineShortName)) ?? null;
  if (duplicate) return { name: lineShortName, amountCents, duplicate, parentEffect: null };

  let parentEffect: string;
  if (!parentLine) {
    parentEffect = `${parent.shortName} has no budget line this month, so this amount is not in any budget total until it has one.`;
  } else if (parentLine.recurringMonthlySumCents > 0) {
    const before = Math.round(parentLine.budgeted * 100);
    parentEffect = `The ${parent.shortName} budget goes from ${usd(before)} to ${usd(before + amountCents)}.`;
  } else {
    const before = Math.round(parentLine.budgeted * 100);
    const after = parentLine.additionalAmountCents + amountCents;
    parentEffect =
      `The ${parent.shortName} budget will come from its recurring expenses: ${usd(after)} instead of ${usd(before)} today. ` +
      "Add its other bills as recurring expenses too, or raise its additional buffer.";
  }
  return { name: lineShortName, amountCents, duplicate: null, parentEffect };
}

/** "$21.26 monthly" for a recurring expense. */
export function describeRecurring(r: ConvertRecurring): string {
  return r.frequency === "monthly"
    ? `${usd(r.amountCents)} monthly`
    : `${usd(r.amountCents)} ${r.frequency} (${usd(monthlyEquivalentCents(r.amountCents, r.frequency))} a month)`;
}
