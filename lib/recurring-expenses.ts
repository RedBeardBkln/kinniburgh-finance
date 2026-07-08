export function monthlyEquivalentCents(amountCents: number, frequency: string): number {
  switch (frequency) {
    case "monthly":   return amountCents;
    case "weekly":    return Math.round((amountCents * 52) / 12);
    case "biweekly":  return Math.round((amountCents * 26) / 12);
    case "quarterly": return Math.round(amountCents / 3);
    case "annually":  return Math.round(amountCents / 12);
    default:          return amountCents;
  }
}

export const FREQUENCY_LABELS: Record<string, string> = {
  monthly:   "Monthly",
  weekly:    "Weekly",
  biweekly:  "Biweekly",
  quarterly: "Quarterly",
  annually:  "Annually",
};
