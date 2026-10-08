"use client";

import { useRef, useState } from "react";
import { applyEvent, emptyTurn, liveMessage, type TurnView, type UiMessage } from "@/lib/advisor/chat-state";
import { createByteDecoder } from "@/lib/advisor/stream-protocol";

// The send / stream / stop logic of the assistant, shared by the /advisor workspace and the global slide-over (advisor-ai-chatbot-phase2 plan,
// section 6). This is the code that used to live inside AdvisorWorkspace, moved as is: the same fetch to POST /api/advisor/chat, the same NDJSON
// reading through the pure reducer in lib/advisor/chat-state.ts, the same Stop (abort) and error messages. What is new: an optional page context
// (the pathname only; the server re-parses it) and the last-24-hours token count.

const GENERIC_ERROR = "Something went wrong. Please try again.";

async function errorMessageOf(res: Response): Promise<string> {
  if (res.status === 401) return "Your session expired. Sign in again.";
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string" && body.error.message !== "") return body.error.message;
  } catch {
    /* not JSON */
  }
  return GENERIC_ERROR;
}

export interface MetaInfo {
  conversationId: string;
  title: string;
  /** Questions left after this one. */
  turnsLeft: number;
}

export interface UseAdvisorChatOptions {
  initialMessages?: UiMessage[];
  initialActiveId?: string | null;
  initialTurnsLeft?: number | null;
  initialTokens24h?: number | null;
  /** The page the person is on, sent with each message (pathname only). */
  getPageContext?: () => { path: string };
  /** Called when the server confirms the conversation (first event of a turn). */
  onMeta?: (info: MetaInfo) => void;
}

export function useAdvisorChat(opts: UseAdvisorChatOptions = {}) {
  const [messages, setMessages] = useState<UiMessage[]>(opts.initialMessages ?? []);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(opts.initialActiveId ?? null);
  const [turnsLeft, setTurnsLeft] = useState<number | null>(opts.initialTurnsLeft ?? null);
  const [tokens24h, setTokens24h] = useState<number | null>(opts.initialTokens24h ?? null);
  const abortRef = useRef<AbortController | null>(null);

  async function send() {
    const message = input.trim();
    if (message === "" || streaming) return;
    setInput("");
    setStreaming(true);
    const stamp = Date.now();
    const assistantId = `live-${stamp}`;
    setMessages((prev) => [
      ...prev,
      { id: `user-${stamp}`, role: "user", text: message, tools: [], links: [], notices: [], streaming: false, error: null },
      liveMessage(assistantId, emptyTurn(), true),
    ]);
    const ac = new AbortController();
    abortRef.current = ac;
    let view: TurnView = emptyTurn();
    const paint = () => {
      const snapshot = view;
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? liveMessage(assistantId, snapshot, !snapshot.finished) : m)));
    };
    try {
      const pageContext = opts.getPageContext?.();
      const res = await fetch("/api/advisor/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeId, message, ...(pageContext !== undefined ? { pageContext } : {}) }),
        signal: ac.signal,
      });
      if (!res.ok || res.body === null) {
        view = { ...view, error: await errorMessageOf(res), finished: true };
        if (res.status === 429) setTurnsLeft(0);
        paint();
        return;
      }
      const reader = res.body.getReader();
      const decoder = createByteDecoder();
      const handle = (events: ReturnType<typeof decoder.push>) => {
        for (const ev of events) {
          view = applyEvent(view, ev);
          if (ev.t === "meta") {
            setActiveId(ev.conversationId);
            setTurnsLeft(ev.remaining.turns);
            if (ev.remaining.tokens24h !== undefined) setTokens24h(ev.remaining.tokens24h);
            opts.onMeta?.({ conversationId: ev.conversationId, title: ev.title, turnsLeft: ev.remaining.turns });
          }
          // This turn's fresh tokens join the last-24-hours count once the turn is finished.
          if (ev.t === "done") setTokens24h((t) => (t === null ? null : t + ev.usage.in + ev.usage.out));
        }
        paint();
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        handle(decoder.push(value));
      }
      handle(decoder.flush());
    } catch {
      view = ac.signal.aborted ? { ...view, notices: [...view.notices, "Stopped."], finished: true } : { ...view, error: GENERIC_ERROR, finished: true };
      paint();
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  /** A fresh, empty conversation (does nothing while an answer is streaming). */
  function reset() {
    if (streaming) return;
    setActiveId(null);
    setMessages([]);
  }

  return { messages, setMessages, input, setInput, streaming, activeId, setActiveId, turnsLeft, setTurnsLeft, tokens24h, setTokens24h, send, stop, reset };
}
