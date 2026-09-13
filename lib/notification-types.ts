// Shared approval flow (spec 05 §8 item 9): which notification types support
// the "Approve" affordance. No DB import — safe to import from both the
// client bell component and server actions/pages.

export const APPROVABLE_NOTIFICATION_TYPES = ["large_spend", "anomaly"] as const;

export type ApprovableNotificationType = (typeof APPROVABLE_NOTIFICATION_TYPES)[number];

export function isApprovableNotificationType(type: string): type is ApprovableNotificationType {
  return (APPROVABLE_NOTIFICATION_TYPES as readonly string[]).includes(type);
}
