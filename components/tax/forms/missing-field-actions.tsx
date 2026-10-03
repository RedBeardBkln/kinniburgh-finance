"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { TAX_QUESTION_BANK } from "@/lib/tax-guidance";
import type { FieldFix } from "@/lib/tax-form-fixes";
import { answerTaxQuestionByKey } from "@/actions/tax-planning";
import { uploadTaxFile } from "@/components/tax/tax-document-upload";

// Click targets for ONE missing Forms-page field: every way to supply its data.
// Questions and documents open a dialog (answer / upload / open the document
// that is already on file); books and mileage jump to the page where the data is
// entered; lines no part of the app can supply say so plainly. Saving refreshes
// the page so the field, its form's readiness and the counts all recompute.

const CHIP =
  "rounded-md border border-primary/40 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10";

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Answer a planning question ────────────────────────────────────────────────

function QuestionDialog({ questionKey, taxYear, onClose }: { questionKey: string; taxYear: number; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const def = TAX_QUESTION_BANK.find((q) => q.key === questionKey);

  if (!def) {
    return (
      <Shell title="Unknown question" onClose={onClose}>
        <p className="text-sm text-muted-foreground">This planning question is no longer in the question bank.</p>
      </Shell>
    );
  }

  async function save(answer: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await answerTaxQuestionByKey({ taxYear, key: questionKey, answer });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      startTransition(() => router.refresh());
      onClose();
    } catch {
      setError("Could not save the answer — try again.");
    } finally {
      setSaving(false);
    }
  }

  const busy = saving || pending;
  return (
    <Shell title={def.question} onClose={onClose}>
      <p className="text-xs leading-relaxed text-muted-foreground">{def.context}</p>
      <div className="mt-3 space-y-2">
        {def.options ? (
          def.options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              disabled={busy}
              onClick={() => save(opt.value)}
              className="block w-full rounded-md border px-3 py-2 text-left transition-colors hover:border-primary disabled:opacity-60"
            >
              <span className="text-sm font-medium">{opt.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{opt.note}</span>
            </button>
          ))
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void save(text.trim());
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={def.placeholder ?? "Type your answer…"}
              className="w-full rounded-md border px-3 py-2 text-sm"
              autoFocus
            />
            <button
              type="submit"
              disabled={busy || text.trim() === ""}
              className="mt-2 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save answer"}
            </button>
          </form>
        )}
      </div>
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <p className="mt-3 text-[11px] text-muted-foreground">
        Saved to the {taxYear} Personal workspace&apos;s planning questions — the same answer you would give there.
      </p>
    </Shell>
  );
}

// ── Upload / open a document ──────────────────────────────────────────────────

type DocumentFix = Extract<FieldFix, { kind: "document" }>;

function DocumentDialog({ fix, onClose }: { fix: DocumentFix; onClose: () => void }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a file first.");
      return;
    }
    setUploading(true);
    setError(null);
    setMessage(null);
    const result = await uploadTaxFile(file, fix.entityId, fix.taxYear, fix.docType, undefined);
    setUploading(false);
    if (!result.success) {
      setError(result.error ?? "Upload failed");
      return;
    }
    setMessage(`Uploaded ${result.fileName}. The list above now shows it — open it to confirm what was read.`);
    if (fileRef.current) fileRef.current.value = "";
    startTransition(() => router.refresh());
  }

  return (
    <Shell title={`${fix.docTypeLabel} — ${fix.taxYear}`} onClose={onClose}>
      <p className="text-xs leading-relaxed text-muted-foreground">{fix.hint}</p>

      <div className="mt-3">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
          Already on file for {fix.taxYear}
        </p>
        {fix.existing.length === 0 ? (
          <p className="text-xs text-muted-foreground">No {fix.docTypeLabel} for {fix.taxYear} yet.</p>
        ) : (
          <ul className="space-y-1">
            {fix.existing.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="font-medium">{d.name}</span>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {d.statusLabel}
                </span>
                {d.reviewHref ? (
                  <Link href={d.reviewHref as Route} prefetch={false} className="text-primary hover:underline">
                    {d.verified ? "View" : "Review / enter missing info"}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">no reading to review — retry extraction on the Documents page</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <Link href={fix.documentsHref as Route} className="mt-1 inline-block text-xs text-primary hover:underline">
          See all {fix.docTypeLabel} documents →
        </Link>
      </div>

      <div className="mt-4 border-t pt-3">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
          Upload {fix.docTypeLabel}
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          className="block w-full text-xs"
        />
        <button
          type="button"
          onClick={upload}
          disabled={uploading}
          className="mt-2 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {uploading ? "Uploading and reading…" : "Upload"}
        </button>
        {message && <p className="mt-2 text-xs text-green-700">{message}</p>}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Filed under Personal for {fix.taxYear}. Set the person and issuer afterwards on the Documents page.
        </p>
      </div>
    </Shell>
  );
}

// ── One missing field ─────────────────────────────────────────────────────────

function fixButtonLabel(fix: FieldFix): string {
  if (fix.kind === "question") {
    return `Answer: ${TAX_QUESTION_BANK.find((q) => q.key === fix.questionKey)?.question ?? fix.questionKey}`;
  }
  if (fix.kind === "document") {
    return fix.existing.length > 0 ? `Open / upload ${fix.docTypeLabel}` : `Upload ${fix.docTypeLabel}`;
  }
  return "";
}

export function MissingFieldActions({ fixes, taxYear }: { fixes: FieldFix[]; taxYear: number }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const close = () => setOpenIndex(null);
  if (fixes.length === 0) return null;

  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5">
      {fixes.map((fix, i) => {
        if (fix.kind === "none") {
          return (
            <span key={i} className="text-[11px] italic text-muted-foreground">
              {fix.reason}
            </span>
          );
        }
        if (fix.kind === "link") {
          return (
            <Link key={i} href={fix.href as Route} className={CHIP}>
              {fix.label} →
            </Link>
          );
        }
        return (
          <span key={i}>
            <button type="button" onClick={() => setOpenIndex(i)} className={CHIP}>
              {fixButtonLabel(fix)}
            </button>
            {openIndex === i && fix.kind === "question" && (
              <QuestionDialog questionKey={fix.questionKey} taxYear={taxYear} onClose={close} />
            )}
            {openIndex === i && fix.kind === "document" && <DocumentDialog fix={fix} onClose={close} />}
          </span>
        );
      })}
    </span>
  );
}
