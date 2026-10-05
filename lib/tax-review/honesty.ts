// The words of the "What this review can and cannot do" panel on the Final review page (specs/11, plan 5.12 and section 13). They live
// here, not in the component, so a test can scan them with the wording layer's allow-list (the profession may be NAMED only to say
// the reviewer is not one) and so the page and the spec say the same thing. PURE data.

export const HONESTY_TITLE = "What this review can and cannot do";

export const HONESTY_INTRO =
  "This review is software. It is not a CPA, an enrolled agent or a licensed tax professional, and it cannot guarantee that your return is correct or that it will be accepted. You prepared the return and you decide.";

export const HONESTY_CAN: readonly string[] = [
  "Adds up every total on every form again and checks that a figure carried from one form to another is the same.",
  "Reads the finished PDF forms back and checks that every printed figure is the one the return computed, and that nothing is written where it must stay blank.",
  "Ties the W-2, 1099, 1098 and property-tax documents you verified to the lines they feed.",
  "Lists the choices still open and the printed lines the app does not model, so nothing is left unsaid.",
  "Checks that every form the return needs is in the package and that the final package can be built.",
  "Has an AI model read the computed return and the printed forms and raise questions. It can only add findings; each legal claim is checked by code against the pinned IRS and Connecticut text, or shown as unverified.",
];

export const HONESTY_CANNOT: readonly string[] = [
  "It only sees what is in this app: the documents you uploaded and verified, your answers and the books. It cannot know about income, assets or events that were never entered.",
  "It cannot tell whether a document is complete or genuine, or whether a figure read from it matches the paper. You confirmed that when you verified each document.",
  "Until the independent recalculation and the AI review passes have run for this exact state of the return, the arithmetic with tax rates and the legal positions are not independently checked. The AI model can be wrong or miss something, and its sources are the dated pages shown on this page.",
  "Choices the law leaves to you, such as the home-office method, are listed for you to decide. It does not decide them.",
  "A passed result means that no unresolved flagged item remained. It does not mean the return is right.",
  "You prepared the return and you also accept the findings, so this is an audit trail and a discipline, not an independent control.",
  "It does not file or sign anything, and it does not know about law or IRS guidance that changed after the sources it relies on.",
];

/** Every sentence of the panel, for the wording scan. */
export const HONESTY_ALL: readonly string[] = [HONESTY_TITLE, HONESTY_INTRO, ...HONESTY_CAN, ...HONESTY_CANNOT];
