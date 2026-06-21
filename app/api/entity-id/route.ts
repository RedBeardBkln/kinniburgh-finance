import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { BUCKET_ENTITY_NAMES, type BucketSlug } from "@/components/app-shell";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bucket = (req.nextUrl.searchParams.get("bucket") ?? "personal") as BucketSlug;
  const entityName = BUCKET_ENTITY_NAMES[bucket]; // null = all entities (Taxes tab)
  if (!entityName) return NextResponse.json({ entityId: null });

  const entity = await db.entity.findFirst({ where: { name: entityName } });
  if (!entity) return NextResponse.json({ error: "Entity not found" }, { status: 404 });

  return NextResponse.json({ entityId: entity.id });
}
