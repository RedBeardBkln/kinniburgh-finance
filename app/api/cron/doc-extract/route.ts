import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { triggerExtraction } from "@/actions/documents";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("Authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pending = await db.document.findMany({
    where: { extractionStatus: "pending", archivedAt: null },
    orderBy: { createdAt: "asc" },
    take: 10,
    select: { id: true },
  });

  const results = await Promise.allSettled(
    pending.map((doc) => triggerExtraction(doc.id))
  );

  const succeeded = results.filter((r) => r.status === "fulfilled" && r.value !== null).length;
  const failed = results.length - succeeded;

  return NextResponse.json({ processed: results.length, succeeded, failed });
}
