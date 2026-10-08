"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Plus, X } from "lucide-react";
import { getMyConversation } from "@/actions/advisor";
import { getMyAdvisorUsage } from "@/actions/advisor-usage";
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/advisor/composer";
import { MessageBubble } from "@/components/advisor/message-bubble";
import { useAdvisorChat } from "@/components/advisor/use-advisor-chat";
import { toUiMessage } from "@/lib/advisor/chat-state";
import { LIMITS } from "@/lib/advisor/config";
import { contextChipText, parsePageContext } from "@/lib/advisor/page-context";
import { STARTER_PROMPTS } from "@/lib/advisor/starters";

// The right-hand assistant panel (advisor-ai-chatbot-phase2 plan, section 6). Same chat as the Advisor page (the same hook, bubbles and composer);
// its conversations are ordinary conversations and also appear in the Advisor page's list. It is NOT modal: the page behind stays usable.
// AppShell remounts on every navigation, so the conversation id is kept in sessionStorage and restored when the panel is opened.
// Always mounted after the first open, so the wrapper is `inert` while closed (nothing in it is reachable by keyboard or screen reader).

const STORAGE_KEY = "advisor.slideover.conversation";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readStoredId(): string | null {
  try {
    const v = window.sessionStorage.getItem(STORAGE_KEY);
    return v !== null && UUID.test(v) ? v : null;
  } catch {
    return null;
  }
}

function writeStoredId(id: string | null): void {
  try {
    if (id === null) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* storage unavailable (private mode): the panel simply starts fresh next time */
  }
}

interface SlideoverProps {
  open: boolean;
  onClose: () => void;
  /** The current pathname (client navigation changes it). */
  pathname: string;
}

export function AdvisorSlideover({ open, onClose, pathname }: SlideoverProps) {
  const chat = useAdvisorChat({
    getPageContext: () => ({ path: window.location.pathname }),
    onMeta: ({ conversationId }) => writeStoredId(conversationId),
  });
  const { messages, setMessages, input, setInput, streaming, activeId, setActiveId, turnsLeft, setTurnsLeft, tokens24h, setTokens24h } = chat;
  const panelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const context = parsePageContext(pathname);

  // On the first open: restore the conversation of this browser session (a missing one starts a new chat) and read today's usage.
  useEffect(() => {
    if (!open || restored.current) return;
    restored.current = true;
    const storedId = readStoredId();
    void (async () => {
      try {
        const usage = await getMyAdvisorUsage();
        setTurnsLeft((t) => t ?? usage.turnsLeft);
        setTokens24h((t) => t ?? usage.tokens24h);
      } catch {
        /* the usage line just shows less */
      }
      if (storedId === null) return;
      try {
        const res = await getMyConversation(storedId);
        if (res === null) {
          writeStoredId(null);
          return;
        }
        // Do not clobber a chat the person already started while this restore was loading.
        setActiveId((a) => a ?? storedId);
        setMessages((prev) => (prev.length > 0 ? prev : res.messages.map(toUiMessage)));
      } catch {
        writeStoredId(null);
      }
    })();
  }, [open, setActiveId, setMessages, setTurnsLeft, setTokens24h]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function newChat() {
    if (streaming) return;
    chat.reset();
    writeStoredId(null);
  }

  function send() {
    if (input.trim() === "" || streaming) return;
    void chat.send();
  }

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-label="Assistant"
      inert={!open}
      aria-hidden={!open}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className={`fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-card shadow-xl outline-none transition-transform duration-200 md:w-[26rem] print:hidden ${open ? "translate-x-0" : "pointer-events-none translate-x-full"}`}
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Assistant</h2>
          {context !== null && <p className="truncate text-[11px] text-muted-foreground">Looking at: {contextChipText(context)}</p>}
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={newChat} disabled={streaming}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New chat
          </Button>
          {activeId !== null && (
            <Link href={`/advisor?c=${activeId}` as Route} onClick={onClose} className="px-2 text-xs text-primary underline underline-offset-2">
              Open in Advisor
            </Link>
          )}
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close the assistant">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3" role="log" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Ask about your finances, taxes and filings. I can read, not change anything.</p>
            <div className="grid gap-2">
              {STARTER_PROMPTS.slice(0, 4).map((p) => (
                <button key={p} type="button" onClick={() => setInput(p)} className="rounded-lg border bg-card px-3 py-2 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground">
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <Composer value={input} onChange={setInput} onSend={send} onStop={chat.stop} streaming={streaming} turnsLeft={turnsLeft} tokens24h={tokens24h} maxChars={LIMITS.maxMessageChars} />
    </div>
  );
}
