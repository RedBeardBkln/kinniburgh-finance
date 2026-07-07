import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { getLogoMeta } from "@/lib/settings";

const inter = Inter({ subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const logoMeta = await getLogoMeta();
  return {
    title: "Banana Stand",
    description: "Personal and business financial management",
    robots: { index: false, follow: false },
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "Banana Stand",
    },
    icons: logoMeta
      ? { icon: "/api/logo", apple: "/api/logo" }
      : { icon: "/favicon.svg", apple: "/apple-touch-icon.png" },
  };
}

export const viewport: Viewport = {
  themeColor: "#d97706",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
