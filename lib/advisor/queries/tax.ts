// Per-turn memoized loaders for the heavy TY2025 reads (plan section 5.4). READ-ONLY: they call the same loaders the Tax Forms pages call
// (`loadSheet`, `loadReviewState`, `loadTaxFacts`), hold no locks, never start a review run, an AI step, a PDF build or a store write, and
// are cached only for the current turn (ctx.memo), so a stale answer can never outlive the request.
//
// No Prisma delegate is touched here directly. The loaders have no auth of their own: the chat route authenticates first and passes the
// signed-in user's id in the tool context.

import { buildTy2025ReturnWithOverrides } from "@/lib/tax2025-overrides-build";
import { loadSheet, type LoadedSheet } from "@/lib/tax2025-sheet-load";
import { loadReviewState } from "@/lib/tax-review-server";
import { loadTaxFacts, type TaxFactsLoad } from "@/lib/tax-facts-store";
import { memoize, type ToolContext } from "@/lib/advisor/tools/types";

type ReviewLoad = Awaited<ReturnType<typeof loadReviewState>>;

/** The TY2025 review sheet model (effective view, overrides marked). One build per turn, shared by parallel tool calls. */
export function loadTaxSheetOnce(ctx: ToolContext): Promise<LoadedSheet> {
  return memoize(ctx, "taxSheet", () => loadSheet(2025, { build: buildTy2025ReturnWithOverrides }));
}

/** The Final review state for the signed-in user (gate, findings, approval). One build per turn. */
export function loadTaxReviewOnce(ctx: ToolContext): Promise<ReviewLoad> {
  return memoize(ctx, "taxReview", () => loadReviewState(2025, ctx.userId));
}

/** Every stored version of every tax fact (read through the store; resolved by lib/tax-facts/carry-forward in the tool). One read per turn. */
export function loadTaxFactsOnce(ctx: ToolContext): Promise<TaxFactsLoad> {
  return memoize(ctx, "taxFacts", () => loadTaxFacts());
}
