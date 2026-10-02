"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateDocumentAttribution } from "@/actions/documents";
import {
  ISSUER_MAX_LENGTH,
  UNKNOWN_PERSON_LABEL,
  attributionLabel,
  buildAttributionPayload,
  initialEditState,
  needsUnknownPersonOption,
  subjectToSelectValue,
  type PersonRef,
} from "@/lib/document-attribution";

interface Props {
  documentId: string;
  subjectType: string | null;
  subjectUserId: string | null;
  issuerName: string | null;
  /** Read-time suggestion from the document's extraction. Never auto-saved. */
  suggestedIssuer: string | null;
  /** Household members (id + name only). */
  people: PersonRef[];
}

/**
 * Two table cells ("Pertains to" and "Issuer / payer") with an inline edit
 * mode. Shared by /documents and the Tax-tab document table so the behavior
 * cannot drift. Render it directly inside a <tr>.
 */
export function DocumentAttributionCells({
  documentId,
  subjectType,
  subjectUserId,
  issuerName,
  suggestedIssuer,
  people,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  // Form state is (re)derived from the CURRENT saved props every time Edit is
  // opened (beginEdit) or cancelled — never relied on from first render, since
  // props change after "Use"/Save + router.refresh().
  const [subjectValue, setSubjectValue] = useState(() =>
    initialEditState({ subjectType, subjectUserId, issuerName }).subjectValue
  );
  const [issuer, setIssuer] = useState(() => initialEditState({ subjectType, subjectUserId, issuerName }).issuer);
  const [error, setError] = useState<string | null>(null);

  const subjectUser = subjectUserId ? (people.find((p) => p.id === subjectUserId) ?? null) : null;
  const display = attributionLabel({ subjectType, subjectUser }, people);
  const jointLabel = attributionLabel({ subjectType: "joint", subjectUser: null }, people).label;
  // Only offer the suggestion while no issuer has been saved.
  const showSuggestion = !issuerName && !!suggestedIssuer;

  function resetFormFromProps() {
    const initial = initialEditState({ subjectType, subjectUserId, issuerName });
    setSubjectValue(initial.subjectValue);
    setIssuer(initial.issuer);
  }

  function beginEdit() {
    setError(null);
    resetFormFromProps();
    setEditing(true);
  }

  function save(nextSubjectValue: string, nextIssuer: string) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await updateDocumentAttribution(
          buildAttributionPayload(documentId, nextSubjectValue, nextIssuer)
        );
        if ("error" in result) {
          setError(result.error);
          return;
        }
        setEditing(false);
        router.refresh();
      } catch {
        setError("Couldn't save — try again.");
      }
    });
  }

  function cancel() {
    setEditing(false);
    setError(null);
    resetFormFromProps();
  }

  if (editing) {
    return (
      <>
        <td className="px-4 py-2 align-top">
          <select
            value={subjectValue}
            onChange={(e) => setSubjectValue(e.target.value)}
            disabled={isPending}
            aria-label="Pertains to"
            className="max-w-full rounded border bg-background px-2 py-1 text-xs"
          >
            <option value="">Unassigned</option>
            {needsUnknownPersonOption(subjectValue, people) && (
              <option value={subjectValue}>{UNKNOWN_PERSON_LABEL}</option>
            )}
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="joint">{jointLabel}</option>
          </select>
        </td>
        <td className="px-4 py-2 align-top">
          <input
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            maxLength={ISSUER_MAX_LENGTH}
            disabled={isPending}
            aria-label="Issuer / payer"
            placeholder="e.g. Alpine Bio"
            // The min width keeps the input usable in auto-layout tables; inside a
            // user-resizable (fixed-layout) table the input must instead shrink
            // to its column so editing never pushes the table wider.
            className="w-full min-w-[160px] [.resizable-table_&]:min-w-0 rounded border bg-background px-2 py-1 text-xs"
          />
          {!issuer.trim() && suggestedIssuer && (
            <button
              type="button"
              onClick={() => setIssuer(suggestedIssuer)}
              className="mt-1 block text-left text-[11px] text-primary hover:underline"
            >
              Suggested from the document: {suggestedIssuer} (use this)
            </button>
          )}
          <span className="mt-1 inline-flex items-center gap-2">
            <button
              type="button"
              onClick={() => save(subjectValue, issuer)}
              disabled={isPending}
              className="text-xs font-medium text-primary hover:underline disabled:opacity-60"
            >
              {isPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={isPending}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </span>
          {error && <span className="block text-xs text-destructive">{error}</span>}
        </td>
      </>
    );
  }

  return (
    <>
      <td className="px-4 py-2 align-top text-xs">
        {display.assigned ? (
          <span className="inline-block rounded border border-border bg-muted px-2 py-0.5 font-medium">
            {display.label}
          </span>
        ) : (
          <span className="inline-block rounded border border-amber-200 bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
            Unassigned
          </span>
        )}
      </td>
      <td className="px-4 py-2 align-top text-xs">
        {issuerName ? (
          <span>{issuerName}</span>
        ) : showSuggestion ? (
          <span className="text-muted-foreground">
            Suggested: <span className="text-foreground">{suggestedIssuer}</span>{" "}
            <button
              type="button"
              onClick={() =>
                save(subjectToSelectValue(subjectType, subjectUserId), suggestedIssuer ?? "")
              }
              disabled={isPending}
              className="text-primary hover:underline disabled:opacity-60"
            >
              {isPending ? "Saving…" : "Use"}
            </button>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}{" "}
        <button
          type="button"
          onClick={beginEdit}
          className="text-primary hover:underline"
        >
          Edit
        </button>
        {error && <span className="block text-destructive">{error}</span>}
      </td>
    </>
  );
}
