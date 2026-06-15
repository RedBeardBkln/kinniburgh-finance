import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { triggerExtraction } from "@/actions/documents";

export async function GET(request: NextRequest) {
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
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
