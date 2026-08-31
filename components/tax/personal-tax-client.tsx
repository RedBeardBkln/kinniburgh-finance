"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  uploadTaxDocument,
  answerTaxQuestion,
  generateTaxReview,
  type TaxReviewResult,
} from "@/actions/tax-planning";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Question {
  id: string;
  key: string;
  category: string;
  question: string;
  options: { value: string; label: string; note: string }[] | null;
  answer: string | null;
  answeredAt: string | null;
}

interface DocumentRow {
  id: string;
  docType: string;
  notes: string | null;
  extractionStatus: string | null;
  createdAt: string;
}

interface Opportunity {
  key: string;
  title: string;
  explanation: string;
  value: string;
  risk: "conservative" | "moderate" | "aggressive";
  caveat: string;
  forms: string[];
  riskLabel: string;
  riskClass: string;
  isExcluded: boolean;
  isActOn: boolean;
}

interface FormField {
  line: string;
  source: string;
  haveData: boolean;
}

interface FormPlan {
  formName: string;
  purpose: string;
  whereToGet: string;
  fields: FormField[];
}

interface Props {
  workspaceId: string;
  entityId: string;
  taxYear: number;
  status: string;
  deadline: string | null;
  questions: Question[];
  documents: DocumentRow[];
  opportunities: Opportunity[];
  formPlan: FormPlan[];
  refundObjective: string;
  unansweredCount: number;
}

const DOC_TYPE_OPTIONS = [
  { value: "w2", label: "W-2 (wage statement)" },
  { value: "1099", label: "1099 (interest/dividend/contractor)" },
  { value: "k1", label: "K-1 (partnership/S-corp)" },
  { value: "mortgage_interest", label: "Form 1098 (mortgage interest)" },
  { value: "property_tax", label: "Property tax bill" },
  { value: "tax_return", label: "Prior-year tax return" },
  { value: "extension", label: "Extension confirmation" },
  { value: "bank_statement", label: "Bank/investment statement" },
  { value: "other", label: "Other document" },
];

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PersonalTaxClient(props: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [questions, setQuestions] = useState(props.questions);
  const [review, setReview] = useState<TaxReviewResult | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setUploadMsg(null);
    setUploadError(null);
    const formEl = e.currentTarget;
    const formData = new FormData(formEl);

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setUploadError("Select a file first.");
      return;
    }

    setUploading(true);
    try {
      const result = await uploadTaxDocument(formData);
      setUploadMsg(
        result.extraction
          ? `Uploaded & parsed. ${result.extraction.summary ?? ""}`
          : "Uploaded. Use the AI Review to analyze it."
      );
      formEl.reset();
      startTransition(() => router.refresh());
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleAnswer(questionId: string, answer: string | null, skippedReason?: string) {
    await answerTaxQuestion({ questionId, answer, skippedReason });
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === questionId
          ? { ...q, answer, answeredAt: answer ? new Date().toISOString() : null }
          : q
      )
    );
    startTransition(() => router.refresh());
  }

  async function handleGenerateReview() {
    setReviewLoading(true);
    setReviewError(null);
    setReview(null);
    try {
      const result = await generateTaxReview(props.workspaceId);
      if ("error" in result) {
        setReviewError(result.error);
      } else {
        setReview(result.review);
      }
    } catch {
      setReviewError("Review failed — try again.");
    } finally {
      setReviewLoading(false);
    }
  }

  const unanswered = questions.filter((q) => q.answer === null);
  const activeOpps = props.opportunities.filter((o) => !o.isExcluded);
  const excludedOpps = props.opportunities.filter((o) => o.isExcluded);

  return (
    <div className="space-y-6">
      {/* Objective banner */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Strategy — maximize the refund, minimize the balance due</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{props.refundObjective}</p>
          {props.unansweredCount > 0 && (
            <p className="mt-2 text-sm font-medium text-amber-600">
              {props.unansweredCount} planning question{props.unansweredCount !== 1 ? "s" : ""} need
              answer{props.unansweredCount !== 1 ? "s" : ""} — answering unlocks sharper guidance.
            </p>
          )}
        </CardContent>
      </Card>

      {/* 1. Document intake */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            1 · Upload {props.taxYear} tax documents
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            W-2s, 1099s, 1098s, property tax bills, prior-year returns. Claude parses the fields;
            originals are stored privately in the platform&apos;s tax vault. Never shared outside this
            system.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleUpload} className="grid gap-3 sm:grid-cols-4 items-end">
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-medium">File (PDF/JPEG/PNG/WebP, max 20MB)</label>
              <input
                name="file"
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                required
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Document type</label>
              <select
                name="docType"
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                required
              >
                {DOC_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <input type="hidden" name="entityId" value={props.entityId} />
            <input type="hidden" name="taxYear" value={props.taxYear} />
            <button
              type="submit"
              disabled={uploading}
              className="rounded-md bg-primary px-4 py-2 h-9 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {uploading ? "Uploading & parsing…" : "Upload & Parse"}
            </button>
          </form>
          {uploadMsg && <p className="text-xs text-green-600">{uploadMsg}</p>}
          {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}

          {props.documents.length > 0 && (
            <div className="overflow-x-auto border-t pt-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 font-medium">Type</th>
                    <th className="py-2 px-3 font-medium">Parsed</th>
                    <th className="py-2 px-3 font-medium">Uploaded</th>
                    <th className="py-2 px-3 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {props.documents.map((d) => (
                    <tr key={d.id} className="border-b last:border-0">
                      <td className="py-2 text-xs">
                        <span className="rounded bg-muted px-1.5 py-0.5 font-medium">
                          {d.docType}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-xs">
                        {d.extractionStatus === "complete" ? (
                          <span className="text-green-600">✓ Extracted</span>
                        ) : d.extractionStatus === "failed" ? (
                          <span className="text-destructive">Failed</span>
                        ) : d.extractionStatus ? (
                          <span className="text-amber-600">{d.extractionStatus}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-xs text-muted-foreground">{fmtDate(d.createdAt)}</td>
                      <td className="py-2 px-3 text-xs text-muted-foreground max-w-xs truncate">
                        {d.notes ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. Planning questions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">2 · Planning questions</CardTitle>
          <p className="text-xs text-muted-foreground">
            Each question explains what it&apos;s asking and what each answer honestly means —
            financially and legally — before you commit.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {unanswered.length === 0 && (
            <p className="text-sm text-green-600">All questions answered. Run the AI review for your personalized guidance.</p>
          )}
          {unanswered.map((q) => {
            const [questionText, context] = q.question.split("\n\n");
            return (
              <div key={q.id} className="rounded-lg border p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium">{questionText}</p>
                  <Badge variant="secondary" className="text-[10px] shrink-0">{q.category}</Badge>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{context}</p>

                {q.options ? (
                  <div className="space-y-2">
                    {q.options.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => handleAnswer(q.id, opt.value)}
                        className="block w-full text-left rounded-md border px-3 py-2 hover:border-primary transition-colors"
                      >
                        <span className="text-sm font-medium">{opt.label}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{opt.note}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const value = (e.currentTarget.elements.namedItem("answer") as HTMLInputElement).value;
                      handleAnswer(q.id, value || null);
                    }}
                  >
                    <input
                      name="answer"
                      placeholder="Type your answer…"
                      className="w-full rounded-md border px-3 py-2 text-sm"
                    />
                    <button
                      type="submit"
                      className="mt-2 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                    >
                      Save answer
                    </button>
                  </form>
                )}
                <button
                  onClick={() => handleAnswer(q.id, "skipped", "Skipped for now")}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Skip for now
                </button>
              </div>
            );
          })}

          {/* Answered questions (compact) */}
          {questions.filter((q) => q.answer !== null).length > 0 && (
            <div className="border-t pt-3 space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Your answers
              </p>
              {questions
                .filter((q) => q.answer !== null)
                .map((q) => (
                  <div key={q.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">
                      {q.question.split("\n\n")[0]}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{String(q.answer)}</span>
                      <button
                        onClick={() => handleAnswer(q.id, null)}
                        className="text-xs text-muted-foreground hover:text-destructive"
                      >
                        change
                      </button>
                    </span>
                  </div>
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. AI review */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">3 · AI tax review</CardTitle>
            <button
              onClick={handleGenerateReview}
              disabled={reviewLoading}
              className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {reviewLoading ? "Analyzing…" : "Generate review"}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Claude reviews your parsed documents + answers against the household&apos;s positions and
            produces refund-maximizing guidance with honest risk labels. Data stays inside this
            platform&apos;s stack.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {reviewError && <p className="text-sm text-destructive">{reviewError}</p>}

          {review && (
            <>
              <p className="text-sm leading-relaxed">{review.summary}</p>

              {review.warnings.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950">
                  {review.warnings.map((w, i) => (
                    <p key={i} className="text-sm text-amber-900 dark:text-amber-200">⚠ {w}</p>
                  ))}
                </div>
              )}

              <div className="space-y-3">
                {review.opportunities.map((op) => (
                  <div key={op.key} className="rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium">{op.title}</p>
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                          op.risk === "conservative"
                            ? "bg-green-50 text-green-700 border-green-200"
                            : op.risk === "moderate"
                            ? "bg-amber-50 text-amber-700 border-amber-200"
                            : "bg-red-50 text-red-700 border-red-200"
                        }`}
                      >
                        {op.risk === "conservative"
                          ? "Well-established"
                          : op.risk === "moderate"
                          ? "Verify requirements"
                          : "CPA review required"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{op.explanation}</p>
                    <p className="mt-1 text-xs"><span className="font-medium">Value:</span> {op.value}</p>
                    {op.caveat && (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                        <span className="font-medium">Honest caveat:</span> {op.caveat}
                      </p>
                    )}
                    {op.forms.length > 0 && (
                      <p className="mt-1 text-[10px] text-muted-foreground">Forms: {op.forms.join(", ")}</p>
                    )}
                  </div>
                ))}
              </div>

              {review.nextSteps.length > 0 && (
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Next steps
                  </p>
                  <ol className="list-decimal list-inside space-y-1">
                    {review.nextSteps.map((s, i) => (
                      <li key={i} className="text-sm">{s}</li>
                    ))}
                  </ol>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* 4. Platform-identified opportunities */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">4 · Deductions &amp; credits the platform identified</CardTitle>
          <p className="text-xs text-muted-foreground">
            Built from the household&apos;s documented positions. Honest risk labels on every item.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {activeOpps.map((op) => (
            <div key={op.key} className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium">{op.title}</p>
                <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${op.riskClass}`}>
                  {op.riskLabel}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{op.explanation}</p>
              <p className="mt-1 text-xs"><span className="font-medium">Value:</span> {op.value}</p>
              {op.caveat && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  <span className="font-medium">Honest caveat:</span> {op.caveat}
                </p>
              )}
              <p className="mt-1 text-[10px] text-muted-foreground">Forms: {op.forms.join(", ")}</p>
            </div>
          ))}
          {excludedOpps.length > 0 && (
            <div className="border-t pt-3 space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Ruled out by your answers
              </p>
              {excludedOpps.map((op) => (
                <p key={op.key} className="text-sm text-muted-foreground line-through">
                  {op.title}
                </p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 5. Form autofill plan */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">5 · Forms &amp; autofill plan</CardTitle>
          <p className="text-xs text-muted-foreground">
            The forms your {props.taxYear} situation requires, where to get them, and what the
            platform will autofill vs. what it still needs from you. Nothing is filed automatically —
            your CPA reviews and signs.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {props.formPlan.map((form) => (
            <div key={form.formName} className="rounded-lg border p-3">
              <p className="text-sm font-medium">{form.formName}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{form.purpose}</p>
              <p className="mt-1 text-xs">
                <span className="font-medium">Where:</span> {form.whereToGet}
              </p>
              <div className="mt-2 space-y-1">
                {form.fields.map((f, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span
                      className={`mt-0.5 inline-block h-1.5 w-1.5 rounded-full shrink-0 ${
                        f.haveData ? "bg-green-600" : "bg-amber-500"
                      }`}
                    />
                    <span>
                      <span className="font-medium">{f.line}:</span>{" "}
                      <span className="text-muted-foreground">{f.source}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Fields the platform can&apos;t yet fill are marked with an amber dot — answer the planning
            questions and upload the matching documents to turn them green. Once every field is
            sourced, the CPA bundle export from the workspace carries the values.
          </p>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        This workspace prepares and organizes — it does not give binding tax advice and does not
        e-file. All positions, especially those marked &quot;CPA review required&quot;, need your
        CPA&apos;s sign-off before filing. Your documents and answers are confidential and stay
        inside this platform.
      </p>
    </div>
  );
}