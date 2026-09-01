"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { parseCsvCells, splitCsvLines, parseMoney, parseMdyDate } from "@/lib/csv";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

export async function uploadRentalBookings(
  entityId: string,
  csvText: string
): Promise<{ imported: number; skipped: number } | { error: string }> {
  await requireAuth();

  const lines = splitCsvLines(csvText);
  if (lines.length < 2) return { error: "CSV has no data rows" };

  const headers = parseCsvCells(lines[0]!).map((h) => h.trim());
  const idx = (name: string) => headers.indexOf(name);

  const col = {
    type: idx("Type"),
    code: idx("Confirmation code"),
    start: idx("Start date"),
    end: idx("End date"),
    payout: idx("Date"),
    nights: idx("Nights"),
    guest: idx("Guest"),
    listing: idx("Listing"),
    gross: idx("Gross earnings"),
    currency: idx("Currency"),
  };

  if (col.code === -1 || col.gross === -1 || col.start === -1) {
    return { error: "Unrecognized CSV format — expected Airbnb earnings export headers" };
  }

  const rows = lines.slice(1);
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    // RFC-4180 parse: quoted fields may contain commas ("$1,200.00")
    const cells = parseCsvCells(row).map((c) => c.trim());
    const type = cells[col.type] ?? "";
    if (type !== "Reservation") continue;

    const confirmationCode = cells[col.code] ?? "";
    if (!confirmationCode) {
      skipped++;
      continue;
    }

    const grossEarnings = parseMoney(cells[col.gross] ?? "0");
    if (isNaN(grossEarnings)) {
      skipped++;
      continue;
    }

    const startDate = col.start >= 0 ? parseMdyDate(cells[col.start] ?? "") : null;
    const endDate = col.end >= 0 ? parseMdyDate(cells[col.end] ?? "") : null;
    const payoutDate = col.payout >= 0 ? parseMdyDate(cells[col.payout] ?? "") : null;
    if (!startDate || !endDate || !payoutDate) {
      skipped++;
      continue;
    }

    const nightsRaw = parseInt((cells[col.nights] ?? "0").replace(/[^\d-]/g, ""), 10);
    const nights = isNaN(nightsRaw) ? 0 : nightsRaw;
    const guest = cells[col.guest] ?? "";
    const listing = cells[col.listing] ?? "";
    const currency = cells[col.currency] ?? "USD";

    await db.rentalBooking.upsert({
      where: { entityId_confirmationCode: { entityId, confirmationCode } },
      create: {
        entityId,
        confirmationCode,
        payoutDate,
        startDate,
        endDate,
        nights,
        guest,
        listing,
        grossEarnings: new Prisma.Decimal(grossEarnings.toFixed(2)),
        currency,
      },
      update: {
        payoutDate,
        startDate,
        endDate,
        nights,
        guest,
        listing,
        grossEarnings: new Prisma.Decimal(grossEarnings.toFixed(2)),
        currency,
      },
    });
    imported++;
  }

  revalidatePath("/forecast");
  revalidatePath(`/business/sudden-valley/revenue`);
  return { imported, skipped };
}

export async function listRentalBookings(entityId: string) {
  await requireAuth();
  return db.rentalBooking.findMany({
    where: { entityId },
    orderBy: { startDate: "asc" },
  });
}

export async function clearRentalBookings(entityId: string): Promise<void> {
  await requireAuth();
  await db.rentalBooking.deleteMany({ where: { entityId } });
  revalidatePath("/forecast");
  revalidatePath(`/business/sudden-valley/revenue`);
}