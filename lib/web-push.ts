import webpush from "web-push";
import { db } from "./db";

webpush.setVapidDetails(
  process.env.VAPID_EMAIL ?? "mailto:admin@example.com",
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
  process.env.VAPID_PRIVATE_KEY ?? ""
);

export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; url?: string }
): Promise<void> {
  const subs = await db.pushSubscription.findMany({ where: { userId } });
  await Promise.allSettled(
    subs.map((s) =>
      webpush
        .sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload)
        )
        .catch(() => {
          // Stale subscriptions are silently ignored; endpoint cleanup happens on 410
        })
    )
  );
}
