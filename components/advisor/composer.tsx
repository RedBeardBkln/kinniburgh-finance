"use client";

import { useRef } from "react";
import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  /** null = unknown. 0 = the daily limit is reached. */
  turnsLeft: number | null;
  maxChars: number;
}

export function Composer({ value, onChange, onSend, onStop, streaming, turnsLeft, maxChars }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const limitReached = turnsLeft !== null && turnsLeft <= 0;
  const disabled = streaming || limitReached;
  return (
    <div className="border-t p-3 space-y-1.5">
      {limitReached && (
        <p className="text-xs text-destructive" role="status">
          The daily assistant limit has been reached. Older questions drop off as time passes (the window is the last 24 hours).
        </p>
      )}
      <div className="flex gap-2 items-end">
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value.slice(0, maxChars))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!disabled) onSend();
            }
          }}
          placeholder="Ask about your finances, taxes or filings..."
          aria-label="Message the assistant"
          rows={2}
          className="min-h-[44px] max-h-40 resize-none"
          disabled={limitReached}
        />
        {streaming ? (
          <Button type="button" variant="outline" size="icon" onClick={onStop} aria-label="Stop the answer">
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button type="button" size="icon" onClick={onSend} disabled={disabled || value.trim() === ""} aria-label="Send">
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Press Enter to send, Shift+Enter for a new line.
        {turnsLeft !== null && !limitReached ? ` ${turnsLeft} question${turnsLeft === 1 ? "" : "s"} left today.` : ""} The assistant is software and can be wrong: verify before you act.
      </p>
    </div>
  );
}
