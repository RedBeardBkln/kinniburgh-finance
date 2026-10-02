import type { Metadata } from "next";
import { db } from "@/lib/db";
import { assigneeFirstName } from "@/lib/review-queue";
import { loadQueueItems, resolveReviewAccess } from "@/lib/review-queue-server";
import { QueueClient } from "@/components/review-queue/queue-client";

// Standalone magic-link page: NO AppShell, no nav, no links into the rest of the
// app. Reachable without a session (see middleware PUBLIC_PATHS), so the token is
// validated HERE on every render and again in every action in
// actions/review-queue.ts. This render performs no writes (a link-preview bot's
// GET must not count as "opened"); open-tracking happens from the client.

export const dynamic = "force-dynamic";

// Server actions invoked from this page (saveQueue loops over up to 200 items)
// run under this route's function limit. 60s is the Vercel Hobby ceiling for
// functions without Fluid compute (Hobby with Fluid allows more), so it is valid
// on every Hobby configuration; a longer value could fail the deploy.
export const maxDuration = 60;

export const metadata: Metadata = {
  title: "Transactions to review",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

function InvalidLink() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="max-w-sm space-y-2 text-center">
        <h1 className="text-xl font-semibold">This link is no longer valid</h1>
        <p className="text-base text-muted-foreground">
          It may have expired or already been completed. Ask Eric to send you a new one.
        </p>
      </div>
    </main>
  );
}

export default async function QueuePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const access = await resolveReviewAccess(token);
  if (!access.ok) return <InvalidLink />;

  const [items, tags, batch] = await Promise.all([
    loadQueueItems(access.batchId),
    db.tag.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, shortName: true, parentId: true },
    }),
    db.reviewBatch.findUnique({
      where: { id: access.batchId },
      select: {
        assignee: { select: { name: true } },
        createdBy: { select: { name: true } },
      },
    }),
  ]);

  return (
    <QueueClient
      token={token}
      items={items}
      tags={tags}
      assigneeName={batch ? assigneeFirstName(batch.assignee.name) : ""}
      senderName={batch ? assigneeFirstName(batch.createdBy.name) : "Eric"}
    />
  );
}
