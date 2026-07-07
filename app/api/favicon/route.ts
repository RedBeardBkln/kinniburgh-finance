import { NextResponse } from "next/server";
import { getFaviconMeta } from "@/lib/settings";
import { downloadLogoFile } from "@/lib/supabase-storage";

export async function GET() {
  const meta = await getFaviconMeta();
  if (!meta) return NextResponse.json({ error: "No custom favicon" }, { status: 404 });

  try {
    const buffer = await downloadLogoFile(meta.key);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": meta.mime,
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "Favicon not found" }, { status: 404 });
  }
}
