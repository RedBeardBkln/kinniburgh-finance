// The "by hand" information cards on the Final review page (ai-return-reviewer, B5; plan 5.12): filing logistics, records and
// corrections. Every statement carries a source id AND a quote copied from the pinned source pack; a statement whose quote does
// not verify against the pack is REMOVED when the card is built (a statement without a source is absent, never shown). The cards
// are labelled "not verified legal advice": they only restate what the instructions say, with the page they come from.
//
// Deliberately absent: the due date, where to mail a paper return, e-file rules for Form 8949 statements, Form 8879 and CT e-file
// rules. The pinned pages do not state them in a form that can be quoted, so nothing is asserted about them here.
//
// PURE: works on a SourcePack passed in.

import { sourceEntry, verifyQuote, type SourcePack } from "@/lib/tax-review/llm/sources";

export interface InfoStatement {
  id: string;
  /** What the card says, in plain words (a restatement of the quote, adding no fact). */
  text: string;
  sourceId: string;
  /** Verbatim from the source. */
  quote: string;
  /** PDF page of the source, for the reader. */
  page: number;
}

export interface InfoCardDef {
  id: string;
  title: string;
  label: string;
  statements: readonly InfoStatement[];
}

export const NOT_LEGAL_ADVICE = "Not verified legal advice. Each point restates the instructions and links to the page it comes from; confirm it there before you rely on it.";

export const FILING_LOGISTICS: InfoCardDef = {
  id: "filing_logistics",
  title: "Filing logistics",
  label: NOT_LEGAL_ADVICE,
  statements: [
    { id: "fed_joint_sign", text: "On a joint federal return both spouses must sign.", sourceId: "i1040gi", quote: "If you are filing a joint return, your spouse must also sign.", page: 65 },
    { id: "fed_paper_handwritten", text: "On a paper federal return the signature must be handwritten; typed or digital signatures are not valid on paper.", sourceId: "i1040gi", quote: "You must handwrite your signature on your return if you file it on paper.", page: 66 },
    { id: "fed_efile_pin_joint", text: "To e-file a joint federal return, each spouse creates a PIN and enters it as the electronic signature.", sourceId: "i1040gi", quote: "If you are married filing jointly, you and your spouse will each need to create a PIN and enter these PINs as your electronic signatures.", page: 66 },
    { id: "fed_form_8453", text: "A paper Form 8453 is needed when you must attach forms or documents that cannot be e-filed.", sourceId: "i1040gi", quote: "You must send in a paper Form 8453 if you have to attach certain forms or other documents that can't be electronically filed.", page: 66 },
    { id: "fed_8949_statement", text: "A Form 8949 summary row that says \"see attached statement\" relies on an attached statement with the same information as Parts I and II (dates, proceeds, basis, adjustments and gain or loss for each transaction).", sourceId: "i8949", quote: "you can report them on an attached statement containing all the same information as Parts I and II and in a similar format", page: 4 },
    { id: "fed_direct_pay", text: "IRS Direct Pay transfers money from a checking or savings account at no cost.", sourceId: "i1040gi", quote: "For online transfers directly from your checking or savings account at no cost to you, go to IRS.gov/Payments.", page: 64 },
    { id: "fed_free_file", text: "IRS Free File lets you prepare and file a federal return for free with software or Free File Fillable Forms; state preparation may not be available through it.", sourceId: "i1040gi", quote: "This program lets you prepare and file your federal individual income tax return for free using software or Free File Fillable Forms.", page: 83 },
    { id: "ct_joint_sign", text: "On a joint Connecticut return your spouse must also sign and date it.", sourceId: "ct1040i", quote: "Your spouse must also sign and enter the date if this is a joint return.", page: 5 },
    { id: "ct_joint_liability", text: "When both spouses sign the Connecticut return, each becomes responsible for the full amount of tax, interest and penalties.", sourceId: "ct1040i", quote: "When both you and your spouse sign the return, you become jointly and severally responsible for paying the full amount of tax, interest, and penalties due.", page: 5 },
  ],
};

export const RECORDS_AND_CORRECTIONS: InfoCardDef = {
  id: "records_and_corrections",
  title: "Records and corrections",
  label: NOT_LEGAL_ADVICE,
  statements: [
    { id: "keep_records", text: "Keep a copy of the return, the worksheets and the records of every item on it until the statute of limitations runs out.", sourceId: "i1040gi", quote: "Keep a copy of your tax return, worksheets you used, and records of all items appearing on it (such as Forms W-2 and 1099) until the statute of limitations runs out for that return.", page: 82 },
    { id: "amend", text: "If you find an error after filing, a federal return is changed by filing Form 1040-X.", sourceId: "i1040gi", quote: "File Form 1040-X to change a return you already filed.", page: 83 },
    { id: "amend_deadline", text: "A refund claimed on an amended return generally must be filed within 3 years of filing the original or 2 years of paying the tax, whichever is later.", sourceId: "i1040gi", quote: "Generally, to timely claim a refund on your amended return, Form 1040-X must be filed within 3 years after the date the original return was filed or within 2 years after the date the tax was paid, whichever is later.", page: 83 },
  ],
};

export const INFO_CARDS: readonly InfoCardDef[] = [FILING_LOGISTICS, RECORDS_AND_CORRECTIONS];

export interface VerifiedStatement extends InfoStatement {
  /** Link to the pinned source document. */
  url: string;
  sourceTitle: string;
}

export interface VerifiedCard {
  id: string;
  title: string;
  label: string;
  statements: VerifiedStatement[];
  /** Statements dropped because their quote did not verify against the pack. */
  dropped: string[];
}

/** The card with every statement whose source exists and whose quote verifies; the rest are absent. */
export function verifyCard(pack: SourcePack, card: InfoCardDef): VerifiedCard {
  const statements: VerifiedStatement[] = [];
  const dropped: string[] = [];
  for (const s of card.statements) {
    const entry = sourceEntry(pack, s.sourceId);
    if (entry !== undefined && verifyQuote(pack, s.sourceId, s.quote)) statements.push({ ...s, url: entry.url, sourceTitle: entry.title });
    else dropped.push(s.id);
  }
  return { id: card.id, title: card.title, label: card.label, statements, dropped };
}

export function verifyCards(pack: SourcePack): VerifiedCard[] {
  return INFO_CARDS.map((c) => verifyCard(pack, c)).filter((c) => c.statements.length > 0);
}
