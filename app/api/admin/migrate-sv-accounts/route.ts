import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

// One-time migration: move JCSB Operating and The Cottage to Sudden Valley entity.
// Call once after deploy, then delete this file.
export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svEntity = await db.entity.findFirst({
    where: { name: "Sudden Valley Property Management, LLC" },
  });
  if (!svEntity) return NextResponse.json({ error: "Sudden Valley entity not found" }, { status: 404 });

  const [jcsbResult, cottageResult] = await Promise.all([
    db.account.updateMany({
      where: { nickname: "JCSB Operating" },
      data: { entityId: svEntity.id },
    }),
    db.account.updateMany({
      where: { nickname: "The Cottage" },
      data: { entityId: svEntity.id },
    }),
  ]);

  return NextResponse.json({
    svEntityId: svEntity.id,
    jcsbOperatingUpdated: jcsbResult.count,
    cottageUpdated: cottageResult.count,
  });
}
