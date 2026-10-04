"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { rereadDocumentWithSalesSummary, type RereadSummaryResult } from "@/actions/documents";

interface Props {
  documentId: string;
  /** The sales summary (Form 1099-B totals) was never read from this document. */
  offer: boolean;
  /** The older read already mentions a Form 1099-B (so sales are known to be on the document). */
  salesKnown: boolean;
  /** The document is verified now: re-reading removes the verification. */
  verified: boolean;
}

const smallButton =
  "rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50";

/**
 * "Re-read this document with the new fields" for a 1099 whose sales summary was never read. The explanation is
 * shown INLINE (never a browser confirm box): what is replaced, what is kept, that the verification is removed,
 * and that the old values are shown beside the new ones afterwards. Rendered outside the keyed review form so the
 * before / after table survives the page refresh that follows a re-read.
 */
export function RereadSalesSummaryPanel({ documentId, offer, salesKnown, verified }: Props) {
  const router = useRouter();
  const [stage, setStage] = useState<"idle" | "explain" | "busy">("idle");
  const [result, setResult] = useState<RereadSummaryResult | null>(null);

  async function run() {
    setStage("busy");
    setResult(null);
    try {
      const res = await rereadDocumentWithSalesSummary({ documentId });
      setResult(res);
    } catch {
      setResult({ ok: false, error: "The request failed before the re-read finished. Nothing was changed; check your connection and try again." });
    } finally {
      setStage("idle");
      router.refresh();
    }
  }

  // Once a re-read has produced a summary the offer is done (the refresh that follows also clears `offer`).
  const showOffer = offer && !(result?.ok && result.summaryRows !== null);
  if (!showOffer && !result) return null;

  return (
    <Card className="border-amber-300 bg-amber-50/50">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Sales summary (stock and fund sales)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {showOffer && stage !== "busy" && (
          <p>
            {salesKnown
              ? "This 1099 includes stock or fund sales (Form 1099-B), but the totals by category have not been read from it yet, so they cannot be used for Schedule D."
              : "The sales summary (Form 1099-B totals by category) has not been read from this document. If the document has no sales you can leave it as it is."}
          </p>
        )}

        {showOffer && stage === "idle" && (
          <button type="button" className={smallButton} onClick={() => setStage("explain")}>
            Re-read this document with the new fields
          </button>
        )}

        {stage === "explain" && (
          <div className="space-y-3 rounded-md border bg-background px-3 py-3" role="group" aria-label="What a re-read does">
            <p className="font-medium">What a re-read does</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>The AI reads the whole document again, including the sales summary (one AI call, about 20 to 60 seconds).</li>
              <li>Every value the AI read before is replaced by the new read. Corrections you typed yourself are kept and still win.</li>
              <li>
                {verified
                  ? "This document is marked verified. The verification will be removed, and you will need to check every value against the document and confirm it again."
                  : "The document is not verified, so nothing is lost; you will still need to check the new values and confirm them."}
              </li>
              <li>
                Before it starts, the values the AI read now are saved for a comparison. Afterwards you will see the old and new values
                side by side (amounts and form types only, nothing that identifies a person or an account), so you can see whether anything
                besides the sales summary changed.
              </li>
              <li>If the re-read fails, the old values stay exactly as they are.</li>
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={smallButton} onClick={() => void run()}>
                Re-read now
              </button>
              <button type="button" className={smallButton} onClick={() => setStage("idle")}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {stage === "busy" && (
          <p role="status" className="text-muted-foreground">
            Reading the document again... this takes 20 to 60 seconds. Please keep this page open.
          </p>
        )}

        {result && !result.ok && (
          <p role="alert" className="text-destructive">
            {result.error}
          </p>
        )}

        {result && result.ok && (
          <div className="space-y-2" role="status">
            <p className="font-medium">
              {result.summaryRows === null
                ? "The re-read finished, but the sales summary could not be read from the document. You can type the rows in yourself in the form below."
                : result.summaryRows === 0
                  ? "The re-read finished and found no sales in the summary."
                  : `The re-read finished: ${result.summaryRows} sales summary row${result.summaryRows === 1 ? "" : "s"} read. Check each one against the document.`}
            </p>
            {result.wasVerified && (
              <p className="text-amber-900">The verification was removed. Check the values below and in the form, then confirm again.</p>
            )}
            <div className="overflow-x-auto rounded-md border bg-background">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/30 text-left text-muted-foreground">
                    <th className="px-2 py-1 font-medium">Value</th>
                    <th className="px-2 py-1 font-medium">Before the re-read</th>
                    <th className="px-2 py-1 font-medium">After the re-read</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {result.comparison.map((row) => (
                    <tr key={row.key} className={row.changed ? "bg-amber-100" : undefined}>
                      <td className="px-2 py-1">{row.label}</td>
                      <td className="px-2 py-1">{row.before}</td>
                      <td className="px-2 py-1">
                        {row.after}
                        {row.changed && <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 text-amber-900">changed</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-muted-foreground">
              {result.comparison.some((r) => r.changed)
                ? "Highlighted rows changed. Compare each one with the document before you confirm."
                : "No other value changed."}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
