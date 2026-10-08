// Owner-visible wording for the tax year close (tax-carry-screen-and-year-close, Phase B).
//
// "Marked filed" is the owner's own record. Nothing here says the IRS or Connecticut received or accepted a return, that
// anything was checked or certified, or who or what computed anything. Dates are shown in America/New_York. PURE.

import { formatFactDate } from "@/lib/tax-facts/format";
import type { YearState } from "@/lib/tax-year-close/state";

/** "TY2025 filed 2026-10-12" / "TY2025 reopened for revision"; null for an open year (no badge). */
export function yearBadgeText(state: Pick<YearState, "status" | "taxYear" | "filedOn">): string | null {
  if (state.status === "closed") {
    return state.filedOn ? `TY${state.taxYear} filed ${formatFactDate(state.filedOn)}` : `TY${state.taxYear} filed`;
  }
  if (state.status === "reopened") return `TY${state.taxYear} reopened for revision`;
  return null;
}

/** The banner on every page that shows the year; null for an open year. */
export function yearBannerText(state: YearState): string | null {
  if (state.status === "closed") {
    const filed = state.filedOn ? `filed ${formatFactDate(state.filedOn)}` : "filed";
    const by = state.closedByName && state.closedAt ? `; recorded by ${state.closedByName} on ${formatFactDate(state.closedAt)}` : "";
    return `TY${state.taxYear} is marked filed (${filed}${by}). Changes on this page do not alter a return you already filed. Reopen the year on the Tax Forms page to revise it.`;
  }
  if (state.status === "reopened") {
    const on = state.reopenedAt ? ` (${formatFactDate(state.reopenedAt)})` : "";
    return `TY${state.taxYear} is reopened for revision${on}. Mark it filed again when you have filed the revision.`;
  }
  return null;
}

/** Shown in the close dialog and on the card. */
export const CLOSE_HONESTY =
  "Marking a year filed is your own record. The app does not check with the IRS or Connecticut DRS whether a return was received or accepted, and this label changes no computation, form or approval.";

export const CLOSE_PRIVACY_WARNING =
  "Do not enter confirmation numbers, Social Security numbers, account numbers or birth dates in the note.";

export const CLOSE_MIGRATION_MISSING =
  "The tax year close table has not been created yet: the migration has not been applied. Nothing is wrong with your data.";
