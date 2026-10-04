import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { defaultPdfRouteDeps } from "@/lib/tax2025-pdf-build";
import { handlePacketRequest } from "@/lib/tax2025-pdf-route";

// DRAFT filing packet (zip of cover + filled IRS forms) for CPA review. Auth-gated:
// auth() is the first statement; nothing is built, read or logged before it.
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
      user: { id: session.user.id, name: session.user.name ?? "unknown user" },
    },
    defaultPdfRouteDeps,
  );
}
