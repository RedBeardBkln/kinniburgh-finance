// Boundary conversion between Transaction.amount (Decimal(14,2) dollars) and integer cents. PURE: takes anything with `toFixed`, so
// there is no Prisma/Decimal import; the exact two-decimal string is turned into integer cents without any float arithmetic.

export function decimalToCents(amount: { toFixed(decimalPlaces: number): string }): number {
  const text = amount.toFixed(2);
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(text);
  if (!m) throw new Error("amount is not a plain two-decimal number");
  const cents = Number(m[2]) * 100 + Number(m[3]);
  if (!Number.isSafeInteger(cents)) throw new Error("amount is too large");
  return m[1] === "-" ? -cents : cents;
}
