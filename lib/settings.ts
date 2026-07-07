import { db } from "@/lib/db";

export async function getAppSetting(key: string): Promise<string | null> {
  const row = await db.appSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  await db.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

export async function getLogoMeta(): Promise<{ key: string; mime: string } | null> {
  const [key, mime] = await Promise.all([
    getAppSetting("logo_key"),
    getAppSetting("logo_mime"),
  ]);
  if (!key || !mime) return null;
  return { key, mime };
}

export async function setLogoMeta(key: string, mime: string): Promise<void> {
  await Promise.all([
    setAppSetting("logo_key", key),
    setAppSetting("logo_mime", mime),
  ]);
}
