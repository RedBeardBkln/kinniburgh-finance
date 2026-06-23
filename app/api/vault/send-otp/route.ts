import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/resend";
import bcrypt from "bcryptjs";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Invalidate any existing unused OTPs for this user
  await db.vaultOtp.updateMany({
    where: { userId: session.user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await db.vaultOtp.create({
    data: {
      userId: session.user.id,
      codeHash,
      expiresAt,
    },
  });

  await sendEmail({
    to: session.user.email,
    subject: "WISKIN Books — Vault Access Code",
    html: `
      <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">Vault Access Code</h2>
        <p style="color: #444;">Your one-time code to access the WISKIN Books Vault:</p>
        <div style="background: #f4f4f5; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
          <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; font-family: monospace; color: #1a1a1a;">${code}</span>
        </div>
        <p style="color: #666; font-size: 13px;">This code expires in 10 minutes. Do not share it with anyone.</p>
      </div>
    `,
  });

  return NextResponse.json({ ok: true });
}
