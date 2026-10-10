// DB-aware, READ-ONLY loader for the seasonal model (lib/seasonal-energy.ts). No writes of any kind, no auth: the CALLER
// (a page that has already run auth(), a server action after requireAuth(), a cron job) owns access control. Explicit
// selects only (never account numbers: an account is read by nickname); at most one Transaction query, one Budget read
// through the shared loader, and one AppSetting read per run.
//
// What it reads, and why it is wider than "Primary Checking": the history of these three bills is spread over several
// accounts (Eversource moved to the envelope accounts after Feb 2026) and, for the Personal house's oil, over two
// entities (some McCarthy payments were charged to the EK Consulting card by mistake). So transactions are selected by
// tag OR by payee across accounts, and attributed to a site (entity) by lib/seasonal-energy.ts `selectSitePayments`,
// the only place that decides which entity's rows count for which house.
//
// FAIL-SOFT for display callers: `loadSeasonalEnergySafe` / `loadSeasonalPlansSafe` never reject (logging err.name only)
// and report `failed: true`, in which case every consumer keeps the flat figures it used before this feature. A failed
// read of the seasonal-lines setting counts as failed (it is NOT replaced by the default set).

import { db } from "@/lib/db";
import { Decimal } from "@prisma/client/runtime/library";
import { cache } from "react";
import { loadEffectiveBudgetRows, loadVariableLines } from "@/lib/budget-carry-forward-build";
import { descriptorOf, parseMarks, type OilMark } from "@/lib/seasonal-energy-marks";
import {
  billMatchesLine,
  buildSiteEnergy,
  dayKey,
  lineKindOfTag,
  periodOfDate,
  type BillSeasonalPlan,
  type DrawFact,
  type EnergyEntityRef,
  type EnergyKind,
  type RawEnergyTx,
  type SeasonalLineRef,
  type SiteEnergy,
} from "@/lib/seasonal-energy";
import {
  oilExcludedKey,
  oilPriceKey,
  parseOilPrices,
  parseReplaceDraws,
  REPLACE_DRAWS_KEY,
  type OilPriceEntry,
} from "@/lib/seasonal-energy-prices";

/** Hard ceiling on transactions read; reaching it counts as a failed (incomplete) read rather than a silent partial one. */
const MAX_TX = 4000;
const HISTORY_MONTHS = 37;
const PAYEE_TERMS = ["eversource", "mccarthy", "firewood"] as const;

export interface LoadedSeasonalEnergy {
  sites: SiteEnergy[];
  plans: BillSeasonalPlan[];
  /** Entity ids whose stored price list exists but could not be read (the list shown is empty; nothing was overwritten). */
  pricesCorrupt: string[];
  replaceDraws: boolean;
  failed: boolean;
}

const EMPTY: LoadedSeasonalEnergy = { sites: [], plans: [], pricesCorrupt: [], replaceDraws: false, failed: true };

export async function loadSeasonalEnergy(opts: { now: Date }): Promise<LoadedSeasonalEnergy> {
  const now = opts.now;
  const variable = await loadVariableLines();
  const lines: SeasonalLineRef[] = variable.flatMap((v) => {
    const kind = lineKindOfTag(v.tagName);
    return kind === null ? [] : [{ entityId: v.entityId, tagId: v.tagId, tagName: v.tagName, kind }];
  });
  if (lines.length === 0) {
    return { sites: [], plans: [], pricesCorrupt: [], replaceDraws: false, failed: false };
  }

  const entityRows = await db.entity.findMany({ where: { archivedAt: null }, select: { id: true, name: true, slug: true } });
  const entities: EnergyEntityRef[] = entityRows.map((e) => ({ id: e.id, name: e.name, slug: e.slug }));
  const siteEntityIds = [...new Set(lines.map((l) => l.entityId))];
  const oilEntityIds = [...new Set(lines.filter((l) => l.kind === "oil").map((l) => l.entityId))];

  const settingKeys = [REPLACE_DRAWS_KEY, ...oilEntityIds.flatMap((id) => [oilPriceKey(id), oilExcludedKey(id)])];
  const settingRows = await db.appSetting.findMany({ where: { key: { in: settingKeys } }, select: { key: true, value: true } });
  const settingByKey = new Map(settingRows.map((r) => [r.key, r.value]));
  const replaceDraws = parseReplaceDraws(settingByKey.get(REPLACE_DRAWS_KEY));
  const pricesCorrupt: string[] = [];
  const pricesByEntity = new Map<string, OilPriceEntry[]>();
  const marksByEntity = new Map<string, OilMark[]>();
  for (const id of oilEntityIds) {
    const parsed = parseOilPrices(settingByKey.get(oilPriceKey(id)));
    if (parsed.corrupt) pricesCorrupt.push(id);
    pricesByEntity.set(id, parsed.entries);
    // Transaction ids the owner marked "not heating oil" (a corrupt list reads as empty; the action refuses to overwrite it).
    marksByEntity.set(id, parseMarks(settingByKey.get(oilExcludedKey(id))).marks);
  }

  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const since = new Date(Date.UTC(Math.floor((nowIdx - HISTORY_MONTHS) / 12), (nowIdx - HISTORY_MONTHS) % 12, 1));
  const textMatches = PAYEE_TERMS.flatMap((term) => [
    { payeeNormalized: { contains: term, mode: "insensitive" as const } },
    { payeeRaw: { contains: term, mode: "insensitive" as const } },
    { description: { contains: term, mode: "insensitive" as const } },
  ]);
  const txRows = await db.transaction.findMany({
    where: {
      archivedAt: null,
      transferPairId: null,
      postedAt: { gte: since },
      OR: [{ tags: { some: { tagId: { in: [...new Set(lines.map((l) => l.tagId))] } } } }, ...textMatches],
    },
    orderBy: { postedAt: "asc" },
    take: MAX_TX,
    select: {
      id: true,
      postedAt: true,
      amount: true,
      pending: true,
      accountId: true,
      entityId: true,
      payeeNormalized: true,
      payeeRaw: true,
      description: true,
      account: { select: { nickname: true } },
      tags: { select: { tag: { select: { name: true } } } },
    },
  });
  if (txRows.length >= MAX_TX) throw new Error("SeasonalHistoryTooLarge");
  const txs: RawEnergyTx[] = txRows.map((t) => ({
    id: t.id,
    date: t.postedAt,
    amount: new Decimal(t.amount.toString()),
    entityId: t.entityId,
    accountId: t.accountId,
    pending: t.pending,
    // The joined text is for supplier-kind detection only; a mark compares the ONE descriptor (descriptorOf).
    payee: [t.payeeNormalized, t.payeeRaw, t.description].filter((s): s is string => typeof s === "string" && s !== "").join(" "),
    descriptor: descriptorOf(t),
    account: t.account.nickname,
    tagPaths: t.tags.map((x) => x.tag.name),
  }));

  // The flat monthly figure of each line (the Budget row, carried forward), only to compare against in the basis text.
  const flatByLine = new Map<string, Decimal>();
  try {
    const budgetRows = await loadEffectiveBudgetRows({ periods: [periodOfDate(now)] });
    for (const r of budgetRows) if (r.budgeted !== null) flatByLine.set(`${r.entityId}|${r.tagId}`, new Decimal(r.budgeted.toString()));
  } catch (err) {
    console.error("Seasonal flat budget figures unavailable", err instanceof Error ? err.name : "UnknownError");
  }

  // Hand-entered accrual draws of the accrued bills that belong to these lines (display next to the estimate).
  const billRows = await db.scheduledBill.findMany({
    where: { active: true, amountType: "accrued", entityId: { in: siteEntityIds } },
    select: {
      entityId: true,
      payee: true,
      budgetTagId: true,
      budgetEntityId: true,
      accrualEnvelope: { select: { draws: { select: { estimatedDate: true, estimatedAmount: true } } } },
    },
  });

  const sites: SiteEnergy[] = [];
  for (const entity of entities) {
    if (!siteEntityIds.includes(entity.id)) continue;
    const own = lines.filter((l) => l.entityId === entity.id);
    const flatMonthly: Partial<Record<EnergyKind, Decimal | null>> = {};
    const draws: Partial<Record<EnergyKind, DrawFact[]>> = {};
    for (const l of own) {
      flatMonthly[l.kind] = flatByLine.get(`${l.entityId}|${l.tagId}`) ?? null;
      const mine = billRows.filter((b) => billMatchesLine(b, l));
      draws[l.kind] = mine
        .flatMap((b) => b.accrualEnvelope?.draws ?? [])
        .map((d) => ({ date: dayKey(d.estimatedDate), amount: new Decimal(d.estimatedAmount.toString()) }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
    sites.push(
      buildSiteEnergy({
        entity,
        lines: own,
        txs,
        entities,
        priceEntries: pricesByEntity.get(entity.id) ?? [],
        flatMonthly,
        replaceDraws,
        draws,
        oilMarks: marksByEntity.get(entity.id),
        now,
      })
    );
  }
  sites.sort((a, b) => (a.slug === "personal" ? -1 : b.slug === "personal" ? 1 : a.entityName.localeCompare(b.entityName)));
  return { sites, plans: sites.flatMap((s) => s.plans), pricesCorrupt, replaceDraws, failed: false };
}

async function loadSafe(now: Date): Promise<LoadedSeasonalEnergy> {
  try {
    return await loadSeasonalEnergy({ now });
  } catch (err) {
    console.error("Seasonal estimates unavailable", err instanceof Error ? err.name : "UnknownError");
    return EMPTY;
  }
}

// ONE load per server request: the Forecast page, the Seasonal card, the Upcoming ledger and the assistant each ask for
// the same data in the same render, and the read is a 37-month scan. React's `cache` memoises per request (keyed by the
// calendar day, which is all the model looks at); outside a render scope (an action, a cron job, a test) it does not
// memoise, so every such caller still gets a fresh read. The read-only and fail-soft semantics are unchanged.
const loadOncePerRequest = cache((dayIso: string): Promise<LoadedSeasonalEnergy> => loadSafe(new Date(`${dayIso}T00:00:00.000Z`)));

/** Never rejects. On any error: no sites, no plans, `failed: true` (every consumer then uses its flat figures). */
export async function loadSeasonalEnergySafe(opts: { now: Date }): Promise<LoadedSeasonalEnergy> {
  return loadOncePerRequest(opts.now.toISOString().slice(0, 10));
}

/** Just the plans, for the consumers that apply them (forecast, ledger, assistant). Never rejects. */
export async function loadSeasonalPlansSafe(opts: { now: Date }): Promise<{ plans: BillSeasonalPlan[]; failed: boolean }> {
  const loaded = await loadSeasonalEnergySafe(opts);
  return { plans: loaded.plans, failed: loaded.failed };
}
