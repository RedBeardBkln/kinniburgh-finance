import webpush from "web-push";
import { db } from "./db";

function initVapid() {
  const email = process.env.VAPID_EMAIL;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (email && pub && priv) {
    webpush.setVapidDetails(email, pub, priv);
  }
}

export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; url?: string }
): Promise<void> {
  initVapid();
  const subs = await db.pushSubscription.findMany({ where: { userId } });
  await Promise.allSettled(
    subs.map((s) =>
      webpush
        .sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload)
        )
        .catch(async (err: unknown) => {
          // A 404/410 from the push service means the subscription is
          // confirmed gone — delete it so it stops being retried forever.
          // Any other error (network blip, 5xx, etc.) is left alone since
          // it isn't confirmed-gone.
          if (err instanceof webpush.WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
            await db.pushSubscription.delete({ where: { endpoint: s.endpoint } }).catch(() => {
              // Already deleted by a concurrent call (e.g. dispatchPending's
              // safety-net sweep racing this same endpoint) — ignore.
            });
          }
        })
    )
  );
}
