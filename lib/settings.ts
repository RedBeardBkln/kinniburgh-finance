import { db } from "@/lib/db";
import { DEFAULT_TAX_RESERVE_PCT } from "@/lib/business-quarter-forecast";
import { parseDismissed, serializeDismissed, type DismissedEntry } from "@/lib/recurring-detect";

export async function getAppSetting(key: string): Promise<string | null> {
  const row = await db.appSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  await db.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

export async function getLogoMeta(): Promise<{ key: string; mime: string } | null> {
  const [key, mime] = await Promise.all([
    getAppSetting("logo_key"),
    getAppSetting("logo_mime"),
  ]);
  if (!key || !mime) return null;
  return { key, mime };
}

export async function setLogoMeta(key: string, mime: string): Promise<void> {
  await Promise.all([
    setAppSetting("logo_key", key),
    setAppSetting("logo_mime", mime),
  ]);
}

export async function getFaviconMeta(): Promise<{ key: string; mime: string } | null> {
  const [key, mime] = await Promise.all([
    getAppSetting("favicon_key"),
    getAppSetting("favicon_mime"),
  ]);
  if (!key || !mime) return null;
  return { key, mime };
}

export async function setFaviconMeta(key: string, mime: string): Promise<void> {
  await Promise.all([
    setAppSetting("favicon_key", key),
    setAppSetting("favicon_mime", mime),
  ]);
}

// ── Per-entity quarterly tax-reserve percentage ────────────────────────────────
// See lib/business-quarter-forecast.ts — flat cash-reserve heuristic, not a
// computed tax liability. Per-entity (not household-wide) because EK
// Consulting (Schedule C, subject to self-employment tax) and Sudden Valley
// (Schedule E rental, not subject to SE tax) have structurally different
// effective tax pictures.

function taxReservePctKey(entityId: string): string {
  return `business_tax_reserve_pct:${entityId}`;
}

export async function getEntityTaxReservePct(
  entityId: string
): Promise<{ pct: number; isDefault: boolean }> {
  const raw = await getAppSetting(taxReservePctKey(entityId));
  if (raw === null) return { pct: DEFAULT_TAX_RESERVE_PCT, isDefault: true };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { pct: DEFAULT_TAX_RESERVE_PCT, isDefault: true };
  return { pct: parsed, isDefault: false };
}

export async function setEntityTaxReservePct(entityId: string, pct: number): Promise<void> {
  await setAppSetting(taxReservePctKey(entityId), String(pct));
}

// ── Dismissed "looks recurring" suggestions ("Not a bill") ────────────────────
// See lib/recurring-detect.ts. One AppSetting row per entity holding JSON `{ v: 1, keys: [{ k, at }] }`
// (capped at 200, household-wide). No table and no migration. A value that cannot be parsed reads as an empty
// list, so a corrupt setting never breaks a page. Two people dismissing in the same instant can lose one
// entry (harmless: that suggestion simply shows again).

const DISMISSED_PREFIX = "recurring_dismissed:";

function dismissedKey(entityId: string): string {
  return `${DISMISSED_PREFIX}${entityId}`;
}

export async function getDismissedSuggestions(entityId: string): Promise<DismissedEntry[]> {
  return parseDismissed(await getAppSetting(dismissedKey(entityId)));
}

export async function setDismissedSuggestions(entityId: string, entries: DismissedEntry[]): Promise<void> {
  await setAppSetting(dismissedKey(entityId), serializeDismissed(entries));
}

/** Every entity's dismissals (for the all-entities views). Series keys start with their own entity id. */
export async function getAllDismissedSuggestions(): Promise<DismissedEntry[]> {
  const rows = await db.appSetting.findMany({
    where: { key: { startsWith: DISMISSED_PREFIX } },
    select: { value: true },
  });
  return rows.flatMap((r) => parseDismissed(r.value));
}
