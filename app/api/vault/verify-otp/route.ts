import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { VAULT_COOKIE, VAULT_SESSION_HOURS } from "@/lib/vault-session";
import bcrypt from "bcryptjs";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { code } = await req.json();
  if (!code || typeof code !== "string") {
    return NextResponse.json({ error: "Code required" }, { status: 400 });
  }

  const otp = await db.vaultOtp.findFirst({
    where: {
      userId: session.user.id,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!otp) {
    return NextResponse.json({ error: "No valid code found. Please request a new one." }, { status: 400 });
  }

  const match = await bcrypt.compare(code.trim(), otp.codeHash);
  if (!match) {
    return NextResponse.json({ error: "Incorrect code." }, { status: 400 });
  }

  // Mark OTP used
  await db.vaultOtp.update({
    where: { id: otp.id },
    data: { usedAt: new Date() },
  });

  // Create vault session (4 hours)
  const expiresAt = new Date(Date.now() + VAULT_SESSION_HOURS * 60 * 60 * 1000);
  const vaultSession = await db.vaultSession.create({
    data: { userId: session.user.id, expiresAt },
  });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(VAULT_COOKIE, vaultSession.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    expires: expiresAt,
    path: "/",
  });
  return res;
}
