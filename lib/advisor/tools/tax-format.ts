// Engine identifier clean-up for the TY2025 tax tools. PURE.

// ── engine identifiers in prose ──────────────────────────────────────────────

/** The engine's status ids carry an internal identifier (`needs_cpa_*`) that must not reach the model: same mapping the reviewer payload uses. */
export function plainStatusId(status: string): string {
  switch (status) {
    case "needs_cpa_judgment":
      return "needs_owner_decision";
    case "needs_cpa_rule_unverified":
      return "rule_unverified";
    default:
      return status;
  }
}

/** Engine status identifiers inside prose (reasons, notes) read as plain words too. */
export function plainIds(text: string): string {
  return text.replace(/needs_cpa_rule_unverified/g, "rule_unverified").replace(/needs_cpa_judgment/g, "needs_owner_decision").replace(/needs_cpa_/g, "needs_owner_");
}
