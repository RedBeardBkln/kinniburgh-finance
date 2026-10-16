import Link from "next/link";
import type { Route } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { INVOICING_NOT_SET_UP } from "@/lib/invoicing/constants";

export function NotMigratedNotice() {
  return (
    <Card>
      <CardContent className="py-6 text-sm text-muted-foreground">{INVOICING_NOT_SET_UP}</CardContent>
    </Card>
  );
}

export function NeedsSetupNotice({ slug }: { slug: string }) {
  return (
    <Card>
      <CardContent className="space-y-2 py-6 text-sm">
        <p>Invoicing is not set up for this business yet.</p>
        <Link className="text-primary underline" href={`/business/${slug}/invoicing/settings` as Route}>
          Go to settings to set it up
        </Link>
      </CardContent>
    </Card>
  );
}

export function SetupIncompleteNotice({ slug, missing }: { slug: string; missing: string[] }) {
  if (missing.length === 0) return null;
  return (
    <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900">
      Invoices cannot be issued yet: {missing.join(" and ")} {missing.length === 1 ? "is" : "are"} not set.{" "}
      <Link className="underline" href={`/business/${slug}/invoicing/settings` as Route}>
        Open settings
      </Link>
    </div>
  );
}
