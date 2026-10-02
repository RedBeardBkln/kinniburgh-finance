import Link from "next/link";
import type { Route } from "next";
import type { EntityFormsSection } from "@/lib/tax-forms";
import { FormCard } from "@/components/tax/forms/form-card";

// One business entity's block on the Forms page, grouped under the household
// return: what (if anything) it files, where its activity is reported, and its
// existing tax-workspace checklist progress.

export function EntityFormsSectionView({ section, taxYear }: { section: EntityFormsSection; taxYear: number }) {
  const progress =
    section.checklist && section.checklist.total > 0
      ? Math.round((section.checklist.completed / section.checklist.total) * 100)
      : 0;

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">{section.entityName}</h3>
          {section.taxStatusNotes && (
            <p className="mt-0.5 text-xs text-muted-foreground">Entity record: {section.taxStatusNotes}</p>
          )}
        </div>
        {!section.activeForYear && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            No filing for {taxYear}
          </span>
        )}
      </div>

      {section.reportedOn.length > 0 && (
        <p className="text-xs">
          <span className="font-medium">Reported on the household return via:</span> {section.reportedOn.join(", ")}
        </p>
      )}

      {section.checklist && section.checklist.total > 0 && (
        <div className="max-w-sm space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Workspace checklist</span>
            <span>
              {section.checklist.completed}/{section.checklist.total}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
          </div>
          {section.workspaceHref && (
            <Link href={section.workspaceHref as Route} className="text-xs text-primary hover:underline">
              Open {taxYear} workspace →
            </Link>
          )}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {section.entries.map((entry) => (
          <FormCard key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}
