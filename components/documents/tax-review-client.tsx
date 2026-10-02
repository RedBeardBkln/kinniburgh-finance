"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { runDocumentExtraction } from "@/actions/documents";
import {
  confirmDocumentExtraction,
  saveDocumentCorrections,
  unverifyDocumentExtraction,
} from "@/actions/document-verification";
import { EXTRACTION_TONE_CLASS } from "@/components/documents/extraction-cell";
import type { ExtractionDisplay } from "@/lib/document-extraction-state";
import { jsonEqual } from "@/lib/extraction-corrections";
import {
  IMAGE_ZOOM_MAX,
  IMAGE_ZOOM_MIN,
  SPLIT_DEFAULT_PERCENT,
  clampSplitPercent,
  parseStoredSplit,
  splitPercentFromPointer,
  stepImageZoom,
} from "@/lib/resizable-columns";
import {
  crossFieldWarnings,
  getTaxSchema,
  type FieldDef,
  type ScalarFieldSpec,
  type TaxSchemaDocType,
} from "@/lib/tax-extraction-schema";
import {
  buildCorrectionFields,
  draftDiffers,
  draftFromValue,
  emptyRow,
  formatValueForDisplay,
  suggestPaidInTaxYear,
  valueFromDraft,
  type FieldDraft,
} from "@/lib/tax-review-form";

interface Props {
  documentId: string;
  /** Human label of the raw docType, e.g. "W-2". */
  docTypeLabel: string;
  schemaType: TaxSchemaDocType;
  documentTaxYear: number | null;
  /** The extractedAt (ISO) this page was loaded with; sent back to detect a concurrent re-extract. */
  extractedAtIso: string | null;
  summary: string;
  warnings: string[];
  /** extractionData.data exactly as the AI returned it (never edited). */
  aiData: Record<string, unknown>;
  /** Owner corrections that apply to this document type's current schema. */
  corrections: Record<string, { value: unknown; aiValue: unknown }>;
  display: ExtractionDisplay;
  /** "Eric on Oct 2, 2026", already formatted on the server (America/New_York); null when not verified. */
  verifiedBy: string | null;
  fileUrl: string | null;
  isImage: boolean;
  backHref: Route;
  backLabel: string;
}

const SPLIT_STORAGE_KEY = "tax-review-split-percent-v1";

const REEXTRACT_CONFIRM =
  "Re-extract replaces the AI-read values with a fresh AI read (one API call). Your corrections are kept and still override it.";
const REEXTRACT_VERIFIED_NOTE =
  " This document is verified - re-extracting marks it unverified until you confirm it again.";

const inputClass = "block w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";
const smallButton =
  "rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50";

export function TaxReviewClient({
  documentId,
  docTypeLabel,
  schemaType,
  documentTaxYear,
  extractedAtIso,
  summary,
  warnings,
  aiData,
  corrections,
  display,
  verifiedBy,
  fileUrl,
  isImage,
  backHref,
  backLabel,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const schema = getTaxSchema(schemaType);
  const verified = display.kind === "verified";

  // The form starts from the EFFECTIVE value: the AI value, overlaid by any
  // earlier correction (a corrected null stays null).
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>(() => {
    const out: Record<string, FieldDraft> = {};
    for (const def of schema.fields) {
      const effective = def.key in corrections ? corrections[def.key]?.value : aiData[def.key];
      out[def.key] = draftFromValue(def, effective);
    }
    return out;
  });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"reextract" | null>(null);

  // Side-by-side layout: the document pane's share of the width (draggable
  // divider, remembered per browser) and the zoom of a scanned image.
  const splitRef = useRef<HTMLDivElement>(null);
  const splitDragging = useRef(false);
  const [splitPercent, setSplitPercent] = useState(SPLIT_DEFAULT_PERCENT);
  const [imageZoom, setImageZoom] = useState(IMAGE_ZOOM_MIN);

  useEffect(() => {
    // Read after mount so the server render and first client render agree.
    try {
      setSplitPercent(parseStoredSplit(window.localStorage.getItem(SPLIT_STORAGE_KEY)));
    } catch {
      /* storage unavailable: keep the default */
    }
  }, []);

  function setSplit(percent: number, save: boolean) {
    const next = clampSplitPercent(percent);
    setSplitPercent(next);
    if (save) {
      try {
        window.localStorage.setItem(SPLIT_STORAGE_KEY, String(next));
      } catch {
        /* best-effort */
      }
    }
  }

  function percentForPointer(clientX: number): number {
    const rect = splitRef.current?.getBoundingClientRect();
    return rect ? splitPercentFromPointer(clientX, rect.left, rect.width) : SPLIT_DEFAULT_PERCENT;
  }

  function onSplitPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    splitDragging.current = true;
  }

  function onSplitPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (splitDragging.current) setSplit(percentForPointer(e.clientX), false);
  }

  function onSplitPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!splitDragging.current) return;
    splitDragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setSplit(percentForPointer(e.clientX), true);
  }

  function onSplitKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setSplit(splitPercent + (e.key === "ArrowRight" ? 2 : -2), true);
  }

  const stateLinesFilled = (drafts["stateLines"]?.rows.length ?? 0) > 0;
  const isVisible = (def: FieldDef) => !def.legacy || !stateLinesFilled;
  const visibleDefs = schema.fields.filter(isVisible);
  const visibleKeys = new Set(visibleDefs.map((d) => d.key));

  // Effective values for the non-blocking plausibility warnings.
  const effectiveData: Record<string, unknown> = {};
  for (const def of schema.fields) {
    const converted = valueFromDraft(def, drafts[def.key] ?? { text: "", rows: [], checked: [] });
    effectiveData[def.key] = converted.ok ? converted.value : aiData[def.key];
  }
  const plausibility = crossFieldWarnings(schemaType, effectiveData, { documentTaxYear });

  function setDraft(key: string, next: FieldDraft) {
    setDrafts((prev) => ({ ...prev, [key]: next }));
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _removed, ...rest } = prev;
      void _removed;
      return rest;
    });
    setMessage(null);
  }

  function collect(): Record<string, unknown> | null {
    const built = buildCorrectionFields(schemaType, drafts, aiData, visibleKeys);
    if (Object.keys(built.errors).length > 0) {
      setFieldErrors(built.errors);
      setError("Some values could not be read. Fix the highlighted fields and try again.");
      return null;
    }
    setFieldErrors({});
    return built.fields;
  }

  function submit(kind: "save" | "confirm") {
    setError(null);
    setMessage(null);
    const fields = collect();
    if (!fields) return;
    startTransition(async () => {
      try {
        const input = { documentId, expectedExtractedAt: extractedAtIso, fields };
        const res =
          kind === "confirm" ? await confirmDocumentExtraction(input) : await saveDocumentCorrections(input);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setMessage(
          kind === "confirm"
            ? "Marked verified. This records that you checked the values against the document."
            : "Corrections saved. The document is not verified until you confirm it."
        );
        router.refresh();
      } catch {
        setError("Something went wrong while saving. Nothing was changed; try again.");
      }
    });
  }

  function handleUnverify() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await unverifyDocumentExtraction(documentId);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setMessage("Verification removed. Your corrections are kept.");
        router.refresh();
      } catch {
        setError("Something went wrong. Nothing was changed; try again.");
      }
    });
  }

  async function handleReextract() {
    const text = REEXTRACT_CONFIRM + (verified ? REEXTRACT_VERIFIED_NOTE : "");
    if (!window.confirm(text)) return;
    setError(null);
    setMessage(null);
    setBusy("reextract");
    try {
      const res = await runDocumentExtraction(documentId, { force: true, discardVerification: verified });
      if (!res.ok) setError(res.error);
      else setMessage("Re-extracted. Review the values again.");
      router.refresh();
    } catch {
      setError("The request failed before extraction finished. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  const groupedDefs = schema.groups
    .map((group) => ({ group, defs: visibleDefs.filter((d) => d.group === group.id) }))
    .filter((g) => g.defs.length > 0);

  const working = isPending || busy !== null;

  return (
    <div
      ref={splitRef}
      className="flex flex-col gap-6 lg:flex-row lg:gap-0"
      style={{ "--split": `${splitPercent}%` } as CSSProperties}
    >
      {/* Document viewer: its width follows the draggable divider on wide screens */}
      <div className="min-w-0 space-y-2 lg:sticky lg:top-4 lg:w-[var(--split)] lg:shrink-0 lg:self-start">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Document</h2>
          <div className="flex items-center gap-3">
            {fileUrl && isImage && (
              <span className="flex items-center gap-1 text-xs" aria-label="Zoom">
                <button type="button" className={smallButton} onClick={() => setImageZoom((z) => stepImageZoom(z, -1))} disabled={imageZoom <= IMAGE_ZOOM_MIN} aria-label="Zoom out">
                  −
                </button>
                <button type="button" className={smallButton} onClick={() => setImageZoom(IMAGE_ZOOM_MIN)} title="Fit the document to the pane width">
                  {imageZoom}%
                </button>
                <button type="button" className={smallButton} onClick={() => setImageZoom((z) => stepImageZoom(z, 1))} disabled={imageZoom >= IMAGE_ZOOM_MAX} aria-label="Zoom in">
                  +
                </button>
              </span>
            )}
            {fileUrl && (
              <a href={fileUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">
                Open in new tab
              </a>
            )}
          </div>
        </div>
        {fileUrl ? (
          isImage ? (
            // The pane scrolls in both directions, so a zoomed-in scan can always
            // be panned to its right-hand side.
            <div className="h-[calc(100vh-9rem)] min-h-[24rem] overflow-auto rounded-md border bg-muted/20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={fileUrl} alt="Source document" style={{ width: `${imageZoom}%`, maxWidth: "none" }} className="block h-auto" />
            </div>
          ) : (
            <iframe
              title="Source document"
              src={fileUrl.includes("#") ? fileUrl : `${fileUrl}#view=FitH`}
              className="h-[calc(100vh-9rem)] min-h-[24rem] w-full rounded-md border"
            />
          )
        ) : (
          <p className="rounded-md border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
            The document could not be loaded here.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Drag the divider to resize this pane. If the document does not appear above, use Open in new tab and compare the
          values side by side.
        </p>
      </div>

      {/* Draggable divider (side-by-side layout only) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the document pane"
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={onSplitPointerDown}
        onPointerMove={onSplitPointerMove}
        onPointerUp={onSplitPointerUp}
        onPointerCancel={onSplitPointerUp}
        onKeyDown={onSplitKeyDown}
        onDoubleClick={() => setSplit(SPLIT_DEFAULT_PERCENT, true)}
        className="hidden w-3 shrink-0 cursor-col-resize touch-none select-none items-center justify-center lg:flex"
      >
        <div className="h-16 w-1 rounded bg-border" />
      </div>

      {/* Review form */}
      <div className="min-w-0 space-y-4 lg:flex-1 lg:pl-3">
        <div className={`rounded-lg border px-4 py-3 text-sm ${EXTRACTION_TONE_CLASS[display.tone]}`}>
          <p className="font-medium">
            {docTypeLabel}: {display.label}
          </p>
          {verified && verifiedBy && (
            <p className="mt-1 text-xs">
              Marked verified by {verifiedBy}. That means you checked the values against the document, not that they
              are tax-correct.
            </p>
          )}
          {display.outdated && (
            <p className="mt-1 text-xs">
              Read with the older extraction format, so some boxes the forms need may be blank. Re-extract to read
              them.
            </p>
          )}
          {display.reason && <p className="mt-1 text-xs">{display.reason}</p>}
        </div>

        {summary && <p className="text-sm text-muted-foreground">{summary}</p>}

        {[...warnings, ...plausibility].length > 0 && (
          <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {[...warnings, ...plausibility].map((w) => (
              <p key={w}>Check: {w}</p>
            ))}
          </div>
        )}

        {groupedDefs.map(({ group, defs }) => (
          <Card key={group.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{group.label}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {defs.map((def) => {
                const draft = drafts[def.key] ?? { text: "", rows: [], checked: [] };
                const correction = corrections[def.key];
                const aiValue = aiData[def.key];
                const edited = draftDiffers(def, draft, aiValue);
                const staleNote =
                  correction !== undefined && !jsonEqual(correction.aiValue ?? null, aiValue ?? null)
                    ? `The AI now reads ${formatValueForDisplay(def, aiValue)}; your value still applies.`
                    : null;
                const suggestion =
                  def.key === "paidInTaxYearCents" && drafts["installments"]
                    ? suggestPaidInTaxYear(
                        getTaxSchema("property_tax").fields.find((f) => f.key === "installments") as FieldDef,
                        drafts["installments"],
                        Number(drafts["taxYear"]?.text) || documentTaxYear || 0
                      )
                    : null;
                return (
                  <div key={def.key} className="space-y-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <label className="text-sm font-medium">{def.label}</label>
                      <span className="text-xs text-muted-foreground">{def.formRef}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {def.aiFills ? `AI read: ${formatValueForDisplay(def, aiValue)}` : "Not read by the AI. You enter this."}
                      {edited && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">changed</span>}
                    </p>
                    <FieldInput
                      def={def}
                      draft={draft}
                      disabled={working}
                      onChange={(next) => setDraft(def.key, next)}
                    />
                    {def.kind === "money" && (
                      <p className="text-xs text-muted-foreground">Enter dollars. Leave empty if blank on the form.</p>
                    )}
                    {suggestion && (
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline"
                        onClick={() => setDraft(def.key, { ...draft, text: suggestion.dollars })}
                      >
                        Sum installments due in {Number(drafts["taxYear"]?.text) || documentTaxYear}: ${suggestion.dollars}{" "}
                        (assumes each was paid when due - confirm, then Save)
                      </button>
                    )}
                    {staleNote && <p className="text-xs text-amber-700">{staleNote}</p>}
                    {fieldErrors[def.key] && (
                      <p role="alert" className="text-xs text-destructive">
                        {fieldErrors[def.key]}
                      </p>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))}

        <Card>
          <CardContent className="space-y-3 pt-6">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => submit("confirm")}
                disabled={working}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {isPending ? "Saving..." : "Confirm - mark verified"}
              </button>
              <button type="button" onClick={() => submit("save")} disabled={working} className={smallButton}>
                Save corrections
              </button>
              {verified && (
                <button type="button" onClick={handleUnverify} disabled={working} className={smallButton}>
                  Un-verify
                </button>
              )}
              <button type="button" onClick={() => void handleReextract()} disabled={working} className={smallButton}>
                {busy === "reextract" ? "Extracting... 20-60s" : "Re-extract"}
              </button>
              <Link href={backHref} prefetch={false} className="text-xs text-muted-foreground hover:underline">
                ← Back to {backLabel}
              </Link>
            </div>
            <p className="text-xs text-muted-foreground">
              Any edit removes the verification until you confirm again. The AI reading is never changed; your values
              are kept separately and win over it.
            </p>
            {message && (
              <p role="status" className="text-sm text-green-700">
                {message}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── Inputs ────────────────────────────────────────────────────────────────────

function ScalarInput({
  spec,
  value,
  disabled,
  onChange,
  ariaLabel,
}: {
  spec: ScalarFieldSpec;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
  ariaLabel: string;
}) {
  if (spec.kind === "bool") {
    return (
      <select
        aria-label={ariaLabel}
        className={inputClass}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">(blank)</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  if (spec.kind === "enum") {
    return (
      <select
        aria-label={ariaLabel}
        className={inputClass}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">(blank)</option>
        {(spec.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {spec.kind === "money" && <span className="text-sm text-muted-foreground">$</span>}
      <input
        aria-label={ariaLabel}
        type="text"
        inputMode={spec.kind === "money" || spec.kind === "decimal" || spec.kind === "pct" ? "decimal" : undefined}
        className={inputClass}
        value={value}
        disabled={disabled}
        placeholder={spec.kind === "date" ? "YYYY-MM-DD" : spec.kind === "ein" ? "NN-NNNNNNN" : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function FieldInput({
  def,
  draft,
  disabled,
  onChange,
}: {
  def: FieldDef;
  draft: FieldDraft;
  disabled: boolean;
  onChange: (next: FieldDraft) => void;
}) {
  if (def.kind === "enumList") {
    return (
      <div className="flex flex-wrap gap-3">
        {(def.options ?? []).map((option) => {
          const checked = draft.checked.includes(option);
          return (
            <label key={option} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() =>
                  onChange({
                    ...draft,
                    checked: checked ? draft.checked.filter((c) => c !== option) : [...draft.checked, option],
                  })
                }
              />
              {option}
            </label>
          );
        })}
      </div>
    );
  }

  if (def.kind === "list") {
    const items = def.itemFields ?? [];
    const max = def.maxItems ?? 4;
    return (
      <div className="space-y-2">
        {draft.rows.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-muted-foreground">
                  {items.map((item) => (
                    <th key={item.key} className="px-2 py-1 font-medium">
                      {item.label}
                    </th>
                  ))}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {draft.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {items.map((item) => (
                      <td key={item.key} className="px-1 py-1">
                        <ScalarInput
                          spec={item}
                          value={row[item.key] ?? ""}
                          disabled={disabled}
                          ariaLabel={`${def.label} row ${rowIndex + 1} ${item.label}`}
                          onChange={(next) =>
                            onChange({
                              ...draft,
                              rows: draft.rows.map((r, i) => (i === rowIndex ? { ...r, [item.key]: next } : r)),
                            })
                          }
                        />
                      </td>
                    ))}
                    <td className="px-1 py-1 text-center">
                      <button
                        type="button"
                        aria-label={`Remove ${def.label} row ${rowIndex + 1}`}
                        disabled={disabled}
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => onChange({ ...draft, rows: draft.rows.filter((_, i) => i !== rowIndex) })}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {draft.rows.length < max && (
          <button
            type="button"
            disabled={disabled}
            className="text-xs text-primary hover:underline disabled:opacity-50"
            onClick={() => onChange({ ...draft, rows: [...draft.rows, emptyRow(def)] })}
          >
            + Add row
          </button>
        )}
      </div>
    );
  }

  return (
    <ScalarInput
      spec={def as ScalarFieldSpec}
      value={draft.text}
      disabled={disabled}
      ariaLabel={def.label}
      onChange={(next) => onChange({ ...draft, text: next })}
    />
  );
}
