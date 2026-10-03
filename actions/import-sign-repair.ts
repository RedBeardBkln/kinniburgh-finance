"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import {
  REPAIRABLE_ACCOUNT_TYPES,
  SINGLE_SIGN_MIN_ROWS,
  isDebitOnlyImportAccount,
  negateAmount,
  planImportSignRepair,
  type SignRepairPlan,
} from "@/lib/import-sign-repair";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user as { id: string };
}

export interface SignRepairPreview {
  accountId: string;
  nickname: string;
  mask: string | null;
  importRowCount: number;
  firstDate: string;
  lastDate: string;
  /** Sum of the import rows as stored now (all positive) and as they will be after the flip. */
  totalBefore: string;
  totalAfter: string;
  /** Rows only flipped (no Plaid twin). */
  flipOnlyCount: number;
  /** Rows flipped AND archived because Plaid already has the same transaction. */
  overlapCount: number;
  /** Matched to Plaid but carry a receipt/note/GL code or a conflicting project — flipped, left active. */
  linkedOverlapCount: number;
  tagCopyCount: number;
  projectCopyCount: number;
  samples: { date: string; importPayee: string; plaidPayee: string; amount: string }[];
}

interface Candidate {
  preview: SignRepairPreview;
  plan: SignRepairPlan;
  /** importId → corrected (negated) amount, for the dedup log. */
  correctedAmount: Map<string, string>;
  /** importId → payeeNormalized + posted date snapshot, for the dedup log. */
  payeeById: Map<string, string | null>;
  postedAtById: Map<string, Date>;
  entityId: string;
}

/** Re-derives every candidate from the DB. Apply never trusts anything from the client but an accountId. */
async function loadCandidate(accountId: string): Promise<Candidate | null> {
  const account = await db.account.findFirst({
    where: { id: accountId, archivedAt: null },
    select: { id: true, nickname: true, mask: true, accountType: true, entityId: true },
  });
  if (!account) return null;

  const importRows = await db.transaction.findMany({
    where: { accountId, source: "import", archivedAt: null },
    select: {
      id: true,
      postedAt: true,
      amount: true,
      payeeRaw: true,
      payeeNormalized: true,
      notes: true,
      receiptId: true,
      projectId: true,
      glCodeId: true,
      scheduledTransferId: true,
      transferPairId: true,
      tags: { select: { tagId: true } },
    },
    orderBy: { postedAt: "asc" },
  });

  if (!isDebitOnlyImportAccount(account.accountType, importRows.map((r) => r.amount.toString()))) {
    return null;
  }

  const first = importRows[0]!.postedAt;
  const last = importRows[importRows.length - 1]!.postedAt;

  const plaidRows = await db.transaction.findMany({
    where: {
      accountId,
      source: "plaid",
      archivedAt: null,
      amount: { lt: 0 },
      postedAt: { gte: first, lte: last },
    },
    select: {
      id: true,
      postedAt: true,
      amount: true,
      payeeRaw: true,
      payeeNormalized: true,
      projectId: true,
      tags: { select: { tagId: true } },
    },
  });

  const plan = planImportSignRepair(
    importRows.map((r) => ({
      id: r.id,
      postedAt: r.postedAt,
      amount: r.amount.toString(),
      tagIds: r.tags.map((t) => t.tagId),
      projectId: r.projectId,
      hasLinks: !!(r.notes || r.receiptId || r.glCodeId || r.scheduledTransferId || r.transferPairId),
    })),
    plaidRows.map((p) => ({
      id: p.id,
      postedAt: p.postedAt,
      amount: p.amount.toString(),
      tagIds: p.tags.map((t) => t.tagId),
      projectId: p.projectId,
    }))
  );

  const byId = new Map(importRows.map((r) => [r.id, r]));
  const plaidById = new Map(plaidRows.map((p) => [p.id, p]));

  const totalBefore = importRows.reduce((s, r) => s.plus(r.amount), new Prisma.Decimal(0));

  const samples = plan.overlap.slice(0, 8).map((o) => {
    const i = byId.get(o.importId)!;
    const p = plaidById.get(o.keptId)!;
    return {
      date: i.postedAt.toISOString().slice(0, 10),
      importPayee: (i.payeeRaw ?? "").replace(/\s+/g, " ").slice(0, 60),
      plaidPayee: p.payeeRaw ?? p.payeeNormalized ?? "",
      amount: negateAmount(i.amount.toString()),
    };
  });

  return {
    entityId: account.entityId,
    plan,
    correctedAmount: new Map(importRows.map((r) => [r.id, negateAmount(r.amount.toString())])),
    payeeById: new Map(importRows.map((r) => [r.id, r.payeeNormalized])),
    postedAtById: new Map(importRows.map((r) => [r.id, r.postedAt])),
    preview: {
      accountId,
      nickname: account.nickname,
      mask: account.mask,
      importRowCount: importRows.length,
      firstDate: first.toISOString().slice(0, 10),
      lastDate: last.toISOString().slice(0, 10),
      totalBefore: totalBefore.toFixed(2),
      totalAfter: totalBefore.negated().toFixed(2),
      flipOnlyCount: plan.negateIds.length - plan.overlap.length,
      overlapCount: plan.overlap.length,
      linkedOverlapCount: plan.linkedOverlapIds.length,
      tagCopyCount: plan.overlap.reduce((n, o) => n + o.tagIdsToCopy.length, 0),
      projectCopyCount: plan.overlap.filter((o) => o.projectIdToCopy !== null).length,
      samples,
    },
  };
}

/** Lists checking/savings accounts whose imported rows are all positive, with a dry-run of the repair. */
export async function previewImportSignRepair(): Promise<SignRepairPreview[]> {
  await requireAuth();

  // One cheap grouped query finds candidates; only those get the full load.
  const groups = await db.transaction.groupBy({
    by: ["accountId"],
    where: {
      source: "import",
      archivedAt: null,
      account: { archivedAt: null, accountType: { in: [...REPAIRABLE_ACCOUNT_TYPES] } },
    },
    _count: { _all: true },
    _min: { amount: true },
  });

  const accountIds = groups
    .filter((g) => g._count._all >= SINGLE_SIGN_MIN_ROWS && g._min.amount && g._min.amount.gt(0))
    .map((g) => g.accountId);

  const previews: SignRepairPreview[] = [];
  for (const id of accountIds) {
    const c = await loadCandidate(id);
    if (c) previews.push(c.preview);
  }
  return previews;
}

export async function applyImportSignRepair(
  accountId: string
): Promise<
  | { success: true; flipped: number; archived: number; tagsCopied: number; remainingPositive: number }
  | { error: string }
> {
  const user = await requireAuth();

  const candidate = await loadCandidate(accountId);
  if (!candidate) {
    return { error: "This account no longer needs repair (or isn't eligible). Refresh to see the current state." };
  }
  const { plan, correctedAmount, payeeById, postedAtById, entityId } = candidate;
  if (plan.negateIds.length === 0) return { error: "Nothing to repair." };

  const now = new Date();
  const archiveIds = plan.overlap.map((o) => o.importId);
  const tagCopies = plan.overlap.flatMap((o) =>
    o.tagIdsToCopy.map((tagId) => ({ transactionId: o.keptId, tagId }))
  );

  // Carry project assignments onto the surviving Plaid rows, one updateMany per project.
  const projectCopies = new Map<string, string[]>();
  for (const o of plan.overlap) {
    if (!o.projectIdToCopy) continue;
    const list = projectCopies.get(o.projectIdToCopy);
    if (list) list.push(o.keptId);
    else projectCopies.set(o.projectIdToCopy, [o.keptId]);
  }

  // One atomic batch: everything lands or nothing does.
  const [flipped] = await db.$transaction([
    // Guarded multiply: only still-positive import rows on this account are touched, so a re-run is a no-op.
    db.transaction.updateMany({
      where: { id: { in: plan.negateIds }, accountId, source: "import", amount: { gt: 0 } },
      data: { amount: { multiply: -1 } },
    }),
    db.transactionTag.createMany({ data: tagCopies, skipDuplicates: true }),
    ...[...projectCopies.entries()].map(([projectId, ids]) =>
      db.transaction.updateMany({ where: { id: { in: ids }, projectId: null }, data: { projectId } })
    ),
    db.transaction.updateMany({
      where: { id: { in: archiveIds }, accountId, archivedAt: null },
      data: { archivedAt: now },
    }),
    // Same reversible log the duplicate detector uses — undo from Settings → Duplicate Log.
    db.dedupAction.createMany({
      data: plan.overlap.map((o) => ({
        duplicateTxId: o.importId,
        keptTxId: o.keptId,
        accountId,
        entityId,
        postedAt: postedAtById.get(o.importId)!,
        amount: correctedAmount.get(o.importId)!,
        payeeNormalized: payeeById.get(o.importId) ?? null,
        reason: "import_overlap",
        detectedBy: "manual",
      })),
      skipDuplicates: true,
    }),
    db.auditLog.createMany({
      data: plan.negateIds.map((id) => ({
        transactionId: id,
        changedBy: user.id,
        changeType: "amount_sign_correction",
        before: { amount: negateAmount(correctedAmount.get(id)!), reason: "debit-only CSV import stored outflows as positive" },
        after: { amount: correctedAmount.get(id)! },
      })),
    }),
  ]);

  const remainingPositive = await db.transaction.count({
    where: { accountId, source: "import", archivedAt: null, amount: { gt: 0 } },
  });

  revalidatePath("/transactions");
  revalidatePath("/");
  revalidatePath("/settings/duplicate-log");
  revalidatePath("/settings/import-sign-repair");

  return {
    success: true,
    flipped: flipped.count,
    archived: archiveIds.length,
    tagsCopied: tagCopies.length,
    remainingPositive,
  };
}
