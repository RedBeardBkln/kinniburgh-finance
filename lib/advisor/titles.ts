// Conversation titles (plan section 6). PURE.

import { LIMITS } from "@/lib/advisor/config";
import { safeField } from "@/lib/advisor/scrub";

export const DEFAULT_TITLE = "New conversation";

/** Auto title from the first user message: first line, whitespace-collapsed, scrubbed, <= 80 characters. */
export function deriveTitle(firstMessage: string): string {
  const firstLine = firstMessage.split("\n").find((l) => l.trim() !== "") ?? "";
  const title = safeField(firstLine, LIMITS.titleChars);
  return title === "" ? DEFAULT_TITLE : title;
}

/** A title the user typed: scrubbed and clipped; an empty result is rejected. */
export function cleanUserTitle(raw: string): string | null {
  const title = safeField(raw, LIMITS.titleChars);
  return title === "" ? null : title;
}
