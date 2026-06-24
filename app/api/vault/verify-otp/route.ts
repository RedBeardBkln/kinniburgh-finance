import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { VAULT_COOKIE, VAULT_SESSION_HOURS } from "@/lib/vault-session";
import bcrypt from "bcryptjs";

const MAX_OTP_ATTEMPTS = 5;

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

  if (otp.attempts >= MAX_OTP_ATTEMPTS) {
    // Invalidate the OTP so the user must request a fresh one
    await db.vaultOtp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
    return NextResponse.json(
      { error: "Too many incorrect attempts. Please request a new code." },
      { status: 429 },
    );
  }

  const match = await bcrypt.compare(code.trim(), otp.codeHash);
  if (!match) {
    await db.vaultOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    const remaining = MAX_OTP_ATTEMPTS - otp.attempts - 1;
    return NextResponse.json(
      { error: `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.` },
      { status: 400 },
    );
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
