import type { FormFieldStatus } from "@/lib/tax-forms";

// The green/amber-dot field list (originally the body of section 5 in
// personal-tax-client.tsx), lifted into a shared presentational component.
// Green = the system already has the data; amber = it still needs input.

export function FormFieldList({ fields }: { fields: FormFieldStatus[] }) {
  return (
    <div className="space-y-1">
      {fields.map((f, i) => (
        <div key={i} className="flex items-start gap-2 text-xs">
          <span
            className={`mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
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
  );
}
