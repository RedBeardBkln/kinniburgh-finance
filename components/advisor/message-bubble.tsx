import Link from "next/link";
import type { Route } from "next";
import { Loader2 } from "lucide-react";
import { MarkdownView } from "@/components/advisor/markdown-view";
import { ToolChips } from "@/components/advisor/tool-chips";
import { isKnownAppPath } from "@/lib/advisor/links";
import type { UiMessage } from "@/lib/advisor/chat-state";

export function MessageBubble({ message }: { message: UiMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">{message.text}</div>
      </div>
    );
  }
  const sources = message.links.filter((l) => isKnownAppPath(l.path));
  return (
    <div className="flex">
      <div className="max-w-[92%] space-y-2 rounded-2xl rounded-tl-sm border bg-card px-4 py-3">
        <ToolChips chips={message.tools} />
        {message.text === "" && message.streaming ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Working on it...
          </div>
        ) : (
          <MarkdownView text={message.text} />
        )}
        {message.error !== null && <p className="text-xs text-destructive">{message.error}</p>}
        {message.notices.map((n) => (
          <p key={n} className="text-xs text-muted-foreground">
            {n}
          </p>
        ))}
        {sources.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-xs">
            <span className="text-muted-foreground">Sources:</span>
            {sources.map((l) => (
              <Link key={l.path} href={l.path as Route} className="text-primary underline underline-offset-2">
                {l.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
