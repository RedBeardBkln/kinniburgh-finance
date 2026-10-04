import { db } from "@/lib/db";
import { getEntityBySlug } from "@/lib/entity";
import { buildTy2025Return, type Ty2025Build } from "@/lib/tax2025-build";
import {
  applyOverrides,
  decisionsFromOverrides,
  type EffectiveReturn,
  type OverrideRow,
  type OverrideTargetKind,
} from "@/lib/tax2025/overrides";
import type { Ty2025Return } from "@/lib/tax2025/types";

// ── DB-aware loader for the TY2025 CPA overrides ─────────────────────────────
// Lives OUTSIDE lib/tax2025/ on purpose (that tree is pure: no DB, no clock). It is
// the ONE entry point the review sheet, the CSV and the PDF packet call, so no
// surface can show the un-overridden return by accident.
//
// STRICTLY READ-ONLY: only findMany reads (overrides) plus the existing read-only
// engine loader. No create / update / delete / upsert / $transaction here (the actions
// own every write). No "use server": nothing in this file is callable from a client.
//
// SECURITY: no auth here. Callers must authenticate first (requireAuth() / auth()) and
// pass only plain-JSON pieces (`ret`, `effective`, sheet / PDF models) to clients, never
// `resolved` / `facts` / `raw` (see lib/tax2025-build.ts).
//
// FAIL-CLOSED (plan D7): if the override rows cannot be read the loader returns an
// error. It NEVER falls back to the un-overridden return, which would silently drop a
// CPA instruction.

/** The household return files under the Personal entity (same lookup as every other tax page and the engine loader). */
export async function resolvePersonalEntityId(): Promise<string | null> {
  const personal = await getEntityBySlug("personal");
  return personal?.id ?? null;
}

/** Active rows only (archivedAt guard). */
export async function loadActiveOverrides(taxYear: number, entityId: string): Promise<OverrideRow[]> {
  return db.taxReturnOverride.findMany({
    where: { taxYear, entityId, archivedAt: null },
    orderBy: [{ targetKind: "asc" }, { targetKey: "asc" }, { version: "desc" }],
  });
}

/** Every version of one target, newest first, including archived rows (history is never hidden). */
export async function loadOverrideHistory(
  taxYear: number,
  entityId: string,
  targetKind: OverrideTargetKind,
  targetKey: string
) {
  return db.taxReturnOverride.findMany({
    where: { taxYear, entityId, targetKind, targetKey },
    orderBy: { version: "desc" },
  });
}

/** Injectable pieces, for tests only (production passes none). */
export interface OverridesBuildDeps {
  build?: (taxYear: 2025, decisions: ReturnType<typeof decisionsFromOverrides>) => Promise<Ty2025Build | { error: string }>;
  resolveEntityId?: () => Promise<string | null>;
  loadRows?: (taxYear: number, entityId: string) => Promise<OverrideRow[]>;
}

export interface BaseAndActive {
  entityId: string;
  rows: OverrideRow[];
  /** The base return computed WITH the recorded decisions: exactly what the sheet shows before line overrides. */
  base: Ty2025Return;
  engineVersion: string;
  build: Ty2025Build;
}

export type BaseAndActiveResult = BaseAndActive | { error: string };

const ROWS_UNREADABLE =
  "The recorded CPA overrides could not be read, so the return is not shown (it would silently leave them out). Try again; nothing was changed.";

/** Active rows plus the base return computed with their decisions. The set action snapshots lines from `base`. */
export async function loadBaseAndActive(taxYear: 2025, deps: OverridesBuildDeps = {}): Promise<BaseAndActiveResult> {
  const resolveEntity = deps.resolveEntityId ?? resolvePersonalEntityId;
  const loadRows = deps.loadRows ?? loadActiveOverrides;
  const build = deps.build ?? buildTy2025Return;

  let entityId: string | null;
  let rows: OverrideRow[];
  try {
    entityId = await resolveEntity();
    if (!entityId) return { error: "The Personal entity was not found." };
    rows = await loadRows(taxYear, entityId);
  } catch (err) {
    // Never echo the error text (it may carry row data); the name is enough to find it in the logs.
    console.error("tax2025 overrides could not be loaded:", err instanceof Error ? err.name : "unknown error");
    return { error: ROWS_UNREADABLE };
  }

  const built = await build(taxYear, decisionsFromOverrides(rows));
  if ("error" in built) return { error: built.error };
  return { entityId, rows, base: built.ret, engineVersion: built.ret.engineVersion, build: built };
}

export type Ty2025OverriddenBuild = Ty2025Build & {
  effective: EffectiveReturn;
  /** The active override rows that were applied (plain data; reasons are tax records). */
  overrideRows: OverrideRow[];
};

/**
 * facts -> computeTy2025Return(facts, decisionsFromOverrides(active)) -> applyOverrides.
 * The ONE entry point the sheet page, the CSV action, the Forms page and the PDF routes call.
 */
export async function buildTy2025ReturnWithOverrides(
  taxYear: 2025,
  deps: OverridesBuildDeps = {}
): Promise<Ty2025OverriddenBuild | { error: string }> {
  const loaded = await loadBaseAndActive(taxYear, deps);
  if ("error" in loaded) return loaded;
  return {
    ...loaded.build,
    effective: applyOverrides(loaded.base, loaded.rows),
    overrideRows: loaded.rows,
  };
}
