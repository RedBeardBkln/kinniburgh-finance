import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { defaultPdfRouteDeps } from "@/lib/tax2025-pdf-build";
import { handlePacketRequest } from "@/lib/tax2025-pdf-route";

// DRAFT filing packet (zip of cover + filled IRS forms). `?stamp=0` (clean copies) and `?final=1` (the final package)
// are refused with 403 until the owner has approved the current return. Auth-gated: auth() is the first statement;
// nothing is built, read or logged before it.
// pdf-lib / fs / crypto need the Node runtime; the packet takes a few seconds.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ year: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return new NextResponse("Unauthorized", { status: 401 });

  const { year } = await params;
  return handlePacketRequest(
    {
      year,
      stamp: new URL(req.url).searchParams.get("stamp"),
      final: new URL(req.url).searchParams.get("final"),
      user: { id: session.user.id, name: session.user.name ?? "unknown user" },
    },
    defaultPdfRouteDeps,
  );
}
