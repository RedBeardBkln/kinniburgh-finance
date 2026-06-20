"use client";

import { useTransition, useRef, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BUCKET_ENTITY_NAMES, type BucketSlug } from "@/lib/buckets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uploadAndExtractReceipt } from "@/actions/receipts";

function UploadForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const bucket = (searchParams.get("bucket") ?? "personal") as BucketSlug;
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const today = new Date().toISOString().split("T")[0]!;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formEl = e.currentTarget;
    const formData = new FormData(formEl);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Please select a file to upload.");
      return;
    }
    const entityName = BUCKET_ENTITY_NAMES[bucket];
    formData.set("entityName", entityName);
    startTransition(async () => {
      try {
        const resp = await fetch(`/api/entity-id?bucket=${bucket}`);
        const { entityId } = (await resp.json()) as { entityId: string };
        formData.set("entityId", entityId);
        const { receiptId } = await uploadAndExtractReceipt(formData);
        router.push(`/receipts/${receiptId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1">
        <label className="text-sm font-medium">Receipt file</label>
        <input ref={fileRef} name="file" type="file" accept="image/*,.pdf" capture="environment" required
          className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium" />
        <p className="text-xs text-muted-foreground">JPEG, PNG, WebP, or PDF · max 10MB</p>
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Capture date</label>
        <input name="capturedAt" type="date" defaultValue={today} required
          className="block rounded-md border border-input bg-background px-3 py-2 text-sm" />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Entity</label>
        <input type="text" value={BUCKET_ENTITY_NAMES[bucket]} readOnly
          className="block rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground" />
        <p className="text-xs text-muted-foreground">Switch entity using the tabs at the top of the page.</p>
      </div>
      {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <button type="submit" disabled={isPending}
        className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-6 h-10 text-sm font-medium hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed">
        {isPending ? "Uploading & extracting…" : "Upload Receipt"}
      </button>
    </form>
  );
}

export function UploadClient() {
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-2xl font-semibold">Upload Receipt</h1>
      <Card>
        <CardHeader><CardTitle className="text-base">Select file</CardTitle></CardHeader>
        <CardContent>
          <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
            <UploadForm />
          </Suspense>
        </CardContent>
      </Card>
      <p className="text-xs text-center text-muted-foreground">
        Claude AI will extract vendor, date, amount, and category automatically.
        You&apos;ll review the results before anything is saved.
      </p>
    </div>
  );
}
