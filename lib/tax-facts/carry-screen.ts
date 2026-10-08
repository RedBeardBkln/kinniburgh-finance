// View model for the carry screen /tax/facts/carry/[year] (tax-carry-screen-and-year-close, Phase A).
//
// Buckets are EXACTLY what `resolveCarryForward` returns; nothing is re-derived here. This file only decides which
// per-fact buttons each row may show and gathers the counters. Every row keeps the year and version it came from.
// Nothing is synthesised: an unanswered key is absent, and no row ever gets a zero or default value.
// There is deliberately no "confirm all" / "confirm selected" notion anywhere: each action is one fact.
//
// PURE: no DB, no network, no clock.

import { resolveCarryForward, type CarryItem, type CarryRow } from "@/lib/tax-facts/carry-forward";

export type CarrySectionId = "needs_reconfirmation" | "ask_fresh" | "open_items" | "carried" | "already_confirmed";

export interface CarryScreenItem extends CarryItem {
  /** A decision fact (X1/X5/X6/X7/X8): a recorded copy for recall; the return uses the decision recorded on the Tax Forms page. */
  isDecision: boolean;
  /** "Still true for TY<year>": one explicit reconfirm of this fact. */
  canStillTrue: boolean;
  /** "It changed": a new version for the target year. */
  canChange: boolean;
  /** Year-specific facts are asked fresh: an empty answer box, plus an explicit "same answer" per fact. */
  canAnswer: boolean;
  canSameAnswer: boolean;
  /** Open items are questions, never facts: resolved on the facts page, never confirmed here. */
  resolveHref: string | null;
}

export interface CarryScreenSection {
  id: CarrySectionId;
  items: CarryScreenItem[];
}

export interface CarryScreen {
  targetYear: number;
  needsReconfirmation: CarryScreenSection;
  askFresh: CarryScreenSection;
  openItems: CarryScreenSection;
  carried: CarryScreenSection;
  alreadyConfirmed: CarryScreenSection;
  /** Needs-confirmation count (policy reconfirm or derived). */
  needsConfirmationCount: number;
  askFreshCount: number;
  openItemCount: number;
  /** Facts that need the owner to do something for this year: needs-confirmation plus ask-fresh. */
  stillNeedYouCount: number;
  totalCount: number;
}

const FACTS_PAGE = "/tax/facts";

function flags(item: CarryItem, section: CarrySectionId): CarryScreenItem {
  const isDecision = item.category === "decision";
  const base = { ...item, isDecision, canStillTrue: false, canChange: false, canAnswer: false, canSameAnswer: false, resolveHref: null as string | null };
  switch (section) {
    case "needs_reconfirmation":
      return { ...base, canStillTrue: true, canChange: true };
    case "ask_fresh":
      return { ...base, canAnswer: true, canSameAnswer: true };
    case "open_items":
      return { ...base, resolveHref: FACTS_PAGE };
    case "carried":
    case "already_confirmed":
      return { ...base, canChange: true };
  }
}

function section(id: CarrySectionId, items: readonly CarryItem[]): CarryScreenSection {
  return { id, items: items.map((i) => flags(i, id)) };
}

export function buildCarryScreen(rows: readonly CarryRow[], targetYear: number): CarryScreen {
  const r = resolveCarryForward(rows, targetYear);
  const needs = section("needs_reconfirmation", r.needsReconfirmation);
  const fresh = section("ask_fresh", r.askFresh);
  const open = section("open_items", r.openItems);
  const carried = section("carried", r.carried);
  const already = section("already_confirmed", r.alreadyConfirmedForYear);
  return {
    targetYear,
    needsReconfirmation: needs,
    askFresh: fresh,
    openItems: open,
    carried,
    alreadyConfirmed: already,
    needsConfirmationCount: needs.items.length,
    askFreshCount: fresh.items.length,
    openItemCount: open.items.length,
    stillNeedYouCount: needs.items.length + fresh.items.length,
    totalCount: needs.items.length + fresh.items.length + open.items.length + carried.items.length + already.items.length,
  };
}
