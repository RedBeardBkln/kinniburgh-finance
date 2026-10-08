"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { addMemoryNote, forgetMemoryNote, listMemoryNotes } from "@/actions/advisor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MEMORY_CATEGORIES, MEMORY_CATEGORY_LABELS, type MemoryCategory } from "@/lib/advisor/memory-categories";

export interface MemoryNoteDto {
  id: string;
  text: string;
  category: string;
  createdByName: string;
  /** ISO timestamp. */
  createdAt: string;
  source: string;
}

interface MemoryPanelProps {
  initialNotes: MemoryNoteDto[];
  /** False when the assistant's tables do not exist yet. */
  enabled: boolean;
}

// The household memory notes: facts and preferences the owners want the assistant to keep in mind in every conversation. They live in this
// app's own database (not in any developer tool), are shared by the household with the author's first name, and "forget" archives (nothing
// is deleted). A note that looks like an SSN, EIN, account number or date of birth is refused.
export function MemoryPanel({ initialNotes, enabled }: MemoryPanelProps) {
  const [notes, setNotes] = useState(initialNotes);
  const [text, setText] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("preference");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function reload() {
    const fresh = await listMemoryNotes();
    setNotes(fresh.map((n) => ({ id: n.id, text: n.text, category: n.category, createdByName: n.createdByName, createdAt: n.createdAt.toISOString(), source: n.source })));
  }

  function add() {
    setError(null);
    startTransition(async () => {
      const res = await addMemoryNote(text, category);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setText("");
      await reload();
    });
  }

  function forget(n: MemoryNoteDto) {
    if (!window.confirm("Forget this note? The assistant stops using it; the record is archived, not deleted.")) return;
    setError(null);
    startTransition(async () => {
      const res = await forgetMemoryNote(n.id);
      if (!res.ok) setError(res.error);
      await reload();
    });
  }

  if (!enabled) return <p className="text-xs text-muted-foreground">Memory is not available yet: the assistant&apos;s database tables have not been created.</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Notes here are shared by the household and kept in this app&apos;s own database. The assistant reads them in every conversation as background, not as instructions. Do not put SSNs, account numbers or dates of birth here.
      </p>
      {notes.length === 0 ? (
        <p className="text-xs text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border p-2 text-xs">
              <p className="whitespace-pre-wrap text-sm">{n.text}</p>
              <div className="mt-1 flex items-center justify-between gap-2 text-muted-foreground">
                <span>
                  {MEMORY_CATEGORY_LABELS[n.category as MemoryCategory] ?? "Other"} - {n.createdByName}, {n.createdAt.slice(0, 10)}
                  {n.source === "assistant" ? " (saved by the assistant)" : ""}
                </span>
                <button type="button" className="inline-flex items-center gap-1 rounded p-1 hover:text-foreground disabled:opacity-50" onClick={() => forget(n)} disabled={pending} aria-label="Forget this note">
                  <Trash2 className="h-3.5 w-3.5" /> Forget
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() !== "") add();
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value.slice(0, 400))} placeholder="Add a note, for example: Keep answers short" aria-label="New memory note" disabled={pending} />
        <div className="flex items-center gap-2">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as MemoryCategory)}
            aria-label="Note category"
            className="h-9 rounded-md border border-input bg-background px-2 text-xs"
            disabled={pending}
          >
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {MEMORY_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" disabled={pending || text.trim() === ""}>
            Add note
          </Button>
        </div>
      </form>
      {error !== null && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
