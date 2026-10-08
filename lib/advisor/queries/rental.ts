// Rental booking reads for the assistant. DB-aware, explicit select only: payout / stay dates, nights, gross earnings and currency. The guest
// name, listing title and confirmation code are never selected.

import { db } from "@/lib/db";

export interface RentalRow {
  payoutDate: Date;
  startDate: Date;
  endDate: Date;
  nights: number;
  grossEarnings: { toString(): string };
  currency: string;
  entity: { name: string };
}

/** Rows scanned for the totals (the tool returns far fewer rows). */
export const RENTAL_SCAN_CAP = 2_000;

export async function loadRentalBookings(opts: { entity?: string; from: Date; to: Date }): Promise<RentalRow[]> {
  return db.rentalBooking.findMany({
    where: {
      payoutDate: { gte: opts.from, lte: opts.to },
      ...(opts.entity !== undefined
        ? { entity: { OR: [{ name: { equals: opts.entity, mode: "insensitive" as const } }, { slug: { equals: opts.entity, mode: "insensitive" as const } }] } }
        : {}),
    },
    orderBy: [{ payoutDate: "asc" }, { id: "asc" }],
    take: RENTAL_SCAN_CAP,
    select: {
      payoutDate: true,
      startDate: true,
      endDate: true,
      nights: true,
      grossEarnings: true,
      currency: true,
      entity: { select: { name: true } },
    },
  });
}
