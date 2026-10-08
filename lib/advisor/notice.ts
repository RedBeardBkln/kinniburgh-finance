// "What the assistant can see": the owner-facing notice (plan section 12). One constant list so a test can pin it against the data boundary
// (exclusions.ts) and the tool set. PURE. Wording rules: the assistant is software, never a professional; "memory" means the app's own database.

export interface NoticeSection {
  heading: string;
  items: readonly string[];
}

export const ASSISTANT_NOTICE_TITLE = "What the assistant can see";

export const ASSISTANT_NOTICE: readonly NoticeSection[] = [
  {
    heading: "It can read",
    items: [
      "Accounts and balances (nickname, institution, type and the last four digits only), net worth history, transactions, spending summaries, budgets and goals.",
      "The TY2025 return as a draft: headline figures, line status and where each figure came from, open items, your decisions and their reasons, the tax facts you confirmed, and the AI review and approval status.",
      "Names the app already shows: Eric and Eva by first name, your entities, account nicknames, institutions, payees and tags.",
      "Business profit and loss by entity, rental income totals (no renter names), recurring bills, transfers and paychecks, the balance forecast, the tax calendar and a timeline of recent changes (what changed and who did it, never the values or reasons).",
      "Your document list (names, types, years, status), and for tax forms the amounts, dates and payer, employer, lender or charity names read from them, each labelled verified by you or an unverified AI read. ID numbers, account numbers, addresses and dates of birth are never included.",
      "Donation and fixed-asset logs (as entered, no deductions computed) and insurance summaries without policy numbers.",
    ],
  },
  {
    heading: "It never sees",
    items: [
      "Vault contents, bank logins or bank connection tokens, passwords and sign-in secrets.",
      "Social Security numbers, EINs, full account or routing numbers, dates of birth and street addresses. Anything that looks like one is replaced before it is used.",
      "The original document files.",
    ],
  },
  {
    heading: "What it can do",
    items: [
      "Read only. It cannot change a transaction, a budget, a decision, an override, an approval or a document, and it cannot start the AI review. It points you to the page where you do those things.",
      "If you ask it to remember something it can suggest a memory note, but nothing is saved unless you click Save on the suggestion.",
      "It is software, not a CPA, EA, attorney or financial planner. Tax figures are a draft until you approve them yourself.",
    ],
  },
  {
    heading: "What is stored",
    items: [
      "Your conversations (visible only to you; archiving hides them but keeps them) with the text of each question and answer and a short record of which lookups were used, never the looked-up rows themselves.",
      "Memory notes you add on this page or save from an assistant suggestion, shared by the household with the author's first name. Here, memory means this app's own database, not any developer tool.",
      "Counts of questions and tokens used, for the daily limit. No text.",
      "Your questions and the data the assistant looks up are sent to Anthropic to produce each answer.",
    ],
  },
];

/** Every string in the notice, for tests. */
export function noticeText(): string {
  return ASSISTANT_NOTICE.flatMap((s) => [s.heading, ...s.items]).join("\n");
}
