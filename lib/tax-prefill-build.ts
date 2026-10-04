import { loadTy2025RawInputs } from "@/lib/tax2025-build";
import { resolveFacts } from "@/lib/tax2025/resolve-facts";
import { computePrefillSuggestions, type PrefillSuggestion } from "@/lib/tax-prefill";

// ── Read-only loader for the questionnaire "answer from your documents" suggestions ──
// STRICTLY READ-ONLY and NO auth of its own: the questionnaire page (authenticated) and the
// accept action (requireAuth() first) call it. It reuses the TY2025 engine's own loader and
// resolver (loadTy2025RawInputs -> resolveFacts, which maps every document through
// resolveTaxDocForCompute), so the suggestions and the computed return can never disagree
// about which documents count, which are duplicates or what "verified" means.
//
// It returns ONLY the plain, client-safe PrefillSuggestion objects (ids, option ids, cents,
// stable field codes, employer / document display names, verified flags). `raw` and `resolved`
// (the full effective extraction of every document: EINs, addresses, loan last-4) never leave
// this function - see the SECURITY note at the top of lib/tax2025-build.ts.
//
// A failure (no Personal entity, a database hiccup, a malformed document) yields NO
// suggestions, never an error: the questionnaire must keep working exactly as before.
// It never writes and never opens a Planning workspace.

export async function loadPrefillSuggestions(year: number): Promise<PrefillSuggestion[]> {
  if (year !== 2025) return [];
  try {
    const raw = await loadTy2025RawInputs(2025);
    if ("error" in raw) return [];
    const { facts } = resolveFacts(raw);
    return computePrefillSuggestions({
      year: 2025,
      people: raw.people,
      w2s: facts.income.w2s,
      w2Unusable: facts.income.w2Unusable,
      documents: raw.documents,
      solarCredit: raw.planning.solarCredit,
    });
  } catch {
    return [];
  }
}
