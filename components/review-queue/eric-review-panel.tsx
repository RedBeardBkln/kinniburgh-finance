"use client";

import { useRef, useState, useTransition } from "react";
import { getShareLink, resendText, submitToEva } from "@/actions/review-assignments";
import { assigneeFirstName } from "@/lib/review-queue";
import type { BatchStatusRow } from "@/lib/review-queue-server";

// Eric-side panel above the transactions table: submit the draft to the
// assignee (which texts her the link), see the status of recent batches
// including text / reminder failures, Resend the text, or copy a fresh magic
// link to share by hand. The raw token is shown once; only its hash is stored,
// so "Get link" and "Resend text" each mint a new one.

interface Props {
  assigneeName: string;
  draftCount: number;
  batches: BatchStatusRow[];
}

interface ShownLink {
  /** Which row it belongs to: "draft" (just-submitted) or a batch id. */
  forKey: string;
  url: string;
  expiresAt: string;
  note: string | null;
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(iso));
}

function LinkBox({ link }: { link: ShownLink }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      inputRef.current?.select();
      setCopied(false);
    }
  }

  return (
    <div className="mt-2 space-y-1.5 rounded-md border bg-background p-3">
      {link.note && <p className="text-xs font-medium">{link.note}</p>}
      <div className="flex gap-2">
        <input
          ref={inputRef}
          readOnly
          value={link.url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Magic link"
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-muted/30 px-2 font-mono text-xs"
        />
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Anyone with this link can view and tag these transactions until {formatDateTime(link.expiresAt)}. It is
        shown only now - use &quot;Get link&quot; for a new one later.
      </p>
    </div>
  );
}

/** The status lines for one submitted batch: text outcome first, then the reminder. */
function TextStatus({ batch, who }: { batch: BatchStatusRow; who: string }) {
  if (batch.status !== "submitted") return null;
  return (
    <div className="mt-1 space-y-0.5 text-xs">
      {batch.smsStatus === "failed" ? (
        <p role="alert" className="font-medium text-destructive">
          Text failed: {batch.smsError ?? "unknown error"}. Use Resend text, or Get link and send it to {who}{" "}
          yourself.
        </p>
      ) : batch.smsStatus === "sent" ? (
        <p className="text-amber-700 dark:text-amber-400">
          Text sent to the carrier gateway{batch.smsSentAt ? ` ${formatDateTime(batch.smsSentAt)}` : ""} -
          carriers don&apos;t confirm delivery.
        </p>
      ) : (
        <p className="text-muted-foreground">No text was sent for this batch.</p>
      )}
      {batch.reminderStatus === "sent" && (
        <p className="text-muted-foreground">
          Reminder text sent{batch.reminderSentAt ? ` ${formatDateTime(batch.reminderSentAt)}` : ""}.
        </p>
      )}
      {batch.reminderStatus === "failed" && (
        <p role="alert" className="font-medium text-destructive">
          Reminder text failed: {batch.reminderError ?? "unknown error"}. It won&apos;t be retried
          automatically.
        </p>
      )}
      {batch.reminderStatus === "sending" && (
        <p className="text-muted-foreground">Reminder text in progress (or interrupted - Resend text if needed).</p>
      )}
    </div>
  );
}

export function EricReviewPanel({ assigneeName, draftCount, batches }: Props) {
  const who = assigneeFirstName(assigneeName);
  const [shown, setShown] = useState<ShownLink | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, startSubmit] = useTransition();
  const [isMinting, startMint] = useTransition();
  const [isResending, startResend] = useTransition();

  if (draftCount === 0 && batches.length === 0) return null;

  function handleSubmit() {
    if (draftCount === 0) return;
    const ok = window.confirm(
      `Submit ${draftCount} transaction${draftCount === 1 ? "" : "s"} to ${who}? ` +
        `She'll be texted a link to tag them.`
    );
    if (!ok) return;
    setError(null);
    setNotice(null);
    setShown(null);
    startSubmit(async () => {
      const res = await submitToEva();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const what = res.appended
        ? `Added ${res.itemCount} to ${who}'s open list.`
        : `Submitted ${res.itemCount}.`;
      if (res.text.sent) {
        setNotice(`${what} Text sent to ${who}.`);
        return;
      }
      // The submit stands; only the text failed. Give Eric the link to share by hand.
      setShown({
        forKey: "draft",
        url: `${window.location.origin}${res.path}`,
        expiresAt: res.expiresAt,
        note: `${what} The text to ${who} failed (${res.text.error}). Send her this link yourself, or use Resend text:`,
      });
    });
  }

  function handleResend(batchId: string) {
    setError(null);
    setNotice(null);
    setShown(null);
    startResend(async () => {
      const res = await resendText(batchId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.text.sent) {
        setNotice(`Text sent to ${who} with a new link.`);
        return;
      }
      setShown({
        forKey: batchId,
        url: `${window.location.origin}${res.path}`,
        expiresAt: res.expiresAt,
        note: `The text failed again (${res.text.error}). Send her this link yourself:`,
      });
    });
  }

  function handleGetLink(batchId: string) {
    setError(null);
    setNotice(null);
    setShown(null);
    startMint(async () => {
      const res = await getShareLink(batchId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setShown({
        forKey: batchId,
        url: `${window.location.origin}${res.path}`,
        expiresAt: res.expiresAt,
        note: null,
      });
    });
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3 text-sm">
      {draftCount > 0 && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className="font-medium">
                {draftCount} transaction{draftCount === 1 ? "" : "s"}
              </span>{" "}
              in draft for {who} (not sent yet)
            </span>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {isSubmitting ? "Submitting…" : `Submit to ${who} (${draftCount})`}
            </button>
          </div>
        </div>
      )}

      {/* Rendered outside the draft block: after Submit the draft count drops to 0 (and the page revalidates) but the link must stay visible. */}
      {shown?.forKey === "draft" && <LinkBox link={shown} />}

      {batches.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Sent to {who}
          </p>
          <ul className="space-y-2">
            {batches.map((b) => (
              <li key={b.id} className="rounded-md border bg-background p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs">
                    <p className="font-medium">
                      {b.status === "completed"
                        ? "Completed"
                        : b.firstOpenedAt
                          ? `Opened ${formatDateTime(b.firstOpenedAt)}`
                          : "Not opened yet"}
                      {b.submittedAt && (
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          · submitted {formatDateTime(b.submittedAt)}
                        </span>
                      )}
                    </p>
                    <p className="text-muted-foreground">
                      {b.resolved} of {b.total} tagged
                      {b.returned > 0 ? ` · ${b.returned} sent back` : ""}
                      {b.pending > 0 ? ` · ${b.pending} waiting` : ""}
                    </p>
                  </div>
                  {b.status === "submitted" && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleResend(b.id)}
                        disabled={isResending || isMinting}
                        className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        {isResending ? "Sending…" : "Resend text"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleGetLink(b.id)}
                        disabled={isMinting || isResending}
                        className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        Get link
                      </button>
                    </div>
                  )}
                </div>
                <TextStatus batch={b} who={who} />
                {shown?.forKey === b.id && <LinkBox link={shown} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {notice && (
        <p role="status" className="text-xs font-medium text-green-700 dark:text-green-400">
          {notice}
        </p>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
