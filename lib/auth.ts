import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { z } from "zod";
import { decrypt } from "@/lib/encrypt";
import { authConfig } from "./auth.config";

class MfaRequired extends CredentialsSignin {
  code = "MFA_REQUIRED";
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().optional(),
});

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password, totpCode } = parsed.data;

        const user = await db.user.findUnique({ where: { email } });
        if (!user) return null;

        const passwordOk = await bcrypt.compare(password, user.passwordHash);
        if (!passwordOk) return null;

        if (user.totpVerified && user.totpSecret) {
          if (!totpCode) throw new MfaRequired();
          const secret = decrypt(user.totpSecret);
          const totpOk = authenticator.verify({ token: totpCode, secret });
          if (!totpOk) return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          totpVerified: user.totpVerified,
        };
      },
    }),
  ],
});
