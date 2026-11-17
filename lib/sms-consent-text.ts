// Client-safe wording for the SMS consent card and the /privacy "Text Messages (SMS)" section (twilio-sms-consent).
//
// String constants ONLY: no `node:*`, no database, no server modules (a guard test pins it), so both the client card and the
// public privacy page can import this file. Changing SMS_CONSENT_TEXT requires bumping SMS_CONSENT_VERSION: a test pins the
// version and the sha256 of the exact wording, and every consent row records both.

/** The exact checkbox wording a person agrees to (one sentence group, shown verbatim as the checkbox label). */
export const SMS_CONSENT_TEXT =
  "Send me text messages about transactions assigned to me for review. Message frequency varies (usually under 10/month). Msg & data rates may apply. Reply STOP to opt out, HELP for help.";

/** Version of SMS_CONSENT_TEXT; bump it whenever the wording changes. */
export const SMS_CONSENT_VERSION = "2026-11-v1";

/**
 * The text sent right after a person opts in on the Settings page (and the START reply set in the Twilio console). It names
 * the brand, frequency, rates, HELP and STOP, and fits one 160-character GSM-7 segment (a test pins both).
 */
export const SMS_OPT_IN_CONFIRMATION_TEXT =
  "Banana Stand: You're signed up for review alerts. Msg freq varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";

export const SMS_OPTIONAL_TEXT = "Text messages are optional. Consent is not a condition of using Banana Stand.";

export const SMS_NOT_SET_UP_TEXT = "Text messages are not set up yet.";

export const SMS_READ_FAILED_TEXT = "Text message settings could not be read right now.";

export const SMS_PRIVACY_HREF = "/privacy#text-messages";

/** Sentences of the /privacy "Text Messages (SMS)" section (the page renders these constants; a test pins both). */
export const PRIVACY_SMS_WHAT =
  "If you opt in on the Settings > Notifications page, Banana Stand sends text messages about transactions assigned to you for review, and a reminder when an assigned review is still waiting.";
export const PRIVACY_SMS_FREQUENCY = "Message frequency varies (usually under 10 per month).";
export const PRIVACY_SMS_RATES = "Message and data rates may apply.";
export const PRIVACY_SMS_STOP_HELP =
  "Reply STOP to any message to opt out, or turn texts off on the Settings > Notifications page. Reply HELP for help, or contact us (see Contact below).";
export const PRIVACY_SMS_OPTIONAL =
  "Consent to receive text messages is optional and is not a condition of using the application.";
export const PRIVACY_SMS_PROVIDER =
  "Text messages are delivered by our messaging provider, Twilio, which receives your mobile number and the message only to deliver it.";
export const PRIVACY_SMS_NO_SHARING =
  "Mobile numbers and SMS opt-in consent are never shared with or sold to third parties or affiliates for marketing purposes.";
export const PRIVACY_SMS_RECORDS =
  "When you opt in or out we keep a record of it (the number, the date and the wording you agreed to).";

/** In the order the privacy page shows them. */
export const PRIVACY_SMS_STATEMENTS = [
  PRIVACY_SMS_WHAT,
  PRIVACY_SMS_FREQUENCY,
  PRIVACY_SMS_RATES,
  PRIVACY_SMS_STOP_HELP,
  PRIVACY_SMS_OPTIONAL,
  PRIVACY_SMS_PROVIDER,
  PRIVACY_SMS_NO_SHARING,
  PRIVACY_SMS_RECORDS,
] as const;
