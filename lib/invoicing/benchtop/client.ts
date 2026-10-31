// Calls to Benchtop's invoicing connection (/api/connect/time/*). Server only. The key is the owner's Benchtop connection key, read
// from its encrypted column by lib/invoicing/tin-store.ts; it is sent only in the Authorization header to Benchtop and never logged,
// returned to a page or written to AuditLog / BillingEvent. Failures become one fixed sentence (BenchtopError), never Benchtop's text.

import type { BenchtopEntry } from "@/lib/invoicing/benchtop/time-lines";

const DEFAULT_BASE_URL = "https://benchtop.solutions";
const TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** btk_ + 43 base64url characters (Benchtop's key format). */
export function looksLikeBenchtopKey(key: string): boolean {
  return /^btk_[A-Za-z0-9_-]{43}$/.test(key);
}

export class BenchtopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchtopError";
  }
}

function baseUrl(): string {
  const raw = process.env.BENCHTOP_BASE_URL?.trim();
  if (!raw) return DEFAULT_BASE_URL;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.hostname !== "localhost") throw new Error("not https");
    return u.origin;
  } catch {
    throw new BenchtopError("BENCHTOP_BASE_URL is not a valid https address.");
  }
}

async function call(key: string, path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof BenchtopError) throw err;
    throw new BenchtopError("Benchtop could not be reached. Try again in a minute.");
  }
  if (res.status === 401) throw new BenchtopError("Benchtop did not accept the connection key. Make a new key in Benchtop (Settings > Invoicing connection) and save it in Invoicing settings.");
  if (res.status === 403) throw new BenchtopError("Benchtop refused the connection: its login cannot be used right now (check the Benchtop account and subscription).");
  if (!res.ok) throw new BenchtopError("Benchtop could not answer the request. Try again in a minute.");
  try {
    return await res.json();
  } catch {
    throw new BenchtopError("Benchtop sent an answer that could not be read.");
  }
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

/** The Benchtop clients the connected login logs time against. */
export async function fetchBenchtopClients(key: string): Promise<{ id: string; name: string }[]> {
  const data = (await call(key, "/api/connect/time/clients")) as { clients?: unknown };
  if (!Array.isArray(data.clients)) throw new BenchtopError("Benchtop sent an answer that could not be read.");
  return data.clients.flatMap((c: { id?: unknown; name?: unknown }) => {
    const id = str(c.id, 40);
    const name = str(c.name, 300);
    return id && UUID.test(id) && name ? [{ id, name }] : [];
  });
}

/** Finished, unbilled time for one Benchtop client, optionally started within [from, to) (ISO times). */
export async function fetchBenchtopEntries(key: string, clientId: string, range: { from?: string; to?: string } = {}): Promise<{ entries: BenchtopEntry[]; truncated: boolean }> {
  if (!UUID.test(clientId)) throw new BenchtopError("The linked Benchtop client is not valid. Link the client again.");
  const q = new URLSearchParams({ client: clientId });
  if (range.from) q.set("from", range.from);
  if (range.to) q.set("to", range.to);
  const data = (await call(key, `/api/connect/time/entries?${q.toString()}`)) as { entries?: unknown; truncated?: unknown };
  if (!Array.isArray(data.entries)) throw new BenchtopError("Benchtop sent an answer that could not be read.");
  const entries = data.entries.flatMap((raw: Record<string, unknown>): BenchtopEntry[] => {
    const id = str(raw.id, 40);
    const startedAt = str(raw.startedAt, 40);
    const endedAt = str(raw.endedAt, 40);
    const activity = str(raw.activity, 100);
    const task = str(raw.task, 4000);
    const person = str(raw.person, 200);
    const minutes = raw.minutes;
    const projectName = raw.projectName === null ? null : str(raw.projectName, 300);
    if (!id || !UUID.test(id) || !startedAt || !endedAt || !activity || task === null || person === null) return [];
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) return [];
    if (Number.isNaN(Date.parse(startedAt)) || Number.isNaN(Date.parse(endedAt))) return [];
    if (raw.projectName !== null && projectName === null) return [];
    return [{ id, startedAt, endedAt, minutes, activity, task, projectName, person }];
  });
  return { entries, truncated: data.truncated === true };
}

export interface BilledResult {
  change: string[];
  unchanged: string[];
  conflicts: string[];
  missing: string[];
}

/** Marks the entries billed on the invoice (billed true) or takes them off it (false). Safe to repeat. */
export async function markBenchtopBilled(key: string, ids: string[], billed: boolean, invoice: string): Promise<BilledResult> {
  const results: BilledResult = { change: [], unchanged: [], conflicts: [], missing: [] };
  for (let i = 0; i < ids.length; i += 2000) {
    const data = (await call(key, "/api/connect/time/billed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids.slice(i, i + 2000), billed, invoice }),
    })) as Partial<Record<keyof BilledResult, unknown>>;
    for (const k of ["change", "unchanged", "conflicts", "missing"] as const) {
      const v = data[k];
      if (!Array.isArray(v)) throw new BenchtopError("Benchtop sent an answer that could not be read.");
      results[k].push(...v.filter((x): x is string => typeof x === "string"));
    }
  }
  return results;
}
