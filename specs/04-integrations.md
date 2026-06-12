# 04 — Integrations & Security

## Institutions to connect

TD Bank, Jewett City Savings Bank, Capital One, Barclays (incl. JetBlue card), PennyMac, plus QuickBooks Checking, Betterment, Northwestern Mutual.

## Strategy: Plaid first, with graceful fallbacks

Use **Plaid** (Transactions, Auth, Liabilities, Investments products) as the aggregation layer. The owner explicitly wants automated, real-time data — monthly statement uploads are a fallback, not the design.

**Do not assume institution coverage.** At build time, query Plaid's institution search for each institution above and record actual support. Expected realities to plan for (verify, don't trust this table blindly):

| Institution | Expectation | Fallback if unsupported/unreliable |
|---|---|---|
| TD Bank | Major bank; typically supported via OAuth | CSV/OFX import |
| Capital One | Supported via OAuth | CSV import |
| Barclays US (both the "Barclay" card and the JetBlue card — owner-confirmed same issuer, one login) | Coverage historically inconsistent for Barclays US cards — verify | CSV import |
| Jewett City Savings Bank | Small CT community bank; many community banks are covered via their core providers, but verify | CSV/OFX import (must be first-class — this is the business operating account) |
| PennyMac | Mortgage servicers vary; check Liabilities coverage | Manual monthly balance/payment entry |
| Betterment | Check Investments coverage | Manual balance entry |
| Northwestern Mutual | Insurance/policy data generally NOT available via aggregators | Document upload + manual policy data entry |
| QuickBooks Checking | Verify | CSV export from QuickBooks |

Every account must work in one of three modes (per-account setting): `plaid`, `manual_import` (CSV/OFX/QFX with a column-mapping wizard and dedupe), or `manual_entry`. Mode is switchable without data loss.

## Plaid implementation requirements

- Link flow with update mode for expired credentials; webhook-driven transaction sync (`/transactions/sync`); handle `ITEM_LOGIN_REQUIRED` by notifying the user to re-link.
- Store only Plaid access tokens (encrypted, e.g., via KMS/at-rest encryption + app-layer encryption). Never store bank credentials. Never log tokens or full account numbers.
- Dedupe by `plaid_transaction_id`; reconcile pending → posted transitions.
- Map Plaid accounts to existing seeded accounts by mask (e.g., x2566) with user confirmation.

## Airbnb

No Plaid coverage. Revenue arrives as deposits into JCSB x0626. Additionally support uploading Airbnb CSV earnings exports to break deposits into gross payout, cleaning fees, and Airbnb service-fee components for accurate P&L. Do not scrape Airbnb.

## Security baseline

- Auth: email + password with MFA (TOTP), or managed auth (e.g., Auth.js with passkeys / Clerk). Two accounts only (Eric, Eva); invite-only.
- All traffic TLS; secrets in env/secret manager, never in repo.
- Encrypt at rest: Plaid tokens, document files, any stored account metadata.
- Row-level safety: every query scoped to the household; no public endpoints.
- Audit log for logins, account linking, data exports, and transaction edits.
- Backups: automated daily DB backups + object-storage versioning for documents (tax data is irreplaceable).
- Session security: short-lived JWT/session cookies, revocation on password change.
- Push notifications must never contain full account numbers or balances beyond what the user opts into.
