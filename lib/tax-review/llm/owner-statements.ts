// The "owner statements" block of the AI review payload (ai-payload-fixes).
//
// The first live review asked the owner about things he had already confirmed (no 1099-NEC was issued, no CT estimates were paid ...).
// This block carries those facts, labelled as what they are, so the model stops asking. It is ADVISORY CONTEXT for the model ONLY:
//   - it is never read by the tax engine, the rules or the gate (the engine computes from the documents and the recorded answers);
//   - it is labelled "owner statements, not verified by documents";
//   - the model may still ADD a finding (it can never close one): when a figure contradicts a statement, when a statement does not carry
//     the conclusion it would draw, or when something NOT covered by a statement is wrong.
// Part of it is built from data the app already holds (the groups the owner stated are "none", the recorded decisions and the reasons
// given for them, the reasons for findings the owner accepted); the rest is an explicit, versioned, allow-listed constant list for
// TY2025: nothing else is ever added to it by code.
//
// PURE: no DB, no network, no clock.

import { findRedactionIssues } from "@/lib/tax-review/redact";

export const OWNER_STATEMENTS_VERSION = 1;

export const OWNER_STATEMENTS_LABEL =
  "Owner statements, NOT verified by documents: facts the owner confirmed himself. Treat each as given and do not ask the owner to confirm it again. You may still add a finding if a figure or a line contradicts a statement, if a statement does not carry the conclusion you would draw, or about anything a statement does not cover.";

/** The TY2025 owner-confirmed facts that do not depend on a document: an explicit allow-list (a new one is added here, by hand, and nowhere else). */
export const OWNER_STATEMENTS_TY2025: readonly string[] = [
  "No business other than the Consulting LLC existed or had activity in 2025.",
  "No information returns (Form 1099-NEC, 1099-MISC or 1099-K) were issued to the Consulting LLC for 2025.",
  "There is no residential clean energy credit (Form 5695) carryforward from 2024.",
  "No Connecticut estimated tax payments were made for 2025, and no 2024 Connecticut balance was paid in 2025.",
  "No margin interest or investment interest was paid in 2025.",
  "The software and apps expenses in the books are all for the Consulting LLC and cover tax year 2025.",
  "Taxpayer M materially participates in the Consulting LLC.",
  "The $7,000 traditional IRA contribution (Taxpayer M) was made in 2025.",
];

export interface RecordedDecision {
  /** "decision" | "line" | "rule_ack" (an owner / CPA override row of the return). */
  kind: string;
  target: string;
  /** The chosen option, or the overriding amount in whole dollars; null for an acknowledgement. */
  value: string | null;
  reason: string;
}

export interface AcceptedFinding {
  key: string;
  /** What the finding said (clipped), or null when it is no longer known. */
  about: string | null;
  reason: string;
}

export interface OwnerStatementInput {
  /** Aliases (doc:<alias>) of the Form 1099-INT documents of TD Bank, of the property tax bills of a property that is not the primary residence, and of every document listed. */
  tdInterestAliases: readonly string[];
  otherPropertyBillAliases: readonly string[];
  documentAliases: ReadonlySet<string>;
  /** Groups the owner stated are "none" (facts.statedNone), sorted. */
  statedNone: readonly string[];
  recordedDecisions: readonly RecordedDecision[];
  acceptedFindings: readonly AcceptedFinding[];
}

export interface OwnerStatements {
  version: typeof OWNER_STATEMENTS_VERSION;
  taxYear: 2025;
  label: string;
  /** Allow-listed facts (constants above plus the ones tied to a document by its alias). */
  confirmed: string[];
  /** Groups the owner stated have nothing to report (from the answers). */
  statedNone: string[];
  /** Decisions and overrides the owner recorded, with the reason given. */
  recordedDecisions: RecordedDecision[];
  /** Findings the owner accepted, with the reason given. */
  acceptedFindings: AcceptedFinding[];
}

const MAX_DECISIONS = 25;
const MAX_ACCEPTED = 25;

/**
 * Text that must not travel with the owner's records: it names a business other than the one that existed in 2025, in the words an earlier
 * review used for it (the generic labels of the first live review, "the Property Management LLC" and "the third business entity"), as a
 * placeholder, or by name. An accepted finding written about "three entities" would otherwise bring the unformed entity back.
 */
const RETIRED_ENTITY_TEXT = /the Property Management LLC|the third business entity|business entity \d|\[business name removed\]|\bMezzo\b|\bSudden Valley\b/i;

function clean(text: string, max: number): string | null {
  const t = text.replace(/\s+/g, " ").trim().slice(0, max);
  // a free-text reason that looks like an identifier is left out of this block (the payload as a whole is refused if any is left)
  return t === "" || findRedactionIssues(t).length > 0 || RETIRED_ENTITY_TEXT.test(text) ? null : t;
}

/** The document the owner said is a 2026 document to be disregarded (uploaded as type "other"). */
const DISREGARDED_2026_DOC = "c20de682";

export function buildOwnerStatements(input: OwnerStatementInput): OwnerStatements {
  const confirmed: string[] = [...OWNER_STATEMENTS_TY2025];
  for (const a of input.tdInterestAliases) confirmed.push(`On the bank Form 1099-INT doc:${a}, box 4 (federal income tax withheld) is zero.`);
  for (const a of input.otherPropertyBillAliases) confirmed.push(`The property tax bill doc:${a} is for a property that is not the primary residence; that property was not offered for rent in 2025.`);
  if (input.documentAliases.has(DISREGARDED_2026_DOC)) confirmed.push(`doc:${DISREGARDED_2026_DOC} is a 2026 document: disregard it for the 2025 return.`);
  const recordedDecisions: RecordedDecision[] = [];
  for (const d of input.recordedDecisions.slice(0, MAX_DECISIONS)) {
    const reason = clean(d.reason, 240);
    if (reason !== null) recordedDecisions.push({ kind: d.kind, target: d.target, value: d.value, reason });
  }
  const acceptedFindings: AcceptedFinding[] = [];
  for (const f of input.acceptedFindings.slice(0, MAX_ACCEPTED)) {
    const reason = clean(f.reason, 240);
    // what the finding said is checked on the WHOLE text (not the clipped part): an entry about a retired entity is left out altogether
    if (f.about !== null && RETIRED_ENTITY_TEXT.test(f.about)) continue;
    if (reason !== null) acceptedFindings.push({ key: f.key, about: f.about === null ? null : clean(f.about, 160), reason });
  }
  return { version: OWNER_STATEMENTS_VERSION, taxYear: 2025, label: OWNER_STATEMENTS_LABEL, confirmed, statedNone: [...input.statedNone], recordedDecisions, acceptedFindings };
}
