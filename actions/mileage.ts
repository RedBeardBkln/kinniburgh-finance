"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

const EntrySchema = z.object({
  entityId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  miles: z.coerce.number().int().positive("Miles must be a positive whole number"),
  purpose: z.string().trim().min(1, "Purpose is required"),
  billable: z.boolean().default(false),
  ratePerMile: z.coerce.number().min(0).max(9.999).default(0.7),
  notes: z.string().trim().optional(),
});

const PatchSchema = EntrySchema.partial().omit({ entityId: true });

export async function listMileageEntries(entityId: string, year?: number) {
  await requireAuth();

  return db.mileageEntry.findMany({
    where: {
      entityId,
      archivedAt: null,
      ...(year
        ? {
            date: {
              gte: new Date(`${year}-01-01T00:00:00Z`),
              lt: new Date(`${year + 1}-01-01T00:00:00Z`),
            },
          }
        : {}),
    },
    orderBy: { date: "desc" },
  });
}

export async function createMileageEntry(
  data: z.infer<typeof EntrySchema>
): Promise<{ success: true; id: string } | { error: string }> {
  await requireAuth();

  const parsed = EntrySchema.safeParse(data);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid data" };
  }

  const { date, ratePerMile, ...rest } = parsed.data;

  const entry = await db.mileageEntry.create({
    data: {
      ...rest,
      date: new Date(`${date}T12:00:00Z`),
      ratePerMile: ratePerMile.toFixed(3),
    },
  });

  revalidatePath(`/business/[slug]/mileage`);
  return { success: true, id: entry.id };
}

export async function updateMileageEntry(
  id: string,
  patch: z.infer<typeof PatchSchema>
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const parsed = PatchSchema.safeParse(patch);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid data" };
  }

  const { date, ratePerMile, ...rest } = parsed.data;

  await db.mileageEntry.update({
    where: { id },
    data: {
      ...rest,
      ...(date ? { date: new Date(`${date}T12:00:00Z`) } : {}),
      ...(ratePerMile != null ? { ratePerMile: ratePerMile.toFixed(3) } : {}),
    },
  });

  revalidatePath(`/business/[slug]/mileage`);
  return { success: true };
}

export async function archiveMileageEntry(id: string): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  await db.mileageEntry.update({
    where: { id },
    data: { archivedAt: new Date() },
  });

  revalidatePath(`/business/[slug]/mileage`);
  return { success: true };
}

export async function exportMileageCsv(entityId: string, year: number): Promise<string> {
  await requireAuth();

  const entries = await db.mileageEntry.findMany({
    where: {
      entityId,
      archivedAt: null,
      date: {
        gte: new Date(`${year}-01-01T00:00:00Z`),
        lt: new Date(`${year + 1}-01-01T00:00:00Z`),
      },
    },
    orderBy: { date: "asc" },
  });

  function escapeCsv(v: unknown): string {
    const s = v == null ? "" : String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  const header = ["Date", "Purpose", "Miles", "Rate/mi", "Deduction", "Billable", "Notes"]
    .map(escapeCsv)
    .join(",");

  const rows = entries.map((e) => {
    const rate = Number(e.ratePerMile);
    const deduction = (e.miles * rate).toFixed(2);
    return [
      e.date.toISOString().slice(0, 10),
      e.purpose,
      e.miles,
      rate.toFixed(3),
      deduction,
      e.billable ? "Yes" : "No",
      e.notes ?? "",
    ]
      .map(escapeCsv)
      .join(",");
  });

  return [header, ...rows].join("\n");
}
