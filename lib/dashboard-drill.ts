// The drill-down behind every dashboard number. The server page builds a DrillData payload (plain strings and integer
// cents, see lib/dashboard-drill-build.ts) once per request; the client turns a clicked target into a DrillView with
// the pure function below. Because both the headline and the rows come from the SAME payload, the rows add up to the
// number clicked by construction, and the dialog re-adds them on screen (sumCountedRows) so a mismatch would be visible.
//
// Client-safe: no Decimal, no database, no server imports. All arithmetic here is integer cents.
import { CLASS_CHIPS, CLASS_LABELS, CLASS_WHY, type TxClass } from "@/lib/month-spend-labels";
import { rowLabel } from "@/lib/dashboard-budget-tree";

export interface DrillTx {
  id: string;
  /** YYYY-MM-DD calendar day. */
  day: string;
  payee: string;
  account: string;
  accountId: string;
  entity: string;
  /** Signed, as the bank records it (negative = out). */
  cents: number;
  cls: TxClass;
  reason: string;
  pending: boolean;
  tagIds: string[];
  tagPaths: string[];
  targets: string[];
}

export interface DrillLine {
  /** The Budget row id. */
  id: string;
  tagId: string;
  /** Full tag path. */
  label: string;
  shortName: string;
  accountId: string;
  accountName: string;
  parentId: string | null;
  ancestorIds: string[];
  depth: number;
  hasChildren: boolean;
  childIds: string[];
  /** Resolved budget (explicit, recurring-linked or the sum of the children). */
  budgetCents: number;
  rolloverCents: number;
  effectiveCents: number;
  /** The stored amount; null when the line only adds up its children. */
  rawCents: number | null;
  recurringLinked: boolean;
  ownCents: number;
  rolledCents: number;
  remainingCents: number;
  percentUsed: number;
  overspent: boolean;
  countsAsOverspent: boolean;
  overByCents: number;
  txIds: string[];
}

export interface DrillGroup {
  accountId: string;
  accountName: string;
  /** The entity (Personal, Sudden Valley, ...) the account belongs to. */
  entityName: string | null;
  /** Sum of the resolved budget of the ROOT lines only (a parent already includes its children). */
  budgetCents: number;
  spentCents: number;
  lineIds: string[];
}

export interface DrillExcluded {
  cls: TxClass;
  count: number;
  /** Signed bank sum. */
  cents: number;
  txIds: string[];
}

export interface DrillNotInLine {
  key: string;
  label: string;
  cents: number;
  txIds: string[];
}

export interface DrillAccount {
  id: string;
  nickname: string;
  institution: string;
  /** The entity the account belongs to. */
  entity: string | null;
  type: string;
  balanceCents: number | null;
  balanceAt: string | null;
}

export interface DrillTransfer {
  id: string;
  from: string;
  to: string;
  amountCents: number;
  cadence: string;
  rule: string;
  purpose: string | null;
}

export interface DrillData {
  period: string;
  periodLabel: string;
  /** True when the month shown is the current one (the Spent card then reads "Spent This Month"). */
  isCurrentPeriod: boolean;
  isAllEntities: boolean;
  bucket: string;
  hrefs: { budgets: string; envelope: string; transactions: string };
  txs: DrillTx[];
  lines: DrillLine[];
  groups: DrillGroup[];
  rootLineIds: string[];
  notInLine: DrillNotInLine[];
  untagged: { cents: number; txIds: string[] };
  duplicateCents: number;
  excluded: DrillExcluded[];
  spentCents: number;
  outflowCents: number;
  refundsCents: number;
  refundCount: number;
  incomeCents: number;
  pendingCount: number;
  businessCents: number;
  totalBudgetedCents: number;
  overspentCount: number;
  entityBreakdown: { entity: string; spentCents: number }[] | null;
  accounts: DrillAccount[];
  transfers: DrillTransfer[];
}

export type DrillTarget =
  | { kind: "spent" }
  | { kind: "budgeted" }
  | { kind: "overspent" }
  | { kind: "line"; lineId: string }
  | { kind: "account"; accountId: string }
  | { kind: "transfer"; transferId: string }
  | { kind: "transfers" };

export interface DrillRow {
  key: string;
  txId: string | null;
  day: string | null;
  label: string;
  sub: string | null;
  account: string | null;
  tags: string | null;
  tagIds: string[] | null;
  cents: number;
  /** Rows with counts=false are context (shown muted, never added into the total). */
  counts: boolean;
  chips: string[];
  tone: "normal" | "credit" | "muted";
}

export interface DrillSection {
  key: string;
  /** A divider shown above this section (an account name, "Not in any budget line", ...). */
  heading: string | null;
  title: string;
  subtitle: string | null;
  depth: number;
  /** Shown beside the title; for a parent line it includes the nested lines. */
  subtotalCents: number | null;
  subtotalNote: string | null;
  /** For a group the headline does not count: the money in (+) and out (-) that make up its net subtotal. */
  moneyInCents?: number;
  moneyOutCents?: number;
  rows: DrillRow[];
  emptyNote: string | null;
}

export interface DrillView {
  kind: DrillTarget["kind"];
  title: string;
  subtitle: string | null;
  headline: { label: string; cents: number; unit: "money" | "count" };
  /** What the counted rows must add up to; null when the dialog is context only (accounts, transfers). */
  expected: { cents: number; unit: "money" | "count" } | null;
  /** Label for the footer sum when there is no expected figure. */
  footerLabel: string | null;
  sections: DrillSection[];
  /** Rows the headline leaves out, with the reason: grouped, never merged into the total. */
  excludedSections: DrillSection[];
  infoRows: { label: string; value: string }[];
  notes: string[];
  links: { label: string; href: string }[];
  lineEdit: { budgetId: string; rawCents: number | null; resolvedCents: number } | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Small pure helpers

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-04" -> "Sep 4". Calendar days are plain text parts: no time zone can shift them. */
export function formatDay(day: string): string {
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  const name = MONTHS[month - 1];
  return name ? `${name} ${date}` : day;
}

export function dollars(cents: number): number {
  return cents / 100;
}

function sortTx(a: DrillTx, b: DrillTx): number {
  return b.day.localeCompare(a.day) || a.payee.localeCompare(b.payee) || a.id.localeCompare(b.id);
}

function txRow(tx: DrillTx, mode: "spend" | "bank", withTags: boolean, keyPrefix: string): DrillRow {
  const chips: string[] = [];
  if (mode === "spend" && tx.cls === "refund") chips.push("Refund");
  if (mode === "bank" && tx.cls !== "spending") chips.push(CLASS_CHIPS[tx.cls]);
  if (tx.pending) chips.push("Pending");
  const cents = mode === "spend" ? -tx.cents : tx.cents;
  return {
    key: `${keyPrefix}:${tx.id}`,
    txId: tx.id,
    day: tx.day,
    label: tx.payee,
    // why a row is left out of Spent (e.g. "Transfer to your own account, not counted")
    sub: tx.cls === "spending" || tx.cls === "refund" ? null : tx.reason,
    account: tx.account,
    tags: tx.tagPaths.length > 0 ? tx.tagPaths.join(", ") : "Untagged",
    tagIds: withTags ? tx.tagIds : null,
    cents,
    counts: mode === "spend" || mode === "bank",
    chips,
    tone: mode === "spend" && tx.cls === "refund" ? "credit" : "normal",
  };
}

function rowsFor(data: DrillData, txIds: string[], mode: "spend" | "bank", withTags: boolean, keyPrefix: string, counts = true): DrillRow[] {
  const byId = txIndex(data);
  return txIds
    .map((id) => byId.get(id))
    .filter((t): t is DrillTx => t !== undefined)
    .sort(sortTx)
    .map((t) => ({ ...txRow(t, mode, withTags, keyPrefix), counts }));
}

const indexCache = new WeakMap<DrillData, Map<string, DrillTx>>();
function txIndex(data: DrillData): Map<string, DrillTx> {
  let idx = indexCache.get(data);
  if (!idx) {
    idx = new Map(data.txs.map((t) => [t.id, t]));
    indexCache.set(data, idx);
  }
  return idx;
}

function lineIndex(data: DrillData): Map<string, DrillLine> {
  return new Map(data.lines.map((l) => [l.id, l]));
}

/** Sum of the counted rows across sections (cents for money views, a row count for count views). */
export function sumCountedRows(view: Pick<DrillView, "sections" | "expected">): number {
  let total = 0;
  for (const section of view.sections) {
    for (const row of section.rows) {
      if (!row.counts) continue;
      total += view.expected?.unit === "count" ? 1 : row.cents;
    }
  }
  return total;
}

/** Sum of the counted rows when the view has no expected figure (accounts): always cents. */
export function sumRowCents(view: Pick<DrillView, "sections">): number {
  let total = 0;
  for (const section of view.sections) for (const row of section.rows) if (row.counts) total += row.cents;
  return total;
}

/** An account group's label; the All Entities view names the entity on EVERY group so equal nicknames cannot be confused. */
export function groupLabel(data: Pick<DrillData, "isAllEntities">, group: { accountName: string; entityName: string | null }): string {
  return data.isAllEntities && group.entityName ? `${group.accountName} · ${group.entityName}` : group.accountName;
}

/** Plain-language cadence of a scheduled transfer (the stored value is an enum such as semi_monthly). */
export function cadenceText(cadence: string): string {
  switch (cadence) {
    case "weekly":
      return "Weekly";
    case "biweekly":
      return "Every two weeks";
    case "semi_monthly":
      return "Semi-monthly";
    case "monthly":
      return "Monthly";
    default: {
      const words = cadence.replace(/_/g, " ").trim();
      return words ? words.charAt(0).toUpperCase() + words.slice(1) : cadence;
    }
  }
}

function lineSectionTitle(line: DrillLine): string {
  return rowLabel({ depth: line.depth, line: { id: line.id, tagId: line.tagId, accountId: line.accountId, accountName: line.accountName, shortName: line.shortName, fullName: line.label } });
}

function emptyView(kind: DrillTarget["kind"], title: string, note: string): DrillView {
  return {
    kind,
    title,
    subtitle: null,
    headline: { label: "", cents: 0, unit: "money" },
    expected: null,
    footerLabel: null,
    sections: [],
    excludedSections: [],
    infoRows: [],
    notes: [note],
    links: [],
    lineEdit: null,
  };
}

function excludedSection(data: DrillData, g: DrillExcluded): DrillSection {
  const byId = txIndex(data);
  let moneyIn = 0;
  let moneyOut = 0;
  for (const id of g.txIds) {
    const c = byId.get(id)?.cents ?? 0;
    if (c > 0) moneyIn += c;
    else moneyOut += c;
  }
  return {
    key: `excluded:${g.cls}`,
    heading: null,
    title: CLASS_LABELS[g.cls],
    subtitle: `${g.count} ${g.count === 1 ? "entry" : "entries"}. ${CLASS_WHY[g.cls]}`,
    depth: 0,
    subtotalCents: g.cents,
    subtotalNote: "net, as the bank records it (+ money in, - money out)",
    moneyInCents: moneyIn,
    moneyOutCents: moneyOut,
    rows: rowsFor(data, g.txIds, "bank", false, `x:${g.cls}`, false),
    emptyNote: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The views

export function buildDrillView(data: DrillData, target: DrillTarget): DrillView {
  switch (target.kind) {
    case "spent":
      return spentView(data);
    case "budgeted":
      return budgetedView(data);
    case "overspent":
      return overspentView(data);
    case "line":
      return lineView(data, target.lineId);
    case "account":
      return accountView(data, target.accountId);
    case "transfer":
      return transfersView(data, target.transferId);
    case "transfers":
      return transfersView(data, null);
  }
}

function spentView(data: DrillData): DrillView {
  const lines = lineIndex(data);
  const sections: DrillSection[] = [];

  // Which lines have something to show: their own rows, or a nested line that does.
  const hasRows = new Map<string, boolean>();
  function subtreeHasRows(id: string): boolean {
    const cached = hasRows.get(id);
    if (cached !== undefined) return cached;
    hasRows.set(id, false); // cycle guard
    const line = lines.get(id);
    const result = !!line && (line.txIds.length > 0 || line.childIds.some(subtreeHasRows));
    hasRows.set(id, result);
    return result;
  }

  for (const group of data.groups) {
    let first = true;
    for (const lineId of group.lineIds) {
      const line = lines.get(lineId);
      if (!line || !subtreeHasRows(lineId)) continue;
      sections.push({
        key: `line:${line.id}`,
        heading: first ? groupLabel(data, group) : null,
        title: lineSectionTitle(line),
        subtitle: null,
        depth: line.depth,
        subtotalCents: line.hasChildren ? line.rolledCents : line.ownCents,
        subtotalNote: line.hasChildren ? "including nested lines" : null,
        rows: rowsFor(data, line.txIds, "spend", false, `l:${line.id}`),
        emptyNote: null,
      });
      first = false;
    }
  }

  let firstUnbudgeted = true;
  for (const bucket of data.notInLine) {
    sections.push({
      key: bucket.key,
      heading: firstUnbudgeted ? "Not in any budget line" : null,
      title: bucket.label,
      subtitle: null,
      depth: 0,
      subtotalCents: bucket.cents,
      subtotalNote: null,
      rows: rowsFor(data, bucket.txIds, "spend", false, bucket.key),
      emptyNote: null,
    });
    firstUnbudgeted = false;
  }

  if (data.untagged.txIds.length > 0) {
    sections.push({
      key: "untagged",
      heading: "Untagged",
      title: "Untagged transactions",
      subtitle: "These have no tag yet, so no budget line can claim them.",
      depth: 0,
      subtotalCents: data.untagged.cents,
      subtotalNote: null,
      rows: rowsFor(data, data.untagged.txIds, "spend", false, "untagged"),
      emptyNote: null,
    });
  }

  if (data.duplicateCents !== 0) {
    sections.push({
      key: "duplicates",
      heading: "Correction",
      title: "Counted under more than one tag",
      subtitle: "A transaction with several tags is listed under each; this takes the repeats back out.",
      depth: 0,
      subtotalCents: -data.duplicateCents,
      subtotalNote: null,
      rows: [
        {
          key: "dup",
          txId: null,
          day: null,
          label: "Repeats removed",
          sub: null,
          account: null,
          tags: null,
          tagIds: null,
          cents: -data.duplicateCents,
          counts: true,
          chips: [],
          tone: "normal",
        },
      ],
      emptyNote: null,
    });
  }

  const infoRows: { label: string; value: string }[] = [];
  const notes: string[] = [];
  if (data.refundCount > 0) notes.push(`Net of ${data.refundCount} ${data.refundCount === 1 ? "refund" : "refunds"} (credits back on purchases); they are listed with a Refund tag.`);
  if (data.pendingCount > 0) notes.push(`Includes ${data.pendingCount} pending ${data.pendingCount === 1 ? "transaction" : "transactions"} that may still change.`);
  if (data.businessCents !== 0) {
    infoRows.push({ label: "Of this, tagged Business Expenses and paid from these accounts", value: centsText(data.businessCents) });
    notes.push("Business expenses paid from a personal account are counted where they were paid; they are labelled here, not moved.");
  }
  if (data.incomeCents !== 0 || data.excluded.some((e) => e.cls === "income")) {
    infoRows.push({ label: "Income this month (not part of Spent)", value: centsText(data.incomeCents) });
  }
  if (data.entityBreakdown) {
    for (const e of data.entityBreakdown) infoRows.push({ label: `Spent in ${e.entity}`, value: centsText(e.spentCents) });
  }

  return {
    kind: "spent",
    title: data.isCurrentPeriod ? "Spent This Month" : `Spent in ${data.periodLabel}`,
    subtitle: "Money that left your accounts or was charged to a card, net of refunds.",
    headline: { label: "Spent", cents: data.spentCents, unit: "money" },
    expected: { cents: data.spentCents, unit: "money" },
    footerLabel: null,
    sections,
    excludedSections: data.excluded.map((g) => excludedSection(data, g)),
    infoRows,
    notes,
    links: [],
    lineEdit: null,
  };
}

function budgetedView(data: DrillData): DrillView {
  const sections: DrillSection[] = data.groups.map((group, i) => {
    const lines = group.lineIds
      .map((id) => data.lines.find((l) => l.id === id))
      .filter((l): l is DrillLine => l !== undefined);
    return {
      key: `acct:${group.accountId}`,
      heading: i === 0 ? "By account" : null,
      title: groupLabel(data, group),
      subtitle: null,
      depth: 0,
      subtotalCents: group.budgetCents,
      subtotalNote: "budgeted",
      rows: lines.map((l) => {
        const chips: string[] = [];
        if (l.recurringLinked) chips.push("From linked recurring bills");
        else if (l.rawCents === null && l.hasChildren) chips.push("Adds up its nested lines");
        if (l.depth > 0) chips.push("Included in the line above");
        return {
          key: `b:${l.id}`,
          txId: null,
          day: null,
          label: lineSectionTitle(l),
          sub: null,
          account: null,
          tags: null,
          tagIds: null,
          cents: l.budgetCents,
          counts: l.depth === 0,
          chips,
          tone: l.depth === 0 ? "normal" : "muted",
        } satisfies DrillRow;
      }),
      emptyNote: null,
    };
  });
  return {
    kind: "budgeted",
    title: `Total budgeted for ${data.periodLabel}`,
    subtitle: "Top-level lines only: a parent line already includes its nested lines, so nested lines are shown but not added again.",
    headline: { label: "Total budgeted", cents: data.totalBudgetedCents, unit: "money" },
    expected: { cents: data.totalBudgetedCents, unit: "money" },
    footerLabel: null,
    sections,
    excludedSections: [],
    infoRows: [],
    notes: [],
    links: [{ label: "Open Budgets", href: data.hrefs.budgets }],
    lineEdit: null,
  };
}

function overspentView(data: DrillData): DrillView {
  const counted = data.lines.filter((l) => l.countsAsOverspent);
  const section: DrillSection = {
    key: "overspent",
    heading: null,
    title: "Lines where spending is above the budget",
    subtitle: null,
    depth: 0,
    subtotalCents: null,
    subtotalNote: null,
    rows: counted.map((l) => ({
      key: `o:${l.id}`,
      txId: null,
      day: null,
      label: lineSectionTitle(l),
      sub: `Spent ${centsText(l.rolledCents)} of ${centsText(l.effectiveCents)} (${l.accountName})`,
      account: null,
      tags: null,
      tagIds: null,
      cents: l.overByCents,
      counts: true,
      chips: ["Over by"],
      tone: "normal" as const,
    })),
    emptyNote: "No line is over its budget.",
  };
  return {
    kind: "overspent",
    title: `Overspent lines in ${data.periodLabel}`,
    subtitle: "Detailed lines, and parent lines with an amount of their own, whose spending is above the budget. A parent that only adds up its nested lines is not counted again.",
    headline: { label: "Overspent lines", cents: data.overspentCount, unit: "count" },
    expected: { cents: data.overspentCount, unit: "count" },
    footerLabel: null,
    sections: [section],
    excludedSections: [],
    infoRows: [],
    notes: [],
    links: [{ label: "Open Budgets", href: data.hrefs.budgets }],
    lineEdit: null,
  };
}

/**
 * A budget line belongs to the account that is set to PAY it (its "budgeted on" account); the spending counted in it can sit
 * on other accounts, for example a card. The subtitle names the line's account and, when different, the accounts the
 * rows are actually on.
 */
function lineSubtitle(data: DrillData, line: DrillLine): string {
  const lines = lineIndex(data);
  const ids = new Set<string>();
  const seen = new Set<string>();
  function collect(id: string): void {
    const l = lines.get(id);
    if (!l || seen.has(id)) return;
    seen.add(id);
    for (const t of l.txIds) ids.add(t);
    for (const kid of l.childIds) collect(kid);
  }
  collect(line.id);
  const byId = txIndex(data);
  const others = new Set<string>();
  for (const id of ids) {
    const tx = byId.get(id);
    if (tx && tx.accountId !== line.accountId) others.add(tx.account);
  }
  const base = `Budgeted on the ${line.accountName} account`;
  return others.size > 0 ? `${base} · spending also on ${[...others].sort().join(", ")}` : base;
}

function lineView(data: DrillData, lineId: string): DrillView {
  const lines = lineIndex(data);
  const line = lines.get(lineId);
  if (!line) return emptyView("line", "Budget line", "This budget line is not part of the month shown.");

  const sections: DrillSection[] = [];
  function visit(id: string, depth: number, seen: Set<string>): void {
    const l = lines.get(id);
    if (!l || seen.has(id)) return;
    seen.add(id);
    sections.push({
      key: `line:${l.id}`,
      heading: null,
      title: depth === 0 ? l.label : l.shortName,
      subtitle: null,
      depth,
      subtotalCents: l.hasChildren ? l.rolledCents : l.ownCents,
      subtotalNote: l.hasChildren ? "including nested lines" : null,
      rows: rowsFor(data, l.txIds, "spend", true, `l:${l.id}`),
      emptyNote: "No transactions this month.",
    });
    for (const kid of l.childIds) visit(kid, depth + 1, seen);
  }
  visit(line.id, 0, new Set());

  const notes: string[] = [];
  if (line.label === "Credit Cards" || line.label.startsWith("Credit Cards / ")) {
    notes.push("Credit card payments are not counted as spending (the purchases are counted when they are charged), so this line shows only entries tagged to it that are not payments.");
  }

  return {
    kind: "line",
    title: line.label,
    subtitle: lineSubtitle(data, line),
    headline: { label: "Spent", cents: line.rolledCents, unit: "money" },
    expected: { cents: line.rolledCents, unit: "money" },
    footerLabel: null,
    sections,
    excludedSections: [],
    infoRows: [
      { label: "Budget", value: centsText(line.budgetCents) + (line.rawCents === null && line.hasChildren ? " (adds up nested lines)" : "") },
      ...(line.rolloverCents !== 0 ? [{ label: "Carried in", value: centsText(line.rolloverCents) }] : []),
      { label: line.remainingCents < 0 ? "Over budget by" : "Remaining", value: centsText(Math.abs(line.remainingCents)) },
    ],
    notes,
    links: [{ label: "Open Budgets", href: data.hrefs.budgets }],
    lineEdit: { budgetId: line.id, rawCents: line.rawCents, resolvedCents: line.budgetCents },
  };
}

function accountView(data: DrillData, accountId: string): DrillView {
  const account = data.accounts.find((a) => a.id === accountId);
  if (!account) return emptyView("account", "Account", "This account is not part of the view shown.");
  const txIds = data.txs.filter((t) => t.accountId === accountId).map((t) => t.id);
  const owed = account.type === "credit_card" || account.type === "mortgage" || account.type === "loan";
  const infoRows: { label: string; value: string }[] = [];
  if (account.balanceCents !== null) {
    infoRows.push({ label: owed ? "Balance owed" : "Balance", value: centsText(account.balanceCents) + (account.balanceAt ? ` as of ${account.balanceAt}` : "") });
  } else {
    infoRows.push({ label: "Balance", value: "not set for this account" });
  }
  return {
    kind: "account",
    title: account.nickname,
    subtitle: data.isAllEntities && account.entity ? `${account.institution} · ${account.entity}` : account.institution,
    headline: { label: owed ? "Balance owed" : "Balance", cents: account.balanceCents ?? 0, unit: "money" },
    expected: null,
    footerLabel: `Net activity in ${data.periodLabel} (all entries on this account)`,
    sections: [
      {
        key: `acct:${accountId}`,
        heading: null,
        title: `Activity in ${data.periodLabel}`,
        subtitle: "Every entry on this account this month, including transfers and payments, as the bank records it.",
        depth: 0,
        subtotalCents: null,
        subtotalNote: null,
        rows: rowsFor(data, txIds, "bank", false, `a:${accountId}`),
        emptyNote: "No entries this month.",
      },
    ],
    excludedSections: [],
    infoRows,
    notes: [],
    links: [{ label: "Open in Transactions (all dates)", href: `${data.hrefs.transactions}&accountId=${encodeURIComponent(accountId)}&tab=all` }],
    lineEdit: null,
  };
}

function transfersView(data: DrillData, transferId: string | null): DrillView {
  const list = transferId ? data.transfers.filter((t) => t.id === transferId) : data.transfers;
  const rows: DrillRow[] = list.map((t) => ({
    key: `t:${t.id}`,
    txId: null,
    day: null,
    label: `${t.from} to ${t.to}`,
    sub: [t.cadence, t.rule, t.purpose].filter((p): p is string => !!p).join(" · "),
    account: null,
    tags: null,
    tagIds: null,
    cents: t.amountCents,
    counts: false,
    chips: [],
    tone: "normal",
  }));
  return {
    kind: transferId ? "transfer" : "transfers",
    title: transferId ? "Scheduled transfer" : "Scheduled transfers",
    subtitle: "Planned moves of your own money between accounts. These are not spending.",
    headline: { label: transferId ? "Amount each time" : "Scheduled", cents: transferId ? (list[0]?.amountCents ?? 0) : list.length, unit: transferId ? "money" : "count" },
    expected: null,
    footerLabel: null,
    sections: [
      {
        key: "transfers",
        heading: null,
        title: transferId ? "Details" : "All scheduled transfers",
        subtitle: null,
        depth: 0,
        subtotalCents: null,
        subtotalNote: null,
        rows,
        emptyNote: "None configured.",
      },
    ],
    excludedSections: [],
    infoRows: [],
    notes: [],
    links: [{ label: "Open Envelope", href: data.hrefs.envelope }],
    lineEdit: null,
  };
}

/** Sub-line under the Total Budgeted card; the All Entities view says so, like the Spent card does. */
export function budgetedSubline(isAllEntities: boolean): string {
  return `Top-level lines · click for the lines${isAllEntities ? " · all entities combined" : ""}`;
}

export function centsText(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}$${whole}.${frac}`;
}
