// Pure filter / paging helpers for search_transactions (no DB). The where clause always excludes archived rows; transfers are excluded unless asked for.

import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { isoDate, optional, shortText } from "@/lib/advisor/tools/parse";

export const searchSchema = z
  .object({
    from: optional(isoDate),
    to: optional(isoDate),
    payee: optional(shortText),
    tag: optional(shortText),
    entity: optional(shortText),
    account: optional(shortText),
    min_amount: optional(z.number().min(0).max(100_000_000)),
    max_amount: optional(z.number().min(0).max(100_000_000)),
    direction: optional(z.enum(["outflow", "inflow", "any"])),
    uncategorized: optional(z.boolean()),
    include_transfers: optional(z.boolean()),
    limit: optional(z.number().int().min(1).max(50)),
    page: optional(z.string().max(200).regex(/^[A-Za-z0-9_-]+$/)),
  })
  .strict();
export type SearchInput = z.output<typeof searchSchema>;

export interface PageKey {
  postedAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque keyset page token (NOT a Plaid cursor): base64url of "<ISO timestamp>|<transaction id>". */
export function encodePage(key: PageKey): string {
  return Buffer.from(`${key.postedAt.toISOString()}|${key.id}`, "utf8").toString("base64url");
}

export function decodePage(token: string): PageKey | null {
  let text: string;
  try {
    text = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [iso, id, ...rest] = text.split("|");
  if (rest.length > 0 || iso === undefined || id === undefined || !UUID.test(id)) return null;
  const postedAt = new Date(iso);
  if (Number.isNaN(postedAt.getTime()) || postedAt.toISOString() !== iso) return null;
  return { postedAt, id };
}

export function nextDay(isoDay: string): Date {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** Where clause for the whole match set (`after` = the keyset position for a later page, null for totals and the first page). */
export function buildTransactionWhere(i: SearchInput, after: PageKey | null): Prisma.TransactionWhereInput {
  const and: Prisma.TransactionWhereInput[] = [{ archivedAt: null }];
  if (i.include_transfers !== true) and.push({ transferPairId: null });
  if (i.from !== undefined) and.push({ postedAt: { gte: new Date(`${i.from}T00:00:00Z`) } });
  if (i.to !== undefined) and.push({ postedAt: { lt: nextDay(i.to) } });
  if (i.payee !== undefined) {
    and.push({ OR: [{ payeeRaw: { contains: i.payee, mode: "insensitive" } }, { payeeNormalized: { contains: i.payee, mode: "insensitive" } }] });
  }
  if (i.tag !== undefined) and.push({ tags: { some: { tag: { name: { contains: i.tag, mode: "insensitive" } } } } });
  if (i.entity !== undefined) {
    and.push({ entity: { OR: [{ name: { equals: i.entity, mode: "insensitive" } }, { slug: { equals: i.entity, mode: "insensitive" } }] } });
  }
  if (i.account !== undefined) and.push({ account: { nickname: { contains: i.account, mode: "insensitive" } } });
  if (i.uncategorized === true) and.push({ tags: { none: {} } });

  // Amount bounds are magnitudes in dollars; direction decides which side of zero they apply to.
  const min = i.min_amount;
  const max = i.max_amount;
  const direction = i.direction ?? "any";
  const outflow: Prisma.TransactionWhereInput = { amount: { ...(max !== undefined ? { gte: -max } : { lt: 0 }), ...(min !== undefined ? { lte: -min } : {}) } };
  const inflow: Prisma.TransactionWhereInput = { amount: { ...(min !== undefined ? { gte: min } : { gt: 0 }), ...(max !== undefined ? { lte: max } : {}) } };
  if (direction === "outflow") and.push(outflow);
  else if (direction === "inflow") and.push(inflow);
  else if (min !== undefined || max !== undefined) and.push({ OR: [outflow, inflow] });

  if (after !== null) and.push({ OR: [{ postedAt: { lt: after.postedAt } }, { postedAt: after.postedAt, id: { lt: after.id } }] });
  return { AND: and };
}
