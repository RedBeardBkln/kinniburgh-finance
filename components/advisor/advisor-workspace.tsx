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
import { useAdvisorChat } from "@/components/advisor/use-advisor-chat";
import { toUiMessage, type ConversationView, type UiMessage } from "@/lib/advisor/chat-state";
import { LIMITS } from "@/lib/advisor/config";
import { STARTER_PROMPTS } from "@/lib/advisor/starters";

interface AdvisorWorkspaceProps {
  initialConversations: ConversationView[];
  initialActiveId: string | null;
  initialMessages: UiMessage[];
  initialMemory: MemoryNoteDto[];
  turnsLeft: number | null;
  /** Fresh tokens used in the last 24 hours (null = unknown). */
  tokens24h?: number | null;
  /** "ok", or why the assistant's tables cannot be used yet (the Goals panel keeps working). */
  storage: "ok" | "table_missing" | "error";
  /** Server time at render, ISO (the conversation list says "today" / "yesterday" from it). */
  nowIso: string;
  goalsSlot: React.ReactNode;
}

export function AdvisorWorkspace({ initialConversations, initialActiveId, initialMessages, initialMemory, turnsLeft: initialTurnsLeft, tokens24h: initialTokens24h, storage, nowIso, goalsSlot }: AdvisorWorkspaceProps) {
  const [conversations, setConversations] = useState(initialConversations);
  const [railOpen, setRailOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const chat = useAdvisorChat({
    initialMessages,
    initialActiveId,
    initialTurnsLeft,
    initialTokens24h: initialTokens24h ?? null,
    getPageContext: () => ({ path: window.location.pathname }),
    onMeta: ({ conversationId, title }) => onMeta(conversationId, title),
  });
  const { messages, setMessages, input, setInput, streaming, activeId, setActiveId, turnsLeft, tokens24h } = chat;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function setUrl(id: string | null) {
    window.history.replaceState(null, "", id === null ? "/advisor" : `/advisor?c=${id}`);
  }

  function newChat() {
    if (streaming) return;
    chat.reset();
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

  function onMeta(conversationId: string, title: string) {
    setUrl(conversationId);
    const nowIsoText = new Date().toISOString();
    setConversations((prev) => {
      const existing = prev.find((c) => c.id === conversationId);
      const row: ConversationView = { id: conversationId, title: existing?.title ?? title, messageCount: (existing?.messageCount ?? 0) + 2, lastMessageAt: nowIsoText };
      return [row, ...prev.filter((c) => c.id !== conversationId)];
    });
  }

  function send() {
    if (input.trim() === "" || streaming) return;
    setBanner(null);
    void chat.send();
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
          onSend={send}
          onStop={chat.stop}
          streaming={streaming}
          turnsLeft={turnsLeft}
          tokens24h={tokens24h}
          maxChars={LIMITS.maxMessageChars}
        />
      </section>
    </div>
  );
}
