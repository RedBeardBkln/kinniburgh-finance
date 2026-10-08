"use client";

import { useEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { archiveConversation, getMyConversation, renameConversation } from "@/actions/advisor";
import { Button } from "@/components/ui/button";
import { CollapsibleSection } from "@/components/advisor/collapsible-section";
import { Composer } from "@/components/advisor/composer";
import { ConversationList } from "@/components/advisor/conversation-list";
import { MemoryPanel, type MemoryNoteDto } from "@/components/advisor/memory-panel";
import { MessageBubble } from "@/components/advisor/message-bubble";
import { VisibilityNotice } from "@/components/advisor/visibility-notice";
import { applyEvent, emptyTurn, liveMessage, toUiMessage, type ConversationView, type TurnView, type UiMessage } from "@/lib/advisor/chat-state";
import { LIMITS } from "@/lib/advisor/config";
import { STARTER_PROMPTS } from "@/lib/advisor/starters";
import { createByteDecoder } from "@/lib/advisor/stream-protocol";

interface AdvisorWorkspaceProps {
  initialConversations: ConversationView[];
  initialActiveId: string | null;
  initialMessages: UiMessage[];
  initialMemory: MemoryNoteDto[];
  turnsLeft: number | null;
  /** "ok", or why the assistant's tables cannot be used yet (the Goals panel keeps working). */
  storage: "ok" | "table_missing" | "error";
  /** Server time at render, ISO (the conversation list says "today" / "yesterday" from it). */
  nowIso: string;
  goalsSlot: React.ReactNode;
}

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

export function AdvisorWorkspace({ initialConversations, initialActiveId, initialMessages, initialMemory, turnsLeft: initialTurnsLeft, storage, nowIso, goalsSlot }: AdvisorWorkspaceProps) {
  const [conversations, setConversations] = useState(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(initialActiveId);
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [turnsLeft, setTurnsLeft] = useState<number | null>(initialTurnsLeft);
  const [railOpen, setRailOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function setUrl(id: string | null) {
    window.history.replaceState(null, "", id === null ? "/advisor" : `/advisor?c=${id}`);
  }

  function newChat() {
    if (streaming) return;
    setActiveId(null);
    setMessages([]);
    setBanner(null);
    setUrl(null);
    setRailOpen(false);
  }

  async function select(id: string) {
    if (streaming || id === activeId) return;
    setBanner(null);
    const res = await getMyConversation(id);
    if (res === null) {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      setBanner("That conversation was not found.");
      return;
    }
    setActiveId(id);
    setMessages(res.messages.map(toUiMessage));
    setUrl(id);
    setRailOpen(false);
  }

  async function rename(id: string, title: string): Promise<string | null> {
    const res = await renameConversation(id, title);
    if (!res.ok) return res.error;
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: title.replace(/\s+/g, " ").trim().slice(0, LIMITS.titleChars) } : c)));
    return null;
  }

  async function archive(id: string): Promise<string | null> {
    const res = await archiveConversation(id);
    if (!res.ok) return res.error;
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === activeId) newChat();
    return null;
  }

  function onMeta(conversationId: string, title: string, remaining: number) {
    setActiveId(conversationId);
    setTurnsLeft(remaining);
    setUrl(conversationId);
    const nowIsoText = new Date().toISOString();
    setConversations((prev) => {
      const existing = prev.find((c) => c.id === conversationId);
      const row: ConversationView = { id: conversationId, title: existing?.title ?? title, messageCount: (existing?.messageCount ?? 0) + 2, lastMessageAt: nowIsoText };
      return [row, ...prev.filter((c) => c.id !== conversationId)];
    });
  }

  async function send() {
    const message = input.trim();
    if (message === "" || streaming) return;
    setInput("");
    setBanner(null);
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
      const res = await fetch("/api/advisor/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeId, message }),
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
          if (ev.t === "meta") onMeta(ev.conversationId, ev.title, ev.remaining.turns);
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

  const unavailable = storage !== "ok";

  return (
    <div className="relative flex min-h-0 flex-1 gap-4">
      <aside
        className={`${railOpen ? "flex" : "hidden"} absolute inset-y-0 left-0 z-20 w-80 max-w-[85vw] shrink-0 flex-col gap-3 overflow-y-auto rounded-xl border bg-card p-3 shadow-lg md:static md:flex md:max-w-none md:shadow-none`}
        aria-label="Conversations, memory and goals"
      >
        <ConversationList conversations={conversations} activeId={activeId} now={nowIso} busy={streaming} onNew={newChat} onSelect={(id) => void select(id)} onRename={rename} onArchive={archive} />
        <CollapsibleSection title="Memory">
          <MemoryPanel initialNotes={initialMemory} enabled={storage === "ok"} />
        </CollapsibleSection>
        <CollapsibleSection title="Goals">{goalsSlot}</CollapsibleSection>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="icon" className="md:hidden" onClick={() => setRailOpen((o) => !o)} aria-label="Conversations, memory and goals" aria-expanded={railOpen}>
              <Menu className="h-4 w-4" />
            </Button>
            <h2 className="text-sm font-medium">{conversations.find((c) => c.id === activeId)?.title ?? "New conversation"}</h2>
          </div>
          <VisibilityNotice />
        </div>

        {unavailable && (
          <p className="border-b bg-muted px-3 py-2 text-xs" role="status">
            {storage === "table_missing" ? "The assistant is not set up yet: its database tables have not been created. The Goals panel still works." : "The assistant could not load its saved conversations right now. You can still ask a question."}
          </p>
        )}
        {banner !== null && (
          <p className="border-b bg-muted px-3 py-2 text-xs" role="status">
            {banner}
          </p>
        )}

        <div className="flex-1 overflow-y-auto p-4" role="log" aria-live="polite" aria-label="Conversation">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-6">
              <div className="max-w-md space-y-2 text-center">
                <h3 className="text-lg font-semibold">Ask about your finances, taxes and filings</h3>
                <p className="text-sm text-muted-foreground">
                  I look things up in your accounts, budgets, transactions and the TY2025 return as you ask. I can read, not change. Open the Tax Forms hub for anything that needs a decision from you.
                </p>
              </div>
              <div className="grid w-full max-w-lg gap-2">
                {STARTER_PROMPTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setInput(p)}
                    className="rounded-lg border bg-card px-4 py-3 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <Composer
          value={input}
          onChange={setInput}
          onSend={() => void send()}
          onStop={() => abortRef.current?.abort()}
          streaming={streaming}
          turnsLeft={turnsLeft}
          maxChars={LIMITS.maxMessageChars}
        />
      </section>
    </div>
  );
}
