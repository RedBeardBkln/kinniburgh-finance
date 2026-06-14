import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

async function main() {
  const users = await db.user.findMany({ select: { id: true, email: true, name: true } });
  console.log("Users in DB:", JSON.stringify(users, null, 2));

  const hash = await bcrypt.hash("change-me-immediately", 12);
  const updated = await db.user.updateMany({
    where: { name: "Eric Kinniburgh" },
    data: { email: "ekinniburgh@gmail.com", passwordHash: hash },
  });
  console.log(`Updated ${updated.count} user(s) to ekinniburgh@gmail.com`);
}

main().catch(console.error).finally(() => db.$disconnect());
