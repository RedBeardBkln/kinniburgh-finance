"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";


function UploadSection({
  label,
  description,
  accept,
  maxBytes,
  currentSrc,
  apiPath,
  onSuccess,
}: {
  label: string;
  description: string;
  accept: string;
  maxBytes: number;
  currentSrc: string | null;
  apiPath: string;
  onSuccess: () => void;
}) {
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
    if (selected.size > maxBytes) {
      setError(`File too large — max ${Math.round(maxBytes / 1024 / 1024)}MB.`);
      return;
    }
    setFile(selected);
    setPreview(URL.createObjectURL(selected));
  }

  async function handleUpload() {
    if (!file) return;
    setLoading(true);
    setError(null);
    setSuccess(false);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(apiPath, { method: "POST", body: formData });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Upload failed");
      setSuccess(true);
      setFile(null);
      setPreview(null);
      if (inputRef.current) inputRef.current.value = "";
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>

      {currentSrc && !preview && (
        <div className="flex h-16 w-16 items-center justify-center rounded-xl border bg-muted/30 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={currentSrc} alt={label} className="h-full w-full object-contain" />
        </div>
      )}
      {preview && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Preview</p>
          <div className="flex h-16 w-16 items-center justify-center rounded-xl border bg-muted/30 p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="Preview" className="h-full w-full object-contain" />
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleFileChange}
        className="block text-sm text-muted-foreground file:mr-4 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-accent"
      />

      {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      {success && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">Updated successfully.</p>}

      <button
        onClick={handleUpload}
        disabled={!file || loading}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {loading ? "Uploading…" : `Upload ${label.toLowerCase()}`}
      </button>
    </div>
  );
}

export function BrandingClient({ hasLogo, hasFavicon }: { hasLogo: boolean; hasFavicon: boolean }) {
  const router = useRouter();

  return (
    <div className="divide-y space-y-0">
      <div className="pb-6">
        <UploadSection
          label="Logo"
          description="Used in the header and login screen. PNG, JPEG, WebP, or SVG. Max 2MB."
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          maxBytes={2 * 1024 * 1024}
          currentSrc={hasLogo ? "/api/logo" : null}
          apiPath="/api/settings/logo"
          onSuccess={() => router.refresh()}
        />
      </div>
      <div className="pt-6">
        <UploadSection
          label="Favicon"
          description="Browser tab icon. PNG, ICO, SVG, or WebP. Max 1MB. Recommended: square, 32×32 or 64×64."
          accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/svg+xml,image/webp"
          maxBytes={1 * 1024 * 1024}
          currentSrc={hasFavicon ? "/api/favicon" : null}
          apiPath="/api/settings/favicon"
          onSuccess={() => router.refresh()}
        />
      </div>
    </div>
  );
}
