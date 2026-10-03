// DB-aware loader for TY2025 overrides (plan section 7.4). Thin and deliberately
// untested (the pure logic lives in overrides.ts); the actions mock this module.
//
// WIRING POINT (owned by T9 `ty2025-pdf-integration`): the 1a base-return loader
// (`lib/tax2025-build.ts`: facts -> computeTy2025Return) did not exist when this
// was written, so the base computation is an INJECTED function type
// (`ComputeBaseReturn`). `computeBaseReturn` below is the single place to wire it:
//
//     export const computeBaseReturn: ComputeBaseReturn = async (taxYear, decisions) => {
//       const ret = await <1a loader>(taxYear, decisions);   // facts -> computeTy2025Return(facts, decisions)
//       return { ret, engineVersion: RETURN_ENGINE_VERSION }; // engineVersion only if 1a exports one
//     };
//
// Until then it throws BaseReturnNotWiredError, which the actions turn into a
// plain "not connected yet" result (no override can be written against a return
// the server cannot rebuild: the server never trusts client-supplied numbers).

import { db } from "@/lib/db";
import {
  applyOverrides,
  decisionsFromOverrides,
  type EffectiveReturn,
  type OverrideRow,
  type OverrideTargetKind,
} from "@/lib/tax2025/overrides";
import type { Ty2025Decisions, Ty2025Return } from "@/lib/tax2025/types";

export class BaseReturnNotWiredError extends Error {
  constructor() {
    super("The TY2025 return engine is not connected to the overrides loader yet.");
    this.name = "BaseReturnNotWiredError";
  }
}

/** Builds the BASE return (decisions fed in, no line/ack overrides applied). */
export type ComputeBaseReturn = (
  taxYear: number,
  decisions: Ty2025Decisions
) => Promise<{ ret: Ty2025Return; engineVersion?: string }>;

export const computeBaseReturn: ComputeBaseReturn = async () => {
  throw new BaseReturnNotWiredError();
};

/** The household return files under the Personal entity (same convention as TaxQuestionnaire). */
export async function resolvePersonalEntityId(): Promise<string | null> {
  const personal = await db.entity.findFirst({
    where: { type: "personal", archivedAt: null },
    select: { id: true },
  });
  return personal?.id ?? null;
}

/** Active rows only (archivedAt guard). */
export async function loadActiveOverrides(taxYear: number, entityId: string): Promise<OverrideRow[]> {
  return db.taxReturnOverride.findMany({
    where: { taxYear, entityId, archivedAt: null },
    orderBy: [{ targetKind: "asc" }, { targetKey: "asc" }, { version: "desc" }],
  });
}

/** Every version of one target, newest first, including archived rows. */
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

export interface BaseAndActive {
  entityId: string;
  rows: OverrideRow[];
  base: Ty2025Return;
  engineVersion?: string;
}

/** Active rows plus the base return computed with their decisions (what a new override's snapshot is taken from). */
export async function loadBaseAndActive(
  taxYear: number,
  compute: ComputeBaseReturn = computeBaseReturn
): Promise<BaseAndActive | null> {
  const entityId = await resolvePersonalEntityId();
  if (!entityId) return null;
  const rows = await loadActiveOverrides(taxYear, entityId);
  const { ret, engineVersion } = await compute(taxYear, decisionsFromOverrides(rows));
  return engineVersion === undefined ? { entityId, rows, base: ret } : { entityId, rows, base: ret, engineVersion };
}

/**
 * facts -> computeTy2025Return(facts, decisionsFromOverrides(active)) ->
 * applyOverrides. The ONE entry point the sheet, CSV and PDF routes should call,
 * so no surface can show the un-overridden return by accident.
 */
export async function buildTy2025ReturnWithOverrides(
  taxYear: number,
  compute: ComputeBaseReturn = computeBaseReturn
): Promise<EffectiveReturn | null> {
  const loaded = await loadBaseAndActive(taxYear, compute);
  if (!loaded) return null;
  return applyOverrides(
    loaded.base,
    loaded.rows,
    loaded.engineVersion === undefined ? {} : { engineVersion: loaded.engineVersion }
  );
}
