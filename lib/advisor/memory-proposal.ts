// The guard for propose_memory_note (advisor-ai-chatbot-phase2 plan, Decision B). PURE: no DB, no clock.
//
// The model never writes memory. It may only SUGGEST a note, and only when the person's CURRENT message (captured once by the loop before any tool
// result is appended) explicitly asks to remember something and the quoted evidence really is in that message. A suggestion is shown to the
// person with a Save button; nothing is stored until they click it (actions/advisor.ts confirmMemorySuggestion, which scrubs again and enforces
// the 50-note cap). A refusal here is a normal tool result, never an event.

import { isMemoryCategory, type MemoryCategory } from "@/lib/advisor/memory-categories";
import { normalizeText, scrubMemoryNote } from "@/lib/advisor/scrub";

export const MAX_PROPOSALS_PER_TURN = 2;
export const MIN_EVIDENCE_CHARS = 8;

/** The person's own words that count as "please remember this". */
export const TRIGGER_RE = /\b(remember|keep in mind|note that|from now on|for future reference|don'?t forget|make a note)\b/i;

/** NFKC, lower-case, invisible and control characters removed, whitespace collapsed: the form both sides of the quote check are compared in. */
export function normalizeForQuote(s: string): string {
  return normalizeText(s).toLowerCase().replace(/\s+/g, " ").trim();
}

export interface ProposalInput {
  text: string;
  category: string;
  evidenceQuote: string;
  /** The human message of THIS turn (never a tool result or a memory note). */
  humanMessage: string;
  /** Proposals already made this turn. */
  proposalsSoFar: number;
}

export type ProposalDecision = { ok: true; note: { text: string; category: MemoryCategory } } | { ok: false; reason: string };

export function evaluateMemoryProposal(input: ProposalInput): ProposalDecision {
  if (!isMemoryCategory(input.category)) return { ok: false, reason: "Unknown category; use preference, household, tax_context or other." };
  if (input.proposalsSoFar >= MAX_PROPOSALS_PER_TURN) return { ok: false, reason: "Only two memory suggestions can be made per answer." };

  const human = normalizeForQuote(input.humanMessage);
  if (human === "" || !TRIGGER_RE.test(human)) return { ok: false, reason: "The person's message did not ask to remember anything, so no suggestion was made." };

  const quote = normalizeForQuote(input.evidenceQuote);
  if (quote.length < MIN_EVIDENCE_CHARS || !human.includes(quote)) {
    return { ok: false, reason: "The evidence quote must be an exact phrase from the person's current message." };
  }

  const note = scrubMemoryNote(input.text);
  if (!note.ok) return { ok: false, reason: note.error };
  return { ok: true, note: { text: note.value, category: input.category } };
}

/** The human message of the turn: the LAST user message whose content is plain text (tool results are arrays and never qualify). */
export function lastHumanMessage(messages: readonly { role: string; content: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}
