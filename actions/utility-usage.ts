"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { todayForNewYork } from "@/lib/upcoming-ledger";
import { loadSeasonalLines } from "@/lib/seasonal-energy-build";
import { siteFactsFor, type EnergyKind } from "@/lib/seasonal-energy";
import { isMissingUsageTable } from "@/lib/utility-usage-build";
import { archiveRow, findLiveRows, insertRows } from "@/lib/utility-usage-store";
import {
  COLUMN_ROLES,
  MAX_COLUMNS,
  classifyAgainstLive,
  parseUsageText,
  planWrites,
  type ColumnRole,
  type ParseOk,
  type ParsedRow,
  type UsageKind,
  type UsageUnit,
} from "@/lib/utility-usage-parse";

// Owner actions for the usage history in the Seasonal card on /forecast (lib/utility-usage-parse.ts + lib/utility-usage-store.ts).
// Every export starts with `await requireAuth();` (a test pins it). The text is parsed ON THE SERVER, both for the preview and
// again, with the same mapping, for the save: the client never sends parsed rows, so what is saved is exactly what was
// previewed (and re-classified against the rows that are saved NOW). Nothing is ever deleted: a replaced or removed row is
// archived. The AuditLog rows carry ids, kind and counts only, never a quantity, a cost, a note or the pasted text.

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

type PreviewResult = { success: true; preview: ParseOk } | { error: string };
type SaveResult = { success: true; inserted: number; replaced: number; skipped: number; unchanged?: boolean } | { error: string };
type ArchiveResult = { success: true } | { error: string };

const KIND_WORD: Record<EnergyKind, string> = { electric: "Electric", oil: "Oil", firewood: "Firewood" };
const NOT_SET_UP = "Usage history is not set up yet (the database update that adds it has not been applied).";

const kindSchema = z.enum(["electric", "oil", "firewood"]);
const unitSchema = z.enum(["cord", "face_cord"]);
const roleSchema = z.enum(COLUMN_ROLES as unknown as [ColumnRole, ...ColumnRole[]]);
const textSchema = z.string().max(1_000_000);
const oneLine = z.string().max(300).regex(/^[^\r\n]*$/, "single line");

const previewSchema = z.object({
  entityId: z.string().uuid(),
  kind: kindSchema,
  text: textSchema,
  mapping: z.array(roleSchema).max(MAX_COLUMNS).optional(),
  defaultUnit: unitSchema.optional(),
});

const saveSchema = z.object({
  entityId: z.string().uuid(),
  kind: kindSchema,
  text: textSchema,
  mapping: z.array(roleSchema).max(MAX_COLUMNS),
  defaultUnit: unitSchema.optional(),
  replaceKeys: z.array(z.string().max(200)).max(700),
  skipBadRows: z.boolean(),
});

const monthSchema = z.object({
  entityId: z.string().uuid(),
  kind: kindSchema,
  month: oneLine,
  quantity: oneLine,
  unit: unitSchema.optional(),
  cost: oneLine.optional(),
  note: oneLine.optional(),
  replace: z.boolean().optional(),
});

const archiveSchema = z.object({ entityId: z.string().uuid(), id: z.string().uuid() });

function todayIso(): string {
  return todayForNewYork(new Date()).toISOString().slice(0, 10);
}

/** The house must exist, not be archived, and have a seasonal line of that kind (the budget lines decide, as for the card). */
async function siteFor(entityId: string, kind: EnergyKind): Promise<{ ok: true; solarLiveFrom: string | null } | { ok: false; error: string }> {
  const entity = await db.entity.findFirst({ where: { id: entityId, archivedAt: null }, select: { id: true, slug: true } });
  if (!entity) return { ok: false, error: "Invalid request" };
  let has = false;
  try {
    const lines = await loadSeasonalLines();
    has = lines.some((l) => l.entityId === entityId && l.kind === kind);
  } catch {
    return { ok: false, error: "The budget lines could not be read just now, so nothing was saved. Try again." };
  }
  if (!has) return { ok: false, error: `That house has no ${KIND_WORD[kind]} line.` };
  return { ok: true, solarLiveFrom: siteFactsFor(entity.slug)?.solarLiveFrom ?? null };
}

/** Parses on the server and classifies against the rows saved right now. */
async function parseAndClassify(input: {
  entityId: string;
  kind: UsageKind;
  text: string;
  mapping?: readonly ColumnRole[];
  defaultUnit?: UsageUnit;
  solarLiveFrom: string | null;
}): Promise<{ ok: true; parsed: ParseOk; rows: ParsedRow[] } | { ok: false; error: string }> {
  const parsed = parseUsageText({
    kind: input.kind,
    text: input.text,
    today: todayIso(),
    mapping: input.mapping,
    defaultUnit: input.defaultUnit,
    site: { solarLiveFrom: input.solarLiveFrom },
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.mappingError) return { ok: true, parsed, rows: [] };
  try {
    const live = await findLiveRows(input.entityId, input.kind);
    return { ok: true, parsed, rows: classifyAgainstLive(input.kind, parsed.rows, live) };
  } catch (err) {
    if (isMissingUsageTable(err)) return { ok: false, error: NOT_SET_UP };
    console.error("Utility usage read failed", err instanceof Error ? err.name : "UnknownError");
    return { ok: false, error: "The saved history could not be read just now. Try again." };
  }
}

function withCounts(parsed: ParseOk, rows: ParsedRow[]): ParseOk {
  const counts = { new: 0, unchanged: 0, conflict: 0, fills_cost: 0, duplicate_in_file: 0, error: 0 };
  const periods = new Set<string>();
  for (const r of rows) {
    counts[r.status] += 1;
    if (r.status !== "error" && r.period) periods.add(r.period);
  }
  const sorted = [...periods].sort();
  return { ...parsed, rows, summary: { rowCount: rows.length, months: periods.size, first: sorted[0] ?? null, last: sorted[sorted.length - 1] ?? null, counts } };
}

/** Reads the pasted or uploaded text and shows what a save would do. Writes nothing. */
export async function previewUtilityUsage(input: {
  entityId: string;
  kind: UsageKind;
  text: string;
  mapping?: ColumnRole[];
  defaultUnit?: UsageUnit;
}): Promise<PreviewResult> {
  await requireAuth();
  const p = previewSchema.safeParse(input);
  if (!p.success) return { error: "Invalid request" };
  const site = await siteFor(p.data.entityId, p.data.kind);
  if (!site.ok) return { error: site.error };
  const r = await parseAndClassify({ ...p.data, solarLiveFrom: site.solarLiveFrom });
  if (!r.ok) return { error: r.error };
  return { success: true, preview: withCounts(r.parsed, r.rows) };
}

/** Saves what the preview showed: re-parses the same text with the same mapping, re-checks against the saved rows, writes in one transaction. */
export async function saveUtilityUsage(input: {
  entityId: string;
  kind: UsageKind;
  text: string;
  mapping: ColumnRole[];
  defaultUnit?: UsageUnit;
  replaceKeys: string[];
  skipBadRows: boolean;
}): Promise<SaveResult> {
  const user = await requireAuth();
  const p = saveSchema.safeParse(input);
  if (!p.success) return { error: "Invalid request" };
  const { entityId, kind } = p.data;
  const site = await siteFor(entityId, kind);
  if (!site.ok) return { error: site.error };
  const r = await parseAndClassify({ entityId, kind, text: p.data.text, mapping: p.data.mapping, defaultUnit: p.data.defaultUnit, solarLiveFrom: site.solarLiveFrom });
  if (!r.ok) return { error: r.error };
  if (r.parsed.mappingError) return { error: r.parsed.mappingError };
  const planned = planWrites(r.rows, { replaceKeys: p.data.replaceKeys, skipBadRows: p.data.skipBadRows });
  if (!planned.ok) return { error: planned.error };
  const { insert, archiveIds, replaced, skipped } = planned.plan;
  if (insert.length === 0) return { success: true, inserted: 0, replaced: 0, skipped, unchanged: true };

  const batchId = randomUUID();
  let result;
  try {
    result = await insertRows({ entityId, kind, userId: user.id, batchId, source: "upload", rows: insert, archiveIds });
  } catch (err) {
    if (isMissingUsageTable(err)) return { error: NOT_SET_UP };
    console.error("Utility usage save failed", err instanceof Error ? err.name : "UnknownError");
    return { error: "The history could not be saved just now. Nothing was changed." };
  }
  if (!result.ok) return { error: result.error };
  await db.auditLog.create({
    data: {
      changedBy: user.id,
      changeType: "utility_usage_import",
      before: Prisma.JsonNull,
      after: { entityId, kind, batchId, inserted: result.inserted, replaced, skipped },
    },
  });
  revalidatePath("/forecast");
  return { success: true, inserted: result.inserted, replaced, skipped };
}

function csvField(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** One month (or one delivery / purchase) typed in by hand. It goes through the SAME parser and checks as an upload. */
export async function addUtilityUsageMonth(input: {
  entityId: string;
  kind: UsageKind;
  month: string;
  quantity: string;
  unit?: UsageUnit;
  cost?: string;
  note?: string;
  replace?: boolean;
}): Promise<SaveResult> {
  const user = await requireAuth();
  const p = monthSchema.safeParse(input);
  if (!p.success) return { error: "Invalid request" };
  const { entityId, kind } = p.data;
  const site = await siteFor(entityId, kind);
  if (!site.ok) return { error: site.error };

  const mapping: ColumnRole[] = ["month", "quantity", "cost", "note"];
  const header = ["Month", "Quantity", "Cost", "Note"];
  const cells = [p.data.month, p.data.quantity, p.data.cost ?? "", p.data.note ?? ""];
  const text = `${header.join(",")}\n${cells.map(csvField).join(",")}\n`;
  const r = await parseAndClassify({ entityId, kind, text, mapping, defaultUnit: p.data.unit, solarLiveFrom: site.solarLiveFrom });
  if (!r.ok) return { error: r.error };
  if (r.parsed.mappingError) return { error: r.parsed.mappingError };
  const row = r.rows[0];
  if (!row || r.rows.length !== 1) return { error: "That row could not be read." };
  if (row.status === "error") return { error: row.errors.join("; ") };
  const planned = planWrites([row], { replaceKeys: p.data.replace && row.key ? [row.key] : [], skipBadRows: false });
  if (!planned.ok) return { error: planned.error };
  if (row.status === "unchanged" || row.status === "duplicate_in_file") return { success: true, inserted: 0, replaced: 0, skipped: 1, unchanged: true };
  if (row.status === "conflict" && !p.data.replace) {
    return { error: "That month already has a different value saved. Tick Replace to archive the old one and save this one." };
  }
  const { insert, archiveIds, replaced, skipped } = planned.plan;
  const batchId = randomUUID();
  let result;
  try {
    result = await insertRows({ entityId, kind, userId: user.id, batchId, source: "manual", rows: insert, archiveIds });
  } catch (err) {
    if (isMissingUsageTable(err)) return { error: NOT_SET_UP };
    console.error("Utility usage save failed", err instanceof Error ? err.name : "UnknownError");
    return { error: "The row could not be saved just now. Nothing was changed." };
  }
  if (!result.ok) return { error: result.error };
  await db.auditLog.create({
    data: {
      changedBy: user.id,
      changeType: "utility_usage_add",
      before: Prisma.JsonNull,
      after: { entityId, kind, batchId, inserted: result.inserted, replaced },
    },
  });
  revalidatePath("/forecast");
  return { success: true, inserted: result.inserted, replaced, skipped };
}

/** Archives one saved row (it leaves the history table and the model; nothing is deleted). */
export async function archiveUtilityUsage(input: { entityId: string; id: string }): Promise<ArchiveResult> {
  const user = await requireAuth();
  const p = archiveSchema.safeParse(input);
  if (!p.success) return { error: "Invalid request" };
  const { entityId, id } = p.data;
  const entity = await db.entity.findFirst({ where: { id: entityId, archivedAt: null }, select: { id: true } });
  if (!entity) return { error: "Invalid request" };
  let res;
  try {
    res = await archiveRow({ entityId, id, userId: user.id });
  } catch (err) {
    if (isMissingUsageTable(err)) return { error: NOT_SET_UP };
    console.error("Utility usage archive failed", err instanceof Error ? err.name : "UnknownError");
    return { error: "The row could not be removed just now. Nothing was changed." };
  }
  if (!res.ok) return { error: "That row was not found (it may already be removed)." };
  await db.auditLog.create({
    data: { changedBy: user.id, changeType: "utility_usage_archive", before: Prisma.JsonNull, after: { entityId, id, kind: res.kind } },
  });
  revalidatePath("/forecast");
  return { success: true };
}
