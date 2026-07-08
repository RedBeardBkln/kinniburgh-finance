"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

function parseDate(s: string): Date {
  // Airbnb format: MM/DD/YYYY
  const [m, d, y] = s.trim().split("/");
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

export async function uploadRentalBookings(
  entityId: string,
  csvText: string
): Promise<{ imported: number } | { error: string }> {
  await requireAuth();

  const lines = csvText.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return { error: "CSV has no data rows" };

  const headers = lines[0]!.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
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

  for (const row of rows) {
    // Simple CSV split (no embedded commas in these Airbnb fields)
    const cells = row.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const type = cells[col.type] ?? "";
    if (type !== "Reservation") continue;

    const confirmationCode = cells[col.code] ?? "";
    const grossRaw = cells[col.gross] ?? "0";
    const grossEarnings = parseFloat(grossRaw);
    if (!confirmationCode || isNaN(grossEarnings)) continue;

    const startDate = parseDate(cells[col.start] ?? "");
    const endDate = parseDate(cells[col.end] ?? "");
    const payoutDate = parseDate(cells[col.payout] ?? "");
    const nights = parseInt(cells[col.nights] ?? "0", 10);
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
        grossEarnings: new Prisma.Decimal(grossEarnings),
        currency,
      },
      update: {
        payoutDate,
        startDate,
        endDate,
        nights,
        guest,
        listing,
        grossEarnings: new Prisma.Decimal(grossEarnings),
        currency,
      },
    });
    imported++;
  }

  revalidatePath("/forecast");
  return { imported };
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
}
