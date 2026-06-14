import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { z } from "zod";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().optional(),
});

export const { handlers, signIn, signOut, auth } = NextAuth({
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
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

        // If MFA is enrolled and verified, require TOTP code
        if (user.totpVerified && user.totpSecret) {
          if (!totpCode) return null;
          const decryptedSecret = user.totpSecret; // Phase 0: stored plaintext; Phase 4+ encrypt at rest
          const totpOk = authenticator.verify({
            token: totpCode,
            secret: decryptedSecret,
          });
          if (!totpOk) return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token["id"] = user.id;
        token["role"] = (user as { role?: string }).role;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token["id"] as string;
        (session.user as { role?: string }).role = token["role"] as string;
      }
      return session;
    },
  },
});
