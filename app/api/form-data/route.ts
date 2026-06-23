import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEntityBySlug } from "@/lib/entity";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const bucket = searchParams.get("bucket") ?? "personal";

  const [entity, accounts, tags, entities] = await Promise.all([
    getEntityBySlug(bucket),
    db.account.findMany({
      where: { archivedAt: null },
      include: { entity: true },
      orderBy: [{ entity: { name: "asc" } }, { nickname: "asc" }],
    }),
    db.tag.findMany({ orderBy: { name: "asc" } }),
    db.entity.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" } }),
  ]);

  const entityAccounts = entity
    ? accounts.filter((a) => a.entityId === entity.id)
    : accounts;

  return NextResponse.json({
    entity,
    accounts: entityAccounts.map((a) => ({
      id: a.id,
      nickname: a.nickname,
      mask: a.mask,
      entityId: a.entityId,
    })),
    allAccounts: accounts.map((a) => ({
      id: a.id,
      nickname: a.nickname,
      mask: a.mask,
      entityId: a.entityId,
    })),
    tags: tags.map((t) => ({
      id: t.id,
      name: t.name,
      shortName: t.shortName,
      parentId: t.parentId,
    })),
    entities: entities.map((e) => ({ id: e.id, name: e.name })),
  });
}
