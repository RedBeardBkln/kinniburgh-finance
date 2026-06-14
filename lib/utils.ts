import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format cents as USD currency string. */
export function formatUSD(
  cents: number | bigint | string,
  opts?: Intl.NumberFormatOptions
): string {
  const n = typeof cents === "string" ? parseFloat(cents) : Number(cents);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...opts,
  }).format(n);
}

/** Parse a Prisma Decimal (stored as string at runtime) to a JS number. */
export function decimalToNumber(d: unknown): number {
  if (d === null || d === undefined) return 0;
  return parseFloat(String(d));
}
