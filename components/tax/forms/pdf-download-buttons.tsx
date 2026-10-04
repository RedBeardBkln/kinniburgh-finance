import Link from "next/link";
import type { Route } from "next";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";

// DRAFT filled-PDF downloads for tax year 2025 (plan sections 6.9 / 6.10). A server
// component of plain links: each is a GET to the auth-gated /api/tax/forms routes, so
// there is no client state, no confirm dialog and nothing to hydrate. Mounted for the
// supported year only (the routes reject other years).

const FORM_LABELS: Readonly<Record<string, string>> = {
  f1040: "Form 1040",
  f1040s1: "Schedule 1",
  f1040s2: "Schedule 2",
  f1040s3: "Schedule 3",
  f1040sa: "Schedule A",
  f1040sb: "Schedule B",
  f1040sc: "Schedule C",
  f1040sd: "Schedule D",
  f8949: "Form 8949",
  f1040sse: "Schedule SE",
  f8959: "Form 8959",
  f8995: "Form 8995",
  ct1040: "CT-1040",
};

export const PDF_SUPPORTED_YEAR = 2025;

const linkClass =
  "inline-flex min-h-11 items-center rounded-md border border-primary/40 px-4 text-sm font-medium text-primary hover:bg-primary/10";

// The line-by-line review sheet the CPA keys the return from (every line with status, provenance and citation).
const reviewSheetClass =
  "inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90";

export function PdfDownloadButtons({ year, overrideCount = 0 }: { year: number; overrideCount?: number }) {
  if (year !== PDF_SUPPORTED_YEAR) return null;
  const base = `/api/tax/forms/${year}/pdf`;
  return (
    <section aria-labelledby="pdf-download-heading" className="space-y-2 rounded-lg border p-4">
      <div>
        <h2 id="pdf-download-heading" className="text-base font-semibold">
          Filled PDF forms - DRAFT for CPA review
        </h2>
        <p className="text-sm text-muted-foreground">
          Computed from your answers, documents and books. Lines the system could not compute are left blank and listed
          on the cover page, and social security numbers, EINs, bank numbers, signatures and PINs are always left blank.
          The CPA is the preparer of record; this is not tax advice and nothing here has been filed.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/tax/forms/${year}/return` as Route} className={reviewSheetClass}>
          CPA review sheet (printable, with CSV)
        </Link>
        <a href={base} download className={linkClass}>
          Download filing packet (zip)
        </a>
        <a href={`${base}?stamp=0`} download className={linkClass}>
          Download clean copy (no DRAFT footer)
        </a>
      </div>
      <p className="text-xs text-muted-foreground">
        The clean copy removes the per-page DRAFT footer from the forms; the cover page is always marked DRAFT.
      </p>
      {overrideCount > 0 ? (
        <p className="text-xs font-medium text-violet-900" data-testid="pdf-overrides-note">
          The packet includes the {overrideCount} override(s) in force and lists them on the cover.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2" aria-label="Individual forms">
        {FORM_MAPS.map((m) => (
          <a
            key={m.formId}
            href={`${base}/${m.formId}`}
            download
            className="inline-flex min-h-11 items-center rounded-full border px-3 text-xs hover:bg-accent"
          >
            {FORM_LABELS[m.formId] ?? m.formId}
          </a>
        ))}
      </div>
    </section>
  );
}
