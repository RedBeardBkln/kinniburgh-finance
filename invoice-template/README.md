# LaunchTime invoice template

Files
- `invoice.template.html` — Handlebars/Mustache template (print-ready, US Letter, loads `logo.png`).
- `invoice.schema.json` — JSON Schema for the data the template expects.
- `sample-data.json` — Invoice 3001 as a working example (renders the template to match the reference PDF).
- `logo.png` — LaunchTime logo (cropped, transparent).

Usage
1. Compile `invoice.template.html` with Handlebars (or any Mustache-compatible engine) and a JSON object matching the schema.
2. Render to PDF with a headless browser (e.g. Puppeteer `page.pdf({format:'Letter', printBackground:true})`). Keep `logo.png` beside the HTML or rewrite its `src`.

Rules for the platform
- Monetary values are pre-formatted strings (e.g. `$2,727.53`). Compute in code: `amount = quantity × rate`; `subtotal = Σ amount`; `total = subtotal − discount − deposit`; `amount_due = total`.
- Optional blocks render only when present: `company.dba`, `company.address_line2`, `company.ein`, `client.address_line2`, `project.description`, `line_items[].unit`, `totals.discount`, `totals.deposit`. Omit or use empty strings to hide.
- `line_items` may be any length; table header repeats and rows don't split across pages.
- Per-client fields: `client.*`, `project.*`, `invoice.*`, `line_items`, `totals`. Company and payment details are normally constant defaults.
- Brand: gold `#D7B418`, navy `#292F49`, Roboto Slab (headings) + Roboto (body), loaded from Google Fonts.
- Sensitive: sample data contains real bank details from the reference invoice; store these in secure config, not in source control.

## How the platform uses this template (EK Consulting invoicing)

The app does not run Handlebars or a headless browser. The design is reproduced in the existing pdf-lib renderer, which keeps the
invoice PDF's safety and pagination guarantees (SSN refusal, the scoped bank-text exception, repeated table header, nothing below the
margin, page numbers, DRAFT / VOID marks):

- `lib/invoicing/pdf/model.ts` lays out the page (template sections, two-column Bill to / Project and Terms / Bank blocks).
- `lib/invoicing/pdf/render.ts` draws it in the template's colours and fonts.
- `data/invoicing/fonts/` holds Roboto and Roboto Slab (Apache 2.0, subset to the Windows-1252 characters the PDF text is limited to);
  `data/invoicing/launchtime-logo.png` is `logo.png`, used when no logo was uploaded in Invoicing settings.

Where the data comes from: `company.*` = the entity name, its dba, the business address and (when ticked) the EIN from Invoicing
settings; `client.*` = the client; `project.title` = the invoice title; `invoice.terms` = the payment terms; `footer_message` = the
footer text in settings; `payment.check_*` = "Checks payable to" and the remit-to address; the Bank / ACH block = the encrypted bank text
from settings, printed only on an invoice with "Print ACH Details" ticked. Write each bank line as `Label: value`
(for example `Routing #: ...`) to get the label / value layout.

Corrections made against the platform's rules:

- `amount_due = total` ignored payments. The PDF shows "Paid" and a "Balance due" once a payment is applied (there are no per-invoice
  deposits; a customer credit is a deposit on account applied as a payment).
- The Bank / ACH block always printed. It now prints only when bank text exists and the invoice opts in.
- `sample-data.json` and `preview.html` carried real bank, EIN and client details; they now hold placeholders. Real values live only in
  the app's encrypted settings.
- The footer used 'Source Serif 4', which the template never loads; the PDF uses Roboto Italic.
- The discount and deposit rows used a Unicode minus sign, outside the PDF's Windows-1252 text; the PDF prints "-".
- Letter spacing is about .07em instead of .12-.18em: wider spacing makes PDF readers extract "I N V O I C E" (breaks copy and search).
