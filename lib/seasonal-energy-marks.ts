// Durable "Not heating oil" marks on McCarthy rows. Pure: no database, no clock, no Next.js.
//
// A mark used to be a bare transaction id. This app's Plaid sync archives a PENDING bank row and adds the POSTED row
// under a NEW id (0 to 1 days later, same account, same amount), so an id-only mark would be orphaned the moment the row
// posts and the owner's decision would be silently undone. A mark therefore stores, next to the id, a durable signature
// of the row: account id, absolute amount in cents, normalised payee and posted date. A later row on the same account
// with the same cents and payee inside a small date window inherits the mark, but a mark never covers more than ONE
// row (two identical deliveries are never swallowed by one click), a row already matched by another mark is skipped, and
// a mark whose id still matches a current row always wins over a signature match.
//
// Storage (no migration): AppSetting `oil_not_heating:<entityId>`, a JSON array of entries, each either a bare id string
// (the first format, still read) or { id, sig?: { a: accountId, c: cents, p: payee key, on: "YYYY-MM-DD" } }, capped at
// OIL_EXCLUDED_CAP entries. One entry is one slot whether or not its id is stale.

import { Decimal } from "@prisma/client/runtime/library";
import { OIL_EXCLUDED_CAP, type Checked } from "@/lib/seasonal-energy-prices";

export const MARK_WINDOW_DAYS = 5;
const TX_ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const DAY_MS = 86_400_000;

export interface MarkSig {
  /** Account id (not a number: an internal id). */
  a: string;
  /** Absolute amount in cents. */
  c: number;
  /** Normalised payee key. */
  p: string;
  /** Posted date, YYYY-MM-DD. */
  on: string;
}

export interface OilMark {
  id: string;
  sig?: MarkSig;
}

/** What the matcher needs to know about a transaction. */
export interface MarkRow {
  id: string;
  accountId: string;
  /** Signed or unsigned: only the absolute value in cents is used. */
  amount: Decimal | string | number;
  payee: string;
  date: Date;
}

/**
 * The ONE descriptor a mark compares: payeeNormalized, else payeeRaw, else description (the first non-empty). The three
 * fields are alternative spellings of the same bank text, so joining them would double it ("mccarthy heating oil
 * mccarthy heating oil") and defeat the whole-word-prefix tolerance between a pending and a posted descriptor. The joined
 * text is for supplier-kind detection only, never for a mark.
 */
export function descriptorOf(fields: { payeeNormalized?: string | null; payeeRaw?: string | null; description?: string | null }): string {
  for (const v of [fields.payeeNormalized, fields.payeeRaw, fields.description]) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return "";
}

/**
 * Lower-case words only: "MCCARTHY HEATING OIL SERV 860" becomes "mccarthy heating oil serv 860". Digit runs of 5 or more
 * characters (bank reference and phone numbers) are dropped: they are never stored, and they differ between a pending
 * and a posted descriptor.
 */
export function payeeKey(payee: string): string {
  return payee.toLowerCase().replace(/\d{5,}/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Equal, or one is a whole-word prefix of the other ("mccarthy heating oil" vs "mccarthy heating oil serv 860"). */
export function payeesAlike(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  if (a === b) return true;
  return a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

export function centsOf(amount: Decimal | string | number): number {
  return new Decimal(String(amount)).abs().times(100).toDecimalPlaces(0).toNumber();
}

export function signatureOf(row: MarkRow): MarkSig {
  return { a: row.accountId, c: centsOf(row.amount), p: payeeKey(row.payee), on: row.date.toISOString().slice(0, 10) };
}

function dayDiff(on: string, d: Date): number {
  return Math.round((d.getTime() - Date.parse(`${on}T00:00:00Z`)) / DAY_MS);
}

/** True when the row looks like the same charge the signature was taken from. */
export function sigMatches(sig: MarkSig, row: MarkRow, windowDays = MARK_WINDOW_DAYS): boolean {
  if (row.accountId !== sig.a) return false;
  if (centsOf(row.amount) !== sig.c) return false;
  if (!payeesAlike(sig.p, payeeKey(row.payee))) return false;
  return Math.abs(dayDiff(sig.on, row.date)) <= windowDays;
}

function isSig(v: unknown): v is MarkSig {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["a"] === "string" &&
    o["a"] !== "" &&
    typeof o["c"] === "number" &&
    Number.isInteger(o["c"]) &&
    o["c"] >= 0 &&
    typeof o["p"] === "string" &&
    typeof o["on"] === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(o["on"])
  );
}

/** Tolerant parse: bare id strings (the first format) and { id, sig } objects; anything else is dropped; unique ids; capped. */
export function parseMarks(raw: string | null | undefined): { marks: OilMark[]; corrupt: boolean } {
  if (raw === null || raw === undefined || raw.trim() === "") return { marks: [], corrupt: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { marks: [], corrupt: true };
  }
  if (!Array.isArray(parsed)) return { marks: [], corrupt: true };
  const marks: OilMark[] = [];
  for (const v of parsed) {
    let id: string | null = null;
    let sig: MarkSig | undefined;
    if (typeof v === "string") id = v;
    else if (typeof v === "object" && v !== null && typeof (v as Record<string, unknown>)["id"] === "string") {
      id = (v as { id: string }).id;
      const s = (v as { sig?: unknown }).sig;
      if (isSig(s)) sig = { a: s.a, c: s.c, p: s.p, on: s.on };
    }
    if (id === null || !TX_ID_RE.test(id) || marks.some((m) => m.id === id)) continue;
    marks.push(sig ? { id, sig } : { id });
    if (marks.length >= OIL_EXCLUDED_CAP) break;
  }
  return { marks, corrupt: false };
}

export function serializeMarks(marks: readonly OilMark[]): string {
  return JSON.stringify(marks.slice(0, OIL_EXCLUDED_CAP));
}

export interface ResolvedMarks {
  /** Ids of the current rows that are marked (directly or as the twin of an earlier row). */
  excludedIds: Set<string>;
  /** How many marks matched a row only through their signature (the pending row was replaced by a posted one). */
  inherited: number;
}

/**
 * Which of `rows` are marked. 1) A mark whose id is a current row marks that row. 2) A mark with no such row and a
 * signature marks the best-matching row that no mark has claimed (same account, cents and payee within the window;
 * preferring a row on or after the signature date, then the closest, then the lowest id). A mark covers at most one row.
 */
export function resolveMarks(marks: readonly OilMark[], rows: readonly MarkRow[]): ResolvedMarks {
  const claimed = new Set<string>();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pending: OilMark[] = [];
  for (const m of marks) {
    if (byId.has(m.id) && !claimed.has(m.id)) claimed.add(m.id);
    else pending.push(m);
  }
  let inherited = 0;
  for (const m of pending) {
    if (!m.sig) continue;
    const sig = m.sig;
    const candidates = rows
      .filter((r) => !claimed.has(r.id) && sigMatches(sig, r))
      .sort((x, y) => {
        const dx = dayDiff(sig.on, x.date);
        const dy = dayDiff(sig.on, y.date);
        const before = (dx < 0 ? 1 : 0) - (dy < 0 ? 1 : 0);
        return before || Math.abs(dx) - Math.abs(dy) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
      });
    const hit = candidates[0];
    if (hit) {
      claimed.add(hit.id);
      inherited += 1;
    }
  }
  return { excludedIds: claimed, inherited };
}

export interface ToggleTarget {
  id: string;
  sig: MarkSig;
}

/**
 * Applies one owner click to the stored marks. `aliveIds` are the ids of the stored marks that still exist as
 * non-archived transactions (a stale id is a pending row the bank has replaced).
 *   mark on:  the target's id already stored -> no change; else a STALE entry with an alike signature is replaced by the
 *             target (same slot, no new cap slot); else a new entry is added (refused at the cap).
 *   mark off: removes the entry with the target's id, else a stale entry with an alike signature; nothing else.
 * An entry whose id is still alive is never taken over by another row, so two identical deliveries stay two decisions.
 */
export function applyToggle(
  marks: readonly OilMark[],
  target: ToggleTarget,
  excluded: boolean,
  aliveIds: ReadonlySet<string>
): Checked<OilMark[]> {
  if (!TX_ID_RE.test(target.id)) return { ok: false, error: "That transaction id is not valid." };
  const own = marks.findIndex((m) => m.id === target.id);
  const twinOf = (): number =>
    marks.findIndex(
      (m) =>
        m.id !== target.id &&
        !aliveIds.has(m.id) &&
        m.sig !== undefined &&
        m.sig.a === target.sig.a &&
        m.sig.c === target.sig.c &&
        payeesAlike(m.sig.p, target.sig.p) &&
        Math.abs(Date.parse(`${m.sig.on}T00:00:00Z`) - Date.parse(`${target.sig.on}T00:00:00Z`)) <= MARK_WINDOW_DAYS * DAY_MS
    );
  if (excluded) {
    if (own >= 0) {
      const cur = marks[own] as OilMark;
      // Same id: nothing to do, except to add the signature to an entry saved in the first (id-only) format.
      if (cur.sig) return { ok: true, value: [...marks] };
      return { ok: true, value: marks.map((m, i) => (i === own ? { id: target.id, sig: target.sig } : m)) };
    }
    const twin = twinOf();
    if (twin >= 0) return { ok: true, value: marks.map((m, i) => (i === twin ? { id: target.id, sig: target.sig } : m)) };
    if (marks.length >= OIL_EXCLUDED_CAP) {
      return { ok: false, error: `You have marked ${OIL_EXCLUDED_CAP} charges already; count some again before marking more.` };
    }
    return { ok: true, value: [...marks, { id: target.id, sig: target.sig }] };
  }
  if (own >= 0) return { ok: true, value: marks.filter((_, i) => i !== own) };
  const twin = twinOf();
  if (twin >= 0) return { ok: true, value: marks.filter((_, i) => i !== twin) };
  return { ok: true, value: [...marks] };
}
