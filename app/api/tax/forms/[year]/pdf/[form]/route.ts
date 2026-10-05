import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { defaultPdfRouteDeps } from "@/lib/tax2025-pdf-build";
import { handleFormRequest } from "@/lib/tax2025-pdf-route";

// One filled form (DRAFT unless `?final=1` for an approved return; `?view=1` opens it inline in the viewer, which the Final review deep links use; `?stamp=0` and `?final=1` return 403 until the
// owner has approved the current return). Auth-gated: auth() is the first statement;
// the form id is whitelisted against the registered maps and the blank-form manifest.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ year: string; form: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return new NextResponse("Unauthorized", { status: 401 });

  const { year, form } = await params;
  return handleFormRequest(
    {
      year,
      form,
      stamp: new URL(req.url).searchParams.get("stamp"),
      final: new URL(req.url).searchParams.get("final"),
      view: new URL(req.url).searchParams.get("view"),
      user: { id: session.user.id, name: session.user.name ?? "unknown user" },
    },
    defaultPdfRouteDeps,
  );
}
