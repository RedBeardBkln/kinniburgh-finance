// Class names and plain-language reasons for the month-spend model. Client-safe (no Decimal, no database) so the
// dashboard dialogs can show them; lib/month-spend.ts re-exports these.

export type TxClass = "spending" | "refund" | "income" | "own_transfer" | "card_payment" | "loan_account";

export const EXCLUDED_CLASSES: readonly TxClass[] = ["own_transfer", "card_payment", "loan_account", "income"] as const;

export const CLASS_LABELS: Record<TxClass, string> = {
  spending: "Spending",
  refund: "Refund or credit",
  income: "Income",
  own_transfer: "Transfers between your own accounts",
  card_payment: "Credit card payments",
  loan_account: "Mortgage and loan account entries",
};

/** Short chip text for a row. */
export const CLASS_CHIPS: Record<TxClass, string> = {
  spending: "Spending",
  refund: "Refund",
  income: "Income",
  own_transfer: "Own transfer",
  card_payment: "Card payment",
  loan_account: "Loan account",
};

export const CLASS_WHY: Record<TxClass, string> = {
  spending: "Money out, counted when it left your account or was charged to a card.",
  refund: "Money back on a purchase; it reduces Spent.",
  income: "Pay, interest and revenue are shown as income, not as a refund of spending.",
  own_transfer: "Moving money between your own accounts is not spending.",
  card_payment: "Paying a card bill is the same money as the purchases already counted when they were charged.",
  loan_account: "These entries mirror the payment already counted from the account it was paid out of.",
};
