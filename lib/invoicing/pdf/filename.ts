// Header-safe file name of an invoice PDF. PURE.

export function safeFilename(displayNumber: string | null): string {
  const base = (displayNumber ?? "draft").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "invoice";
  return `${base}.pdf`;
}
