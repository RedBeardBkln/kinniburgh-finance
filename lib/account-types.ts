// ── Shared account-type constants ──────────────────────────────────────────
// Single source of truth for the Account.accountType enum, previously
// duplicated between actions/accounts.ts (zod validation) and
// components/accounts/accounts-page-client.tsx (<select> options).

export const ACCOUNT_TYPE_VALUES = [
  "checking",
  "savings",
  "credit_card",
  "mortgage",
  "loan",
  "investment",
  "insurance",
] as const;

export type AccountType = (typeof ACCOUNT_TYPE_VALUES)[number];

export const ACCOUNT_TYPE_OPTIONS: { value: AccountType; label: string }[] = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "credit_card", label: "Credit Card" },
  { value: "mortgage", label: "Mortgage" },
  { value: "loan", label: "Loan" },
  { value: "investment", label: "Investment" },
  { value: "insurance", label: "Insurance" },
];
