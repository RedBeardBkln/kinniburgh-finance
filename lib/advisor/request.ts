// Request-side guards for POST /api/advisor/chat (plan sections 8 and 12). PURE.

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";

export const chatBodySchema = z
  .object({
    conversationId: z.string().uuid().nullable(),
    message: z.string().min(1).max(LIMITS.maxMessageChars),
  })
  .strict();

export type ChatBody = z.infer<typeof chatBodySchema>;

export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Same-origin check for a state-changing request: the Origin header must be present and its host must equal the request host
 * (x-forwarded-host first, as behind Vercel). A missing Origin on a POST is refused (a browser always sends it on a cross-site or
 * fetch POST; a non-browser client has no business here).
 */
export function isSameOrigin(headers: HeaderReader): boolean {
  const origin = headers.get("origin");
  if (origin === null || origin === "") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const forwarded = headers.get("x-forwarded-host");
  const host = (forwarded !== null && forwarded !== "" ? forwarded.split(",")[0]!.trim() : headers.get("host") ?? "").toLowerCase();
  return host !== "" && host === originHost;
}

export type BodyCheck = { ok: true; body: ChatBody } | { ok: false; status: 400 | 413 | 415; code: "invalid"; message: string };

/** Content-type, size and shape of the JSON body. `rawText` is the already-read request text. */
export function checkChatRequest(contentType: string | null, rawText: string): BodyCheck {
  if (contentType === null || !/^application\/json\b/i.test(contentType)) {
    return { ok: false, status: 415, code: "invalid", message: "Send the request as JSON." };
  }
  if (new TextEncoder().encode(rawText).length > LIMITS.maxBodyBytes) {
    return { ok: false, status: 413, code: "invalid", message: "That request is too large." };
  }
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return { ok: false, status: 400, code: "invalid", message: "That request could not be read." };
  }
  const parsed = chatBodySchema.safeParse(json);
  if (!parsed.success) return { ok: false, status: 400, code: "invalid", message: "Type a message of 1 to 4000 characters." };
  return { ok: true, body: parsed.data };
}
