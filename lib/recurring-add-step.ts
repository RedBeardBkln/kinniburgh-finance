// Pure helpers behind the inline "Add as recurring expense" step (components/upcoming/suggestion-actions.tsx).
// Kept out of the component so the exact request that leaves the browser can be unit-tested: it carries ONLY
// { entityId, seriesKey, tagId, name? }. The server re-derives amount, frequency, day and cadence from the series.
// Import-free: safe for the client bundle.

export const ADD_NAME_MAX = 80;

/** A budget tag is pre-selected / linked for a pattern only when at least this share of its rows carries it. */
export const TAG_LINK_MIN_SHARE = 0.6;

/** The tag the Add step pre-selects: the series' dominant tag when it covers at least 60% of the rows, else null. */
export function suggestedTagId(s: { dominantTagId: string | null; tagShare: number }): string | null {
  return s.dominantTagId !== null && s.tagShare >= TAG_LINK_MIN_SHARE ? s.dominantTagId : null;
}

export interface AddTagOption {
  id: string;
  /** Full hierarchy path, the same label the Forecast and Budgets pages show ("Food & Drink / Groceries"). */
  label: string;
}

export interface AddStepState {
  /** "" = No tag. */
  tagId: string;
  name: string;
}

/** Pre-selects the suggested tag only if it is still in the list; otherwise "No tag". */
export function initialAddState(defaultName: string, suggestedTagId: string | null | undefined, tags: readonly AddTagOption[]): AddStepState {
  const known = suggestedTagId ? tags.some((t) => t.id === suggestedTagId) : false;
  return { tagId: known ? (suggestedTagId as string) : "", name: defaultName };
}

/** A quick check before calling the server (the server validates again): null = fine. */
export function clientNameProblem(name: string): string | null {
  const t = name.trim();
  if (t.length < 1 || t.length > ADD_NAME_MAX) return `Give it a name (1 to ${ADD_NAME_MAX} characters).`;
  return null;
}

export interface AddRequest {
  entityId: string;
  seriesKey: string;
  /** null = the owner chose "No tag". */
  tagId: string | null;
  /** Present only when the owner changed the suggested name. */
  name?: string;
}

/** The only object ever sent to addSuggestedRecurringExpense. No amount, frequency, day or date. */
export function buildAddRequest(
  base: { entityId: string; seriesKey: string },
  state: AddStepState,
  defaultName: string
): AddRequest {
  const name = state.name.trim();
  const req: AddRequest = {
    entityId: base.entityId,
    seriesKey: base.seriesKey,
    tagId: state.tagId === "" ? null : state.tagId,
  };
  if (name !== defaultName.trim()) req.name = name;
  return req;
}
