import type { FormFieldStatus } from "@/lib/tax-forms";
import { MissingFieldActions } from "@/components/tax/forms/missing-field-actions";

// The dot field list (originally the body of section 5 in personal-tax-client.tsx),
// lifted into a shared presentational component.
//   green = verified document, or a non-document source (answers / books / mileage)
//   blue  = from an UNVERIFIED AI extraction (labelled in text)
//   amber = missing: it still needs input

function dotClass(f: FormFieldStatus): string {
  if (!f.haveData) return "bg-amber-500";
  if (f.basis === "unverified") return "bg-blue-500";
  return "bg-green-600";
}

export function FormFieldList({ fields, taxYear }: { fields: FormFieldStatus[]; taxYear: number }) {
  return (
    <div className="space-y-1.5">
      {fields.map((f, i) => (
        <div key={i} className="flex items-start gap-2 text-xs">
          <span className={`mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(f)}`} />
          <div>
            <span className="font-medium">{f.line}:</span>{" "}
            <span className="text-muted-foreground">{f.source}</span>
            {!f.haveData && f.fixes && f.fixes.length > 0 && <MissingFieldActions fixes={f.fixes} taxYear={taxYear} />}
            {f.basis === "verified" && <span className="ml-1 text-green-700">(verified document)</span>}
            {f.basis === "unverified" && (
              <span className="ml-1 text-blue-700">(unverified AI extraction - review it)</span>
            )}
            {f.basis === "not_document_based" && (
              <span className="ml-1 text-muted-foreground/80">(from your answers or the books)</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
