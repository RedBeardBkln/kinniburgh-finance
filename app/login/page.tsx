import { Suspense } from "react";
import { LoginForm } from "./login-form";
import { getLogoMeta } from "@/lib/settings";

export default async function LoginPage() {
  const logoMeta = await getLogoMeta();
  const logoUrl = logoMeta ? "/api/logo" : null;

  return (
    <Suspense>
      <LoginForm logoUrl={logoUrl} />
    </Suspense>
  );
}
