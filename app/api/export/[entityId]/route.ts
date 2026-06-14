import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ entityId: string }> }
) {
  const session = await auth();
  if (!session?.user) return new NextResponse("Unauthorized", { status: 401 });

  const { entityId } = await params;
  const url = new URL(_req.url);
  const yearParam = url.searchParams.get("year");
  const year = yearParam ? Number(yearParam) : null;

  const entity = await db.entity.findUnique({ where: { id: entityId } });
  if (!entity) return new NextResponse("Entity not found", { status: 404 });

  const fromDate = year ? new Date(`${year}-01-01T00:00:00Z`) : undefined;
  const toDate = year ? new Date(`${year}-12-31T23:59:59Z`) : undefined;

  const transactions = await db.transaction.findMany({
    where: {
      entityId,
      archivedAt: null,
      ...(fromDate && toDate && { postedAt: { gte: fromDate, lte: toDate } }),
    },
    include: {
      account: true,
      glCode: true,
      tags: { include: { tag: true } },
    },
    orderBy: { postedAt: "asc" },
  });

  const entitySlug = entity.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const filename = year ? `${entitySlug}-${year}.csv` : `${entitySlug}.csv`;

  const header = "date,payee,account,amount,gl_code,gl_name,tags,description\n";
  const rows = transactions.map((tx) => {
    const date = tx.postedAt.toISOString().split("T")[0];
    const payee = csvEscape(tx.payeeRaw ?? tx.payeeNormalized ?? "");
    const account = csvEscape(tx.account.nickname);
    const amount = tx.amount.toFixed(2);
    const glCode = tx.glCode?.code ?? "";
    const glName = csvEscape(tx.glCode?.name ?? "");
    const tags = csvEscape(tx.tags.map((t) => t.tag.shortName).join("; "));
    const description = csvEscape(tx.description ?? "");
    return `${date},${payee},${account},${amount},${glCode},${glName},${tags},${description}`;
  });

  const csv = header + rows.join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}
