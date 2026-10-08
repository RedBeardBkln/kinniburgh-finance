import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { LIMITS } from "@/lib/advisor/config";
import { productionDeps } from "@/lib/advisor/deps";
import { checkChatRequest, isSameOrigin } from "@/lib/advisor/request";
import { prepareTurn, streamTurn } from "@/lib/advisor/run-turn";
import { encodeEvent, type ErrorCode } from "@/lib/advisor/stream-protocol";

// POST /api/advisor/chat: the tool-using assistant. The request carries only the new message and the conversation id; the server loads the
// history by id (ownership checked) and streams NDJSON events back (lib/advisor/stream-protocol.ts). Auth is the first statement.
// 60 s is the value already proven on this project's long routes; the loop keeps its own 50 s wall-clock budget inside it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function jsonError(status: number, code: ErrorCode, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return jsonError(401, "unauthorized", "Please sign in.");
  const userId = session.user.id;

  // Same-origin POST only (a missing Origin header is refused).
  if (!isSameOrigin(req.headers)) return jsonError(403, "invalid", "That request was not accepted.");

  // Cheap size check before the body is read, then the exact check on the text.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > LIMITS.maxBodyBytes) return jsonError(413, "invalid", "That request is too large.");
  const checked = checkChatRequest(req.headers.get("content-type"), await req.text());
  if (!checked.ok) return jsonError(checked.status, checked.code, checked.message);

  const deps = productionDeps();
  const prepared = await prepareTurn(deps, { userId, conversationId: checked.body.conversationId, message: checked.body.message });
  if (!prepared.ok) return jsonError(prepared.status, prepared.code, prepared.message);

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await streamTurn(deps, prepared.turn, (event) => controller.enqueue(encoder.encode(encodeEvent(event))), abort.signal);
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed by a cancel */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
