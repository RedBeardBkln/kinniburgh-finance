"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const MAX_BYTES = 2 * 1024 * 1024;

export function BrandingClient({ hasLogo }: { hasLogo: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setError(null);
    setSuccess(false);

    if (!ALLOWED_TYPES.has(selected.type)) {
      setError("Unsupported format. Upload PNG, JPEG, WebP, or SVG.");
      return;
    }
    if (selected.size > MAX_BYTES) {
      setError("File too large — max 2MB.");
      return;
    }

    setFile(selected);
    const url = URL.createObjectURL(selected);
    setPreview(url);
  }

  async function handleUpload() {
    if (!file) return;
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/settings/logo", { method: "POST", body: formData });
      const data = (await res.json()) as { success?: boolean; error?: string };

      if (!res.ok || data.error) throw new Error(data.error ?? "Upload failed");

      setSuccess(true);
      setFile(null);
      setPreview(null);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Current logo */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Current logo</p>
        {hasLogo ? (
          <div className="flex h-20 w-20 items-center justify-center rounded-xl border bg-muted/30 p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/api/logo"
              alt="Current logo"
              className="h-full w-full object-contain"
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No custom logo — using the default banana icon.</p>
        )}
      </div>

      {/* Upload */}
      <div className="space-y-3">
        <p className="text-sm font-medium">Upload new logo</p>
        <p className="text-xs text-muted-foreground">
          PNG, JPEG, WebP, or SVG. Max 2MB. Recommended: square or wide aspect ratio.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          onChange={handleFileChange}
          className="block text-sm text-muted-foreground file:mr-4 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-accent"
        />

        {preview && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Preview</p>
            <div className="flex h-20 w-20 items-center justify-center rounded-xl border bg-muted/30 p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={preview}
                alt="Preview"
                className="h-full w-full object-contain"
              />
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}
        {success && (
          <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">Logo updated successfully.</p>
        )}

        <button
          onClick={handleUpload}
          disabled={!file || loading}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? "Uploading…" : "Upload logo"}
        </button>
      </div>
    </div>
  );
}
