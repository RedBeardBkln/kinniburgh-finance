"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTransactionNotes } from "@/actions/transactions";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

interface Props {
  transactionId: string;
  initialNotes: string | null;
}

export function TransactionNotesEditor({ transactionId, initialNotes }: Props) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [savedNotes, setSavedNotes] = useState(initialNotes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isDirty = notes !== savedNotes;

  function handleSave() {
    if (notes.length > 2000) {
      setError("Note must be 2000 characters or fewer");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await updateTransactionNotes(transactionId, notes.trim() || null);
        setSavedNotes(notes);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save note");
      }
    });
  }

  return (
    <div className="space-y-2">
      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Add a note about this transaction (optional)"
        rows={3}
        disabled={isPending}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={isPending || !isDirty}>
          {isPending ? "Saving…" : "Save note"}
        </Button>
        {isDirty && !isPending && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setNotes(savedNotes);
              setError(null);
            }}
          >
            Reset
          </Button>
        )}
        {!isDirty && savedNotes && (
          <span className="text-xs text-muted-foreground">Saved</span>
        )}
      </div>
    </div>
  );
}