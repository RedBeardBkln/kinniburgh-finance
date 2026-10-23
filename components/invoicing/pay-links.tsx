"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MODAL_OVERLAY, modalPanelClass } from "@/components/ui/modal-frame";
import { cn } from "@/lib/utils";
import { createPayLink, replacePayLink, revokePayLinks } from "@/actions/invoice-links";
import { ErrorLine, OkLine, useRunner } from "@/components/invoicing/shared";
import { newRequestKey } from "@/lib/invoicing/request-key";
import { formatNyDateTime } from "@/lib/invoicing/state";
import type { LinkView } from "@/lib/invoicing/pay-build";

// "Client link" on an issued invoice (owner actions; everyone signed in sees the list read-only). A new link's URL is shown ONCE, in this
// dialog, from the action's answer: only the token's hash is stored, so the URL is never in the page data and cannot be shown again.
// Revoking stops every link of this invoice at once (e-mailed ones included).

const PURPOSE: Record<string, string> = { email: "Sent by e-mail", manual: "Made by you" };

function stateOf(l: LinkView): string {
  if (l.revokedAt) return "Revoked";
  if (!l.live) return "Expired";
  return "Active";
}

export function PayLinksCard({ slug, documentId, links, canEdit, issued }: { slug: string; documentId: string; links: LinkView[]; canEdit: boolean; issued: boolean }) {
  const { pending, error, ok, run } = useRunner();
  const [shownUrl, setShownUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const live = links.filter((l) => l.live).length;

  const mint = (replace: boolean) =>
    run(() => (replace ? replacePayLink : createPayLink)({ slug, documentId, requestKey: newRequestKey() }), {
      onSuccess: (r) => {
        if ("url" in r && typeof r.url === "string") {
          setCopied(false);
          setShownUrl(r.url);
        }
      },
    });

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        A client link opens this invoice (and its PDF) without signing in, and offers &quot;Pay online&quot; while online payments are on. Each e-mail you send carries
        its own link. {live === 0 ? "No link is active." : `${live} link${live === 1 ? " is" : "s are"} active.`}
      </p>
      {links.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {links.slice(0, 20).map((l) => (
            <li key={l.id} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 border-b py-1 last:border-0">
              <span>
                {PURPOSE[l.purpose] ?? l.purpose}, {formatNyDateTime(l.createdAt)} <span className="text-xs text-muted-foreground">({stateOf(l)})</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {l.revokedAt ? `revoked ${formatNyDateTime(l.revokedAt)}` : `valid until ${formatNyDateTime(l.expiresAt)}`}
                {l.firstViewedAt ? `; first opened ${formatNyDateTime(l.firstViewedAt)}, ${l.viewCount} view${l.viewCount === 1 ? "" : "s"}` : "; not opened yet"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit && issued ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => mint(false)}>
            Create link
          </Button>
          {live > 0 ? (
            <>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => mint(true)}>
                Replace link
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  if (window.confirm("Revoke every client link of this invoice? Links already e-mailed stop working at once.")) run(() => revokePayLinks({ slug, documentId }), { okMessage: "All client links were revoked." });
                }}
              >
                Revoke all links
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <ErrorLine message={error} />
      <OkLine message={shownUrl ? null : ok} />
      {shownUrl ? (
        <div className={MODAL_OVERLAY} role="dialog" aria-modal="true" aria-label="New client link">
          <div className={cn(modalPanelClass("md"), "space-y-4 bg-background p-5 shadow-lg")}>
            <h2 className="text-base font-semibold">New client link</h2>
            <p className="text-sm">Copy it now: for security it is shown only this once. Anyone with the link can view this invoice.</p>
            <input readOnly value={shownUrl} className="w-full rounded-md border border-input bg-muted px-3 py-2 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="Client link" />
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  navigator.clipboard
                    .writeText(shownUrl)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
              <a href={shownUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent">
                Open
              </a>
              <Button onClick={() => setShownUrl(null)}>Done</Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
