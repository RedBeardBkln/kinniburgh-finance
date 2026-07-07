import { NextResponse } from "next/server";
import { getLogoMeta } from "@/lib/settings";
import { downloadLogoFile } from "@/lib/supabase-storage";

export async function GET() {
  const meta = await getLogoMeta();
  if (!meta) return NextResponse.json({ error: "No custom logo" }, { status: 404 });

  try {
    const buffer = await downloadLogoFile(meta.key);
    return new Response(buffer, {
      headers: {
        "Content-Type": meta.mime,
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "Logo not found" }, { status: 404 });
  }
}
