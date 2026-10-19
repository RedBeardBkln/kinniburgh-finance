// Pure TD Bank internal-transfer leg matching — client-safe, no DB import.
// Mirrors lib/dedupe.ts's shape: pure function, DB-aware caller does the I/O.

export interface TransferLegCandidate {
  id: string;
  accountId: string;
  postedAt: Date | string; // ISO strings OK
  amount: string; // decimal string; sign kept (negative = outgoing, positive = incoming)
  payeeRaw: string;
}

export interface MatchedTransferPair {
  outgoingTxId: string;
  incomingTxId: string;
  fromAccountId: string;
  toAccountId: string;
}

export interface UnmatchedTransferLeg {
  txId: string;
  /**
   * unresolvable_mask: the mask names no single household TD account, or names the row's OWN account.
   * sign_mismatch: the label direction disagrees with the amount's sign ("to" needs < 0, "from" needs > 0; zero never
   * qualifies). Such a row is never paired and never marked one-sided (protects against rows stored with a flipped sign).
   * no_counterpart: a valid leg whose other side is not among the candidates.
   */
  reason: "unresolvable_mask" | "sign_mismatch" | "no_counterpart";
}

/** A valid leg left without a counterpart: an own transfer whose other side is not in the records. */
export interface OneSidedTransferLeg {
  txId: string;
  /** The OTHER household account named by the label (validated mask or owner-stated alias). */
  counterpartAccountId: string;
  direction: "to" | "from";
}

export interface TransferLegParseResult {
  direction: "to" | "from";
  mask: string;
}

// Real data confirms the shape: "Online Xfer Transfer to CK x2540" or
// "Online Xfer Transfer from CK x2566" — letter code intentionally generic
// (not hardcoded to CK|SV) since only the mask matters for resolution.
const TRANSFER_LEG_RE = /^Online Xfer Transfer (to|from) [A-Z]{2} x(\d{4})$/;

/**
 * Collapses whitespace runs and trims. Historical rows use a double space ("Online  Xfer Transfer to CK x1234"; 224
 * statement-imported rows May 2025 to Apr 2026); everything else in the parse stays exact.
 */
export function normalizeTransferLabel(payee: string): string {
  return payee.replace(/\s+/g, " ").trim();
}

/** Sign of a decimal string without float maths: -1, 0, 1, or null when it is not a plain decimal. */
export function decimalSign(amount: string): -1 | 0 | 1 | null {
  const m = /^([-+]?)(\d*)(?:\.(\d*))?$/.exec(amount.trim());
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
  const digits = `${m[2]}${m[3] ?? ""}`;
  if (/^0*$/.test(digits)) return 0;
  return m[1] === "-" ? -1 : 1;
}

export function parseTransferLeg(payeeRaw: string): TransferLegParseResult | null {
  const match = TRANSFER_LEG_RE.exec(payeeRaw.trim());
  if (!match) return null;
  const direction = match[1] as "to" | "from";
  const mask = match[2]!;
  return { direction, mask };
}

function dayOf(postedAt: Date | string): string {
  const iso = postedAt instanceof Date ? postedAt.toISOString() : new Date(postedAt).toISOString();
  return iso.slice(0, 10);
}

interface BucketedLeg {
  candidate: TransferLegCandidate;
  fromAccountId: string;
  toAccountId: string;
}

/**
 * Matches candidate "Online Xfer Transfer ..." rows into 1:1 outgoing/incoming
 * pairs. Never guesses: unresolvable masks and unpaired legs are reported,
 * not force-matched.
 *
 * Algorithm:
 * 1. Parse each candidate's payeeRaw after collapsing whitespace runs
 *    (normalizeTransferLabel). Unparseable rows (non-transfer-shaped) are
 *    ignored entirely — never reported as unmatched.
 * 2. Parseable rows whose mask isn't in maskToAccountId, or resolves to the
 *    row's own account, are reported unmatched ("unresolvable_mask") and never
 *    grouped. Rows whose label direction disagrees with the amount's sign are
 *    reported "sign_mismatch" and never grouped.
 * 3. Otherwise compute fromAccountId/toAccountId (the account money left vs.
 *    arrived at) and bucket into an "outgoing" map and an "incoming" map,
 *    keyed by `${fromAccountId}|${toAccountId}|${postedDay}|${absAmount}`.
 * 4. For each key present in both maps, sort each side's queue by id
 *    ascending (deterministic, re-run-stable) and zip index-for-index.
 *    Leftover unpaired legs (uneven counts) are reported unmatched
 *    ("no_counterpart") and also returned in `oneSided` with the counterpart
 *    account the label names (every no_counterpart leg has a resolvable,
 *    non-self mask and an agreeing sign by construction).
 */
export function matchTransferLegs(
  candidates: TransferLegCandidate[],
  maskToAccountId: Map<string, string>
): { pairs: MatchedTransferPair[]; unmatched: UnmatchedTransferLeg[]; oneSided: OneSidedTransferLeg[] } {
  const unmatched: UnmatchedTransferLeg[] = [];
  const oneSided: OneSidedTransferLeg[] = [];
  const outgoing = new Map<string, BucketedLeg[]>();
  const incoming = new Map<string, BucketedLeg[]>();

  for (const candidate of candidates) {
    const parsed = parseTransferLeg(normalizeTransferLabel(candidate.payeeRaw));
    if (!parsed) continue; // not transfer-shaped; not a candidate at all

    const counterpartAccountId = maskToAccountId.get(parsed.mask);
    if (!counterpartAccountId || counterpartAccountId === candidate.accountId) {
      unmatched.push({ txId: candidate.id, reason: "unresolvable_mask" });
      continue;
    }

    const sign = decimalSign(candidate.amount);
    if ((parsed.direction === "to" && sign !== -1) || (parsed.direction === "from" && sign !== 1)) {
      unmatched.push({ txId: candidate.id, reason: "sign_mismatch" });
      continue;
    }

    const fromAccountId = parsed.direction === "to" ? candidate.accountId : counterpartAccountId;
    const toAccountId = parsed.direction === "to" ? counterpartAccountId : candidate.accountId;
    const key = `${fromAccountId}|${toAccountId}|${dayOf(candidate.postedAt)}|${Math.abs(
      Number(candidate.amount)
    ).toFixed(2)}`;

    const bucketed: BucketedLeg = { candidate, fromAccountId, toAccountId };
    const map = parsed.direction === "to" ? outgoing : incoming;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(bucketed);
  }

  const pairs: MatchedTransferPair[] = [];
  const allKeys = new Set([...outgoing.keys(), ...incoming.keys()]);

  for (const key of allKeys) {
    const outQueue = [...(outgoing.get(key) ?? [])].sort((a, b) =>
      a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0
    );
    const inQueue = [...(incoming.get(key) ?? [])].sort((a, b) =>
      a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0
    );

    const pairCount = Math.min(outQueue.length, inQueue.length);
    for (let i = 0; i < pairCount; i++) {
      const out = outQueue[i]!;
      const inn = inQueue[i]!;
      pairs.push({
        outgoingTxId: out.candidate.id,
        incomingTxId: inn.candidate.id,
        fromAccountId: out.fromAccountId,
        toAccountId: out.toAccountId,
      });
    }

    for (let i = pairCount; i < outQueue.length; i++) {
      const leg = outQueue[i]!;
      unmatched.push({ txId: leg.candidate.id, reason: "no_counterpart" });
      oneSided.push({ txId: leg.candidate.id, counterpartAccountId: leg.toAccountId, direction: "to" });
    }
    for (let i = pairCount; i < inQueue.length; i++) {
      const leg = inQueue[i]!;
      unmatched.push({ txId: leg.candidate.id, reason: "no_counterpart" });
      oneSided.push({ txId: leg.candidate.id, counterpartAccountId: leg.fromAccountId, direction: "from" });
    }
  }

  return { pairs, unmatched, oneSided };
}
