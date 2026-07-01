import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { listTagsWithCounts } from "@/actions/tags";
import { TagsClient } from "@/components/tags/tags-client";

export default async function TagsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const tags = await listTagsWithCounts();

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Tags</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage the tag hierarchy used to categorize transactions.
          </p>
        </div>
        <TagsClient initialTags={tags} />
      </div>
    </AppShell>
  );
}
