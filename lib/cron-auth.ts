import { timingSafeEqual } from "node:crypto";

/**
 * Validates the `Authorization: Bearer <CRON_SECRET>` header Vercel sends to
 * /api/cron/* routes.
 *
 * Fails closed: an unset/empty CRON_SECRET authorizes nothing (a plain
 * `header !== \`Bearer ${process.env.CRON_SECRET}\`` would accept the literal
 * "Bearer undefined"). Compares in constant time.
 */
export function isAuthorizedCronRequest(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !authHeader) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authHeader);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
