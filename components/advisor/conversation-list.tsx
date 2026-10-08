"use client";

import { useState } from "react";
import { Archive, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { relativeDay, type ConversationView } from "@/lib/advisor/chat-state";

interface ConversationListProps {
  conversations: readonly ConversationView[];
  activeId: string | null;
  now: string;
  busy: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<string | null>;
  onArchive: (id: string) => Promise<string | null>;
}

export function ConversationList({ conversations, activeId, now, busy, onNew, onSelect, onRename, onArchive }: ConversationListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const today = new Date(now);

  async function commitRename(id: string) {
    const err = await onRename(id, draft);
    setError(err);
    if (err === null) setEditingId(null);
  }

  async function archive(c: ConversationView) {
    if (!window.confirm(`Archive "${c.title}"? It disappears from this list; nothing is deleted.`)) return;
    setError(await onArchive(c.id));
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="sm" className="w-full justify-start gap-1.5" onClick={onNew} disabled={busy}>
        <Plus className="h-3.5 w-3.5" /> New chat
      </Button>
      {error !== null && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {conversations.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">No conversations yet. Ask a question to start one.</p>
      ) : (
        <ul className="space-y-0.5">
          {conversations.map((c) => (
            <li key={c.id} className={`group rounded-md ${c.id === activeId ? "bg-accent" : "hover:bg-accent/60"}`}>
              {editingId === c.id ? (
                <form
                  className="flex gap-1 p-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void commitRename(c.id);
                  }}
                >
                  <Input value={draft} onChange={(e) => setDraft(e.target.value.slice(0, 80))} aria-label="Conversation title" className="h-8 text-xs" autoFocus />
                  <Button type="submit" size="sm" className="h-8 px-2 text-xs">
                    Save
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <div className="flex items-center gap-1 pr-1">
                  <button type="button" className="min-w-0 flex-1 px-2 py-1.5 text-left disabled:opacity-60" onClick={() => onSelect(c.id)} disabled={busy} aria-current={c.id === activeId ? "true" : undefined}>
                    <span className="block truncate text-sm">{c.title}</span>
                    <span className="block text-[11px] text-muted-foreground">{relativeDay(c.lastMessageAt, today)}</span>
                  </button>
                  <button
                    type="button"
                    className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                    aria-label={`Rename ${c.title}`}
                    onClick={() => {
                      setDraft(c.title);
                      setEditingId(c.id);
                    }}
                    disabled={busy}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                    aria-label={`Archive ${c.title}`}
                    onClick={() => void archive(c)}
                    disabled={busy}
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
