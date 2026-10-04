"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { TAX_QUESTION_BANK, renderTaxQuestion } from "@/lib/tax-guidance";
import type { FieldFix } from "@/lib/tax-form-fixes";
import { answerTaxQuestionByKey } from "@/actions/tax-planning";
import { uploadTaxFile } from "@/components/tax/tax-document-upload";
import { DonationForm } from "@/components/donations/donation-form";
import { FixedAssetForm } from "@/components/fixed-assets/fixed-asset-form";

// Click targets for ONE missing Forms-page field: every way to supply its data.
// Questions, documents, donations and fixed assets open a dialog (answer /
// upload / quick-add); "none this year" confirms in one click; books, mileage and
// the full donation / fixed-asset pages are links; lines nothing can supply say
// so plainly. Saving refreshes the page so the field, its form's readiness and the
// counts all recompute.

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
  const bankDef = TAX_QUESTION_BANK.find((q) => q.key === questionKey);
  const def = bankDef ? renderTaxQuestion(bankDef, taxYear) : undefined;

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

// ── Quick-add a donation / a fixed asset ──────────────────────────────────────
// Reuse the full-page forms without the receipt / invoice picker (that lives on
// the full page). Saving refreshes the page and closes the dialog.

type DonationFix = Extract<FieldFix, { kind: "donation" }>;
type FixedAssetFix = Extract<FieldFix, { kind: "fixed_asset" }>;

function DonationDialog({ fix, onClose }: { fix: DonationFix; onClose: () => void }) {
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const defaultDate = today.startsWith(`${fix.taxYear}-`) ? today : `${fix.taxYear}-12-31`;
  return (
    <Shell title={`Add a charitable gift — ${fix.taxYear}`} onClose={onClose}>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Records one gift for the Schedule A line. It is saved to the {fix.taxYear} donation log; nothing here computes a
        deduction.{" "}
        <Link href={fix.logHref as Route} className="text-primary hover:underline">
          Open the full donation log →
        </Link>
      </p>
      <DonationForm
        defaultDate={defaultDate}
        year={fix.taxYear}
        personalEntityId={null}
        documents={[]}
        hideReceipt
        onDone={onClose}
        onCancel={onClose}
      />
    </Shell>
  );
}

function FixedAssetDialog({ fix, onClose }: { fix: FixedAssetFix; onClose: () => void }) {
  return (
    <Shell title={`Add a ${fix.entityLabel} asset`} onClose={onClose}>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        {fix.hint.replace(/\.$/, "")}. Saved to the fixed-asset register for you to review; nothing here computes depreciation.{" "}
        <Link href={fix.listHref as Route} className="text-primary hover:underline">
          Open the full register →
        </Link>
      </p>
      <FixedAssetForm
        entityId={fix.entityId}
        entityLabel={fix.entityLabel}
        year={fix.taxYear}
        defaultRealProperty={fix.realProperty}
        documents={[]}
        hideInvoice
        onDone={onClose}
        onCancel={onClose}
      />
    </Shell>
  );
}

// ── "None this year" in one click ─────────────────────────────────────────────

type ConfirmNoneFix = Extract<FieldFix, { kind: "confirm_none" }>;

function ConfirmNoneChip({ fix }: { fix: ConfirmNoneFix }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmNone() {
    if (!window.confirm(`${fix.label}? This records "none" for ${fix.taxYear} and marks the line done.`)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await answerTaxQuestionByKey({ taxYear: fix.taxYear, key: fix.questionKey, answer: "none" });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Could not save — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <span>
      <button type="button" onClick={confirmNone} disabled={saving || pending} className={`${CHIP} disabled:opacity-60`}>
        {saving || pending ? "Saving…" : fix.label}
      </button>
      {error && <span className="ml-1 text-[11px] text-destructive">{error}</span>}
    </span>
  );
}

// ── One missing field ─────────────────────────────────────────────────────────

function fixButtonLabel(fix: FieldFix, taxYear: number): string {
  switch (fix.kind) {
    case "question":
    {
      const bankDef = TAX_QUESTION_BANK.find((q) => q.key === fix.questionKey);
      return `Answer: ${bankDef ? renderTaxQuestion(bankDef, taxYear).question : fix.questionKey}`;
    }
    case "document":
      return fix.existing.length > 0 ? `Open / upload ${fix.docTypeLabel}` : `Upload ${fix.docTypeLabel}`;
    case "donation":
      return "Add a donation";
    case "fixed_asset":
      return `Add ${fix.entityLabel} asset`;
    case "confirm_none":
      return fix.label;
    case "link":
    case "none":
      return "";
    default: {
      const unreachable: never = fix;
      return unreachable;
    }
  }
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
        if (fix.kind === "confirm_none") {
          return <ConfirmNoneChip key={i} fix={fix} />;
        }
        return (
          <span key={i}>
            <button type="button" onClick={() => setOpenIndex(i)} className={CHIP}>
              {fixButtonLabel(fix, taxYear)}
            </button>
            {openIndex === i && fix.kind === "question" && (
              <QuestionDialog questionKey={fix.questionKey} taxYear={taxYear} onClose={close} />
            )}
            {openIndex === i && fix.kind === "document" && <DocumentDialog fix={fix} onClose={close} />}
            {openIndex === i && fix.kind === "donation" && <DonationDialog fix={fix} onClose={close} />}
            {openIndex === i && fix.kind === "fixed_asset" && <FixedAssetDialog fix={fix} onClose={close} />}
          </span>
        );
      })}
    </span>
  );
}
