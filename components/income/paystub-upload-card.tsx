"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  entityId: string | null;
}

export function PaystubUploadCard({ entityId }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().split("T")[0]!;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formEl = e.currentTarget;
    const formData = new FormData(formEl);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Please select a paystub file to upload.");
      return;
    }
    if (!entityId) {
      setError("Personal entity not found.");
      return;
    }
    formData.set("entityId", entityId);

    startTransition(async () => {
      try {
        const resp = await fetch("/api/paystubs/upload", {
          method: "POST",
          body: formData,
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({ error: "Upload failed" }));
          throw new Error((data as { error?: string }).error ?? "Upload failed");
        }
        const { paystubId } = (await resp.json()) as { paystubId: string };
        router.push(`/personal/income/${paystubId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Upload Paystub</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">Paystub file</label>
            <input
              name="file"
              type="file"
              accept="image/*,.pdf"
              required
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium"
            />
            <p className="text-xs text-muted-foreground">JPEG, PNG, WebP, or PDF · max 10MB</p>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Capture date</label>
            <input
              name="capturedAt"
              type="date"
              defaultValue={today}
              required
              className="block rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-md bg-primary px-6 h-10 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isPending ? "Uploading & extracting…" : "Upload Paystub"}
          </button>
        </form>
      </CardContent>
    </Card>
  );
}