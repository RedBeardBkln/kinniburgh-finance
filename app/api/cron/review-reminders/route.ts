import { NextRequest, NextResponse } from "next/server";
import { runReviewReminders } from "@/lib/review-reminder-runner";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

// Once-daily on Vercel Hobby (see vercel.json). The reminder for a batch fires on
// the first daily run that is >= 24h after its text, so 24-48h after it.
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("Authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runReviewReminders();
    return NextResponse.json(summary);
  } catch {
    // Static tag only: never log request data, tokens, addresses or links.
    console.error("[cron/review-reminders] run failed");
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
