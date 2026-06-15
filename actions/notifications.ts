"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";

function requireAuth() {
  return auth().then((session) => {
    if (!session?.user?.id) throw new Error("Unauthorized");
    return session.user as { id: string; name?: string | null; email?: string | null };
  });
}

// ── Notification queries ──────────────────────────────────────────────────────

export async function getNotifications() {
  const user = await requireAuth();
  return db.notificationUser.findMany({
    where: { userId: user.id },
    include: { notification: true },
    orderBy: { notification: { createdAt: "desc" } },
    take: 50,
  });
}

export async function getUnreadCount(): Promise<number> {
  const user = await requireAuth();
  return db.notificationUser.count({
    where: { userId: user.id, readAt: null },
  });
}

export async function markRead(notificationUserId: string): Promise<void> {
  const user = await requireAuth();
  await db.notificationUser.updateMany({
    where: { id: notificationUserId, userId: user.id },
    data: { readAt: new Date() },
  });
  revalidatePath("/notifications");
}

export async function markAllRead(): Promise<void> {
  const user = await requireAuth();
  await db.notificationUser.updateMany({
    where: { userId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath("/notifications");
}

// ── Notification preferences ──────────────────────────────────────────────────

const prefsSchema = z.object({
  overspend: z.object({ enabled: z.boolean(), threshold: z.number().int().min(1).max(100) }).optional(),
  low_balance: z.object({ enabled: z.boolean() }).optional(),
  accrual_shortfall: z.object({ enabled: z.boolean() }).optional(),
  bill_due: z.object({ enabled: z.boolean(), daysAhead: z.number().int().min(1).max(14) }).optional(),
  anomaly: z.object({ enabled: z.boolean(), multiplier: z.number().min(1.1) }).optional(),
});

export type NotifPrefs = z.infer<typeof prefsSchema>;

export async function getNotifPrefs(): Promise<NotifPrefs> {
  const user = await requireAuth();
  const record = await db.user.findUnique({ where: { id: user.id }, select: { notificationPrefs: true } });
  const raw = record?.notificationPrefs ?? {};
  return prefsSchema.parse(raw);
}

export async function updateNotifPrefs(prefs: NotifPrefs): Promise<void> {
  const user = await requireAuth();
  const parsed = prefsSchema.parse(prefs);
  await db.user.update({ where: { id: user.id }, data: { notificationPrefs: parsed } });
}

// ── Push subscription management ──────────────────────────────────────────────

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
});

export async function subscribePush(sub: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
  const user = await requireAuth();
  const parsed = subscribeSchema.parse(sub);
  await db.pushSubscription.upsert({
    where: { endpoint: parsed.endpoint },
    update: { p256dh: parsed.p256dh, auth: parsed.auth },
    create: { userId: user.id, ...parsed },
  });
}

export async function unsubscribePush(): Promise<void> {
  const user = await requireAuth();
  await db.pushSubscription.deleteMany({ where: { userId: user.id } });
}

export async function hasPushSubscription(): Promise<boolean> {
  const user = await requireAuth();
  const count = await db.pushSubscription.count({ where: { userId: user.id } });
  return count > 0;
}
