-- Shared approval flow (spec 05 §8 item 9): adds approval state directly on the
-- shared Notification row (not NotificationUser) so "who approved, when" is
-- visible to every household member, not a private per-user read marker.
-- Applies only to large_spend / anomaly notification types at the app layer
-- (see lib/notification-types.ts); no DB-level type constraint.

ALTER TABLE "Notification" ADD COLUMN "approvedByUserId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "approvedAt" TIMESTAMP(3);

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_approvedByUserId_fkey"
  FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
