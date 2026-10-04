// Glue between the engine loader and the sheet view model (Phase 1c).
//
// The builder is INJECTED (`deps.build`): production passes buildTy2025Return from
// lib/tax2025-build.ts, tests pass a fake that returns a precomputed Ty2025Return, so no
// test ever reaches the DB or the network. This module imports nothing DB-aware.
//
// SECURITY: it never receives or returns the engine's `resolved` / `facts` / raw
// extraction data. Callers (the /return page, the CSV action, the Forms page) must have
// authenticated BEFORE calling it; the only things it hands back are the plain-JSON
// SheetModel and the card conclusions (strings).

import { buildCardConclusions, type CardConclusion } from "@/lib/tax2025-sheet-conclusions";
import {
  SHEET_SUPPORTED_YEAR,
  buildSheetModel,
  type SheetLineOverride,
  type SheetModel,
  type SheetRawDocument,
} from "@/lib/tax2025-sheet";
import type { Ty2025Return } from "@/lib/tax2025/types";

export interface SheetBuildOk {
  ret: Ty2025Return;
  raw: { documents: readonly SheetRawDocument[] };
}

export type SheetBuilder = (taxYear: 2025) => Promise<SheetBuildOk | { error: string }>;

export interface SheetLoadDeps {
  build: SheetBuilder;
  now?: () => Date;
  /** Optional per-line overrides (the overrides module arrives from another branch). */
  overrides?: () => Promise<Readonly<Record<string, SheetLineOverride>>>;
}

export type LoadedSheet =
  | { kind: "ok"; model: SheetModel; conclusions: Record<string, CardConclusion> }
  | { kind: "unsupported_year"; year: number }
  | { kind: "error"; message: string };

export async function loadSheet(year: number, deps: SheetLoadDeps): Promise<LoadedSheet> {
  if (year !== SHEET_SUPPORTED_YEAR) return { kind: "unsupported_year", year };
  try {
    const built = await deps.build(SHEET_SUPPORTED_YEAR);
    if ("error" in built) return { kind: "error", message: built.error };
    const overrides = deps.overrides ? await deps.overrides() : undefined;
    const model = buildSheetModel({
      ret: built.ret,
      documents: built.raw.documents,
      now: (deps.now ?? (() => new Date()))(),
      ...(overrides ? { overrides } : {}),
    });
    return { kind: "ok", model, conclusions: buildCardConclusions(built.ret) };
  } catch (err) {
    // Never echo the error text: it may carry row data. The name is enough to find it in the logs.
    console.error("tax2025 review sheet build failed:", err instanceof Error ? err.name : "unknown error");
    return { kind: "error", message: "The return could not be computed right now. Try again; nothing was changed." };
  }
}
