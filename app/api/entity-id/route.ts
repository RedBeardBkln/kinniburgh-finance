import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getEntityBySlug } from "@/lib/entity";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bucket = req.nextUrl.searchParams.get("bucket") ?? "personal";
  const entity = await getEntityBySlug(bucket);

  if (bucket !== "taxes" && !entity) {
    return NextResponse.json({ error: "Entity not found" }, { status: 404 });
  }

  return NextResponse.json({ entityId: entity?.id ?? null });
}
