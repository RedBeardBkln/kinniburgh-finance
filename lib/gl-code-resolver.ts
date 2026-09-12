import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

// ─── Pure resolution logic ─────────────────────────────────────────────────
//
// Owner's conflict rule: if a transaction's tags reach exactly one distinct
// GL code (via the entity's tag→GL-code mapping), auto-assign it. If they
// reach zero (no mapping for any of the tags) or more than one distinct GL
// code (a genuine conflict), never guess — leave the transaction uncoded for
// manual review via the existing "Coding Queue" surface.

export type GlResolution =
  | { status: "resolved"; glCodeId: string }
  | { status: "no_mapping" }
  | { status: "conflict"; glCodeIds: string[] };

export function resolveGlCodeForTags(
  tagIds: string[],
  mappingsForEntity: Map<string, string> // tagId -> glCodeId, one entity's mappings only
): GlResolution {
  const distinct = new Set<string>();
  for (const tagId of new Set(tagIds)) {
    const glCodeId = mappingsForEntity.get(tagId);
    if (glCodeId) distinct.add(glCodeId);
  }

  if (distinct.size === 0) return { status: "no_mapping" };
  if (distinct.size === 1) {
    return { status: "resolved", glCodeId: [...distinct][0]! };
  }
  return { status: "conflict", glCodeIds: [...distinct] };
}

// ─── DB-touching batch wrapper ──────────────────────────────────────────────
//
// Per this repo's established "pure-decision-module" pattern, this wrapper is
// not itself unit-tested — only resolveGlCodeForTags is. Never overwrites a
// transaction that already has a non-null glCodeId (manual assignments, or a
// prior auto-assignment, are never clobbered — see plan Risk 4).

export interface GlAssignmentEntry {
  transactionId: string;
  entityId: string;
  tagIds: string[]; // the transaction's FULL/final tag set after this write
}

export async function autoAssignGlCodes(
  entries: GlAssignmentEntry[],
  userId?: string // omit for cron/unauthenticated contexts — see plan Risk 3
): Promise<{ assigned: number }> {
  if (entries.length === 0) return { assigned: 0 };

  const entityIds = [...new Set(entries.map((e) => e.entityId))];
  const mappingRows = await db.tagGlCodeMapping.findMany({
    where: { entityId: { in: entityIds } },
  });
  const mappingsByEntity = new Map<string, Map<string, string>>();
  for (const row of mappingRows) {
    let m = mappingsByEntity.get(row.entityId);
    if (!m) {
      m = new Map();
      mappingsByEntity.set(row.entityId, m);
    }
    m.set(row.tagId, row.glCodeId);
  }

  const transactionIds = entries.map((e) => e.transactionId);
  const existing = await db.transaction.findMany({
    where: { id: { in: transactionIds } },
    select: { id: true, glCodeId: true },
  });
  const currentGlCodeById = new Map(existing.map((t) => [t.id, t.glCodeId]));

  const ops: Prisma.PrismaPromise<unknown>[] = [];

  for (const entry of entries) {
    if (currentGlCodeById.get(entry.transactionId)) continue; // never clobber

    const mapping = mappingsByEntity.get(entry.entityId) ?? new Map<string, string>();
    const resolution = resolveGlCodeForTags(entry.tagIds, mapping);
    if (resolution.status !== "resolved") continue;

    ops.push(
      db.transaction.update({
        where: { id: entry.transactionId },
        data: { glCodeId: resolution.glCodeId },
      })
    );
    if (userId) {
      ops.push(
        db.auditLog.create({
          data: {
            transactionId: entry.transactionId,
            changedBy: userId,
            changeType: "gl_code_auto_assigned",
            before: {},
            after: { glCodeId: resolution.glCodeId },
          },
        })
      );
    }
  }

  if (ops.length > 0) {
    await db.$transaction(ops);
  }

  // Count distinct transactions assigned (2 ops per assignment when audited).
  const assigned = userId ? ops.length / 2 : ops.length;
  return { assigned };
}
