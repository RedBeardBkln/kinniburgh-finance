"use server";

import crypto from "crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/encrypt";
import { sendEmail } from "@/lib/resend";
import { authenticator } from "otplib";
import bcrypt from "bcryptjs";
import qrcode from "qrcode";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

export async function generateTotpSetup(): Promise<{ qrDataUrl: string; secret: string }> {
  const user = await requireAuth();
  const dbUser = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { email: true } });

  const secret = authenticator.generateSecret();
  const keyuri = authenticator.keyuri(dbUser.email, "Banana Stand", secret);
  const qrDataUrl = await qrcode.toDataURL(keyuri);

  await db.user.update({
    where: { id: user.id },
    data: { totpSecret: encrypt(secret), totpVerified: false },
  });

  return { qrDataUrl, secret };
}

export async function verifyTotpSetup(code: string): Promise<{ success: boolean }> {
  const user = await requireAuth();
  const dbUser = await db.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { totpSecret: true },
  });

  if (!dbUser.totpSecret) return { success: false };

  const secret = decrypt(dbUser.totpSecret);
  const valid = authenticator.verify({ token: code, secret });

  if (valid) {
    await db.user.update({ where: { id: user.id }, data: { totpVerified: true } });
  }

  return { success: valid };
}

export async function requestPasswordReset(email: string): Promise<{ ok: true }> {
  const user = await db.user.findUnique({ where: { email } });

  if (user) {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    const baseUrl = process.env.NEXTAUTH_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

    await sendEmail({
      to: email,
      subject: "Reset your Banana Stand password",
      html: `
        <p>You requested a password reset for your Banana Stand account.</p>
        <p><a href="${baseUrl}/reset-password/${token}">Click here to reset your password</a></p>
        <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
      `,
    });
  }

  return { ok: true };
}

export async function resetPassword(
  token: string,
  newPassword: string
): Promise<{ ok: true } | { error: string }> {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const record = await db.passwordResetToken.findFirst({
    where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
  });

  if (!record) return { error: "Invalid or expired link" };

  const passwordHash = await bcrypt.hash(newPassword, 12);

  await db.$transaction([
    db.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    db.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);

  return { ok: true };
}
