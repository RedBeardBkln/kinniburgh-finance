// The ONE place the assistant reads the `user` table, and only `id` and `name` (display name). Never email, password hash, TOTP secret
// or notification preferences (the exclusion test pins the select).

import { db } from "@/lib/db";

export interface Person {
  id: string;
  name: string;
}

export async function getPerson(userId: string): Promise<Person | null> {
  return db.user.findFirst({ where: { id: userId }, select: { id: true, name: true } });
}
