import { NextRequest, NextResponse } from "next/server";
import { runReviewReminders } from "@/lib/review-reminder-runner";

// Once-daily on Vercel Hobby (see vercel.json). The reminder for a batch fires on
// the first daily run that is >= 24h after its text, so 24-48h after it.
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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
