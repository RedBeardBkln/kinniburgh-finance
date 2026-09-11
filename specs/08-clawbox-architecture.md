# 08 — ClawBox Architecture (Local-Only Sensitive Data)

Added after the owner ordered a ClawBox (ID Robots; NVIDIA Jetson Orin Nano Super, 8GB unified memory, 67 TOPS, 512GB NVMe, running "OpenClaw OS") to keep the most sensitive records — Vault entries, tax filings, insurance policy paperwork — off cloud infrastructure, while the rest of the app stays as specced in `06-build-plan.md`. This is a **migration of an already-built feature**: the Vault (`app/vault/*`, `actions/vault.ts`, `lib/vault-session.ts`, `VaultEntry`/`VaultOtp`/`VaultSession` in the schema) and the document/insurance models (`Document`, `InsurancePolicy`) already exist and are live on Supabase (migrations `20260623163544_vault`, `20260624000000_vault_otp_attempts`). Nothing below is new product surface — it's where that data and code physically run.

**Vendor note:** ID Robots is a small, recently-launched hardware maker. Most of what's publicly written about ClawBox traces back to a handful of promotional pages rather than independent long-term reviews. Treat the box as best-effort personal infrastructure, not something with an established support/reliability track record — the backup plan below is not optional because of this.

## Scope decision (owner-confirmed Aug 2026)

1. **Moves local (ClawBox):** the Vault subsystem (`VaultEntry`, `VaultOtp`, `VaultSession`) and the document vault (`Document`, `InsurancePolicy` rows, plus the underlying files — tax filings, NWM policy paperwork, statements, extension confirmations, property tax bills, 1098s, solar loan statements, Airbnb annual summaries per spec 03 §2).
2. **Stays cloud (Supabase/Vercel/Plaid), unchanged from spec 06:** everything else — accounts, transactions, budgets, entities, tags, projects/goals, business GL, notifications. There is no local-only way to get live Plaid transaction feeds, so this half of the app was never a candidate for the ClawBox.
3. **AI is hybrid:** local models on the ClawBox (via OpenClaw's Ollama/llama.cpp support) handle anything that touches Vault or Document contents. Claude (cloud) keeps handling everything else — coding work on the main app, budget/forecast narrative, tax-workspace drafting — but must never receive raw Vault field values, Document files, or Document `extractionData`. That's the operative privacy boundary, not "no cloud AI at all."
4. **Remote access is required** (both Eric and Eva need it away from home), so the box cannot be home-network-only. See "Remote access" below — this is the one area where "no sensitive data leaves the house" needs a real trade-off, spelled out rather than glossed over.

## Data split

| Model | Where it lives | Notes |
|---|---|---|
| `VaultEntry`, `VaultOtp`, `VaultSession` | ClawBox Postgres | Not tax-relevant — no archive-only constraint from spec 04 rule 7. Safe to fully migrate and drop from Supabase once verified. |
| `Document`, `InsurancePolicy` | ClawBox Postgres + ClawBox-local file storage | **Tax-relevant — spec 04 ground rule 7 (never hard-delete) applies wherever these rows live.** Migration must archive, not delete, the Supabase-side copies. |
| Document file blobs (`fileKey`) | ClawBox-attached 5TB external HD, encrypted at rest | Currently spec'd as S3-compatible cloud storage (spec 06). For this subset, move to the EHD rather than the 512GB NVMe — keeps the NVMe free for OS/Postgres/model weights and gives far more headroom than these files will ever need. See "Backups." |
| Everything else in spec 01 | Supabase, unchanged | No change. |

## Vault + Documents as a separate deployment

Don't proxy Vault/Document reads through the Vercel-hosted app. Run the existing Vault + Documents routes as their **own small Next.js deployment on the ClawBox**, using the same Prisma schema subset and the same encryption code (`lib/encrypt.ts`) already written. Reasons:

- Decryption then happens on the box, not in a Vercel function — decrypted Vault/Document content never transits Vercel or Supabase at all.
- The existing OTP/session gate (`VaultOtp`, `VaultSession`) keeps working unmodified; it's already independent of the main NextAuth session.
- Avoids building and maintaining a proxy/API layer in the main app just to forward requests somewhere else.

The main app (Vercel) keeps a "Vault" nav entry that links out to the ClawBox deployment rather than rendering it inline.

**Auth handoff (resolved Sep 2026) — server-to-server code exchange, not a bearer token in the URL:**

A JWT (or any signed token) placed directly in a redirect URL sits in browser history, the Referer header, and Tailscale Funnel/proxy access logs — avoid that for anything gating Vault access. Use a one-time opaque code instead:

1. User clicks "Vault" in the main app (already has a valid NextAuth session). A server action (`actions/clawbox-handoff.ts`) generates a random opaque code (e.g. 32 bytes, `crypto.randomBytes`), stores `{ code, userId, expiresAt: now + 60s, used: false }` server-side (a new `ClawboxHandoffCode` table in the existing Supabase Postgres — tiny, ephemeral, not tax-relevant, fine to prune aggressively), and redirects the browser to `https://<clawbox-funnel-host>/handoff?code=<code>`.
2. The ClawBox deployment's `/handoff` route takes that code and calls back **server-to-server** (ClawBox → Vercel, over HTTPS, not through the browser) to a small verification endpoint on the main app (e.g. `POST /api/clawbox/verify-handoff`), authenticated with a static shared secret (new env var `CLAWBOX_HANDOFF_SECRET`, present on both sides). That endpoint checks the code exists, is unused, and is unexpired, marks it used (single-use — replay of an intercepted URL fails), and returns `{ userId }`.
3. The ClawBox deployment now knows *which* of the two household users (Eric or Eva) is arriving, and sets a short-lived "identified" cookie scoped to the ClawBox domain — but this only pre-fills/attributes the session. **It does not grant Vault access.** The existing OTP step (`VaultOtp`/`VaultSession`) still runs exactly as it does today; the handoff only saves the user from re-entering credentials for an identity the main app already verified moments ago.
4. Codes expire in 60 seconds and are single-use, so a leaked/copied handoff URL is worthless almost immediately and can't be replayed.

This reuses infrastructure that already exists (Supabase Postgres, a server action, a fetch call) rather than introducing a JWT library or new signing/rotation story for `CLAWBOX_HANDOFF_SECRET` beyond "a long random value in both `.env` files."

## Extraction/OCR: local only for Document/InsurancePolicy

The `Document` model's `extractionModel`/`extractionData` fields currently assume Claude's vision API (per the schema comment: "structured output from Claude extraction") — that was written before this scope decision and now conflicts with it. For `Document`/`InsurancePolicy` records specifically, extraction must run on the ClawBox against a local model, not Claude's cloud vision API.

**Viability (researched Sep 2026) — likely workable, confirm with real documents before relying on it:** Jetson Orin Nano Super's 8GB unified memory comfortably runs vision-language models in the ~3–4B parameter range (e.g. Qwen2.5-VL-3B, VILA 1.5-3B, Gemma 3/4B) via Ollama/llama.cpp — this combination is well documented in NVIDIA's own Jetson AI Lab model catalog and community tutorials, not experimental. Qwen2.5-VL-3B scores competitively on OCR benchmarks (OCRBench 810, DocVQA_VAL 92.71) and per Qwen's own reporting has been fine-tuned specifically on tax-form/receipt/invoice corpora including handwriting. **Plan:** start with Qwen2.5-VL-3B as the default local extraction model; keep the NVMe free by storing model weights on the EHD (see below). Still expect materially more manual correction than the Claude-vision path used elsewhere (e.g., receipts in Phase 4, which are not sensitive-subset data and can keep using Claude vision as spec'd) — validate against a batch of the owner's actual scanned tax documents during implementation before treating extraction output as reliable. If accuracy is unacceptable even after trying 1–2 alternative models, the fallback is manual data entry for Document/InsurancePolicy metadata with the scanned file still stored locally — not silently falling back to sending the file to a cloud API.

## Remote access: Tailscale Funnel (owner-decided Sep 2026)

Vercel functions are serverless/ephemeral — they can't hold an open WireGuard connection into a private Tailscale network the way a persistent server could. That rules out "just put both apps on the same tailnet" as a clean answer.

**Decision: Tailscale Funnel.** The ClawBox deployment gets exposed as a normal HTTPS URL (on Tailscale's own TLS cert) reachable from any browser, including from the main Vercel app on click-through. Eric and Eva don't need the Tailscale app installed on every device. The explicit trade-off the owner accepted: that URL is technically reachable from the public internet, so security rests on the OTP/session gate plus the handoff mechanism above (single-use, 60s-expiry code + shared-secret server-to-server verification) plus a strong Funnel-side bearer/allowlist if Tailscale supports one — not on network isolation. This is a meaningfully different privacy posture than "purely local," and it's why the auth handoff and OTP burn-after-5-failures behavior both matter more than they would on a tailnet-only setup.

(The tailnet-only alternative — no public URL, but Tailscale client required on every device, and unreachable from the Vercel app on the user's behalf — was considered and explicitly not chosen.)

## Backups

The owner has a 5TB external hard drive (EHD) attached to the ClawBox for exactly this purpose. That resolves the previous open question of "what's the backup target" for drive-level failure — but it's worth being precise about what it does and doesn't cover against spec 04's existing requirement ("automated daily DB backups + object-storage versioning for documents (tax data is irreplaceable)").

**Covers:** the NVMe (or wherever live data sits) failing. Automated nightly Postgres dumps (ClawBox Postgres → EHD) and a versioned copy of Document file blobs, both encrypted at rest on the EHD, give real recovery from a drive failure — the most common failure mode for a single small device.

**Encryption + retention (decided Sep 2026):** LUKS2 (`aes-xts-plain64`) full-disk encryption on the EHD, unlocked at boot via a keyfile stored on the ClawBox's NVMe (not typed interactively — this is a headless box) and mounted by a systemd unit before the backup timers run. Nightly Postgres dumps and Document blob snapshots are retained **30 daily snapshots + 12 monthly snapshots**, pruned automatically by a nightly systemd timer script. 5TB gives enormous headroom for this: even decades of tax filings, scanned policies, and daily DB dumps for a two-person household will likely total well under 100GB, so there's no real capacity pressure forcing tighter retention.

**Does not cover — accepted risk (owner-decided Sep 2026):** the ClawBox and EHD are physically the same location — fire, theft, or flood takes out both at once. Spec 04's "tax data is irreplaceable" language was written assuming cloud object-storage versioning, which is inherently off-site; an EHD sitting next to the box isn't equivalent to that. **The owner has decided not to add a third, off-site backup copy for now** (no encrypted-cloud export, no second drive stored elsewhere) — single-location risk is accepted, revisit later if the calculus changes.

## Using the 5TB EHD beyond backups

5TB is far more than the Vault/Document data itself will ever need — worth putting the spare capacity to use rather than letting it sit idle:

- **Backup target** (above) — the primary use.
- **Local model weight storage.** Local LLM/vision model files (Qwen2.5-VL-3B and any alternates tried per "Extraction/OCR" above) run several GB each; storing them on the EHD instead of the 512GB NVMe keeps the NVMe free for the OS, the Postgres data directory, and active inference working space.
- **Full Supabase mirror (owner-decided Sep 2026 — in scope):** the owner has opted to also mirror the *entire* Supabase database (all transactions, budgets, entities, tags, business GL — not just the ClawBox-hosted Vault/Document subset) to the EHD as an extra backup layer, beyond the original sensitive-subset-only decision. Implementation: a nightly `pg_dump` of the Supabase database, transferred to the ClawBox over the same Tailscale connection used for remote access (no need to expose Supabase credentials outside the tailnet) and written to the same LUKS-encrypted EHD volume, under the same 30-daily/12-monthly retention as the ClawBox-native backups. This is purely an extra recovery copy — Supabase remains the live source of truth for that data; nothing about spec 06's cloud architecture changes.

## Failure mode: ClawBox offline

The box is one small device on home power/internet. When it's off or unreachable (outage, reboot, hardware fault), Vault and Documents should fail gracefully — those specific pages/nav entries show "temporarily unavailable," not a main-app-wide error. This needs to be an explicit design/test case, not an assumption.

## Migration plan for existing data

`VaultEntry`/`VaultOtp`/`VaultSession` and `Document`/`InsurancePolicy` rows (plus files) currently live on Supabase already. Migration is: stand up Postgres + file storage on the ClawBox, copy the data across, verify row counts and decrypt/re-encrypt correctly, cut the ClawBox deployment over, confirm it works end-to-end (including the OTP flow) — and only then deal with the Supabase-side originals. Per spec 04 ground rule 7, the `Document`/`InsurancePolicy` rows on Supabase get **archived (`archivedAt` set), never hard-deleted**, even after a verified migration. `VaultEntry` rows are not tax-relevant and may be fully removed from Supabase once the migration is confirmed.

## Resolved items (previously "Open items," closed Sep 2026)

1. **Remote access:** Tailscale Funnel — owner decision, see "Remote access" above.
2. **Local vision model viability:** researched, likely viable — Qwen2.5-VL-3B on Ollama, see "Extraction/OCR" above. Final confirmation still requires testing against the owner's actual scanned documents during implementation (not closeable from research alone).
3. **Auth handoff mechanism:** designed — single-use opaque code + server-to-server verification, see "Auth handoff" above.
4. **Tailscale on OpenClaw OS's JetPack 6.2/Ubuntu 22.04 (L4T R36.x) base:** confirmed compatible — Tailscale's official Linux install supports arm64 generically, JetPack 6.2 ships a standard Ubuntu 22.04 (Jammy) arm64 userland, and Jetson+Tailscale is a documented community pattern. Do one smoke-test install early in implementation (confirm the kernel's WireGuard/`tun` support is present in this specific OpenClaw OS image) before relying on it — a quick check, not an open design question anymore.
5. **EHD encryption + retention schedule:** decided — LUKS2 + keyfile unlock, 30 daily / 12 monthly snapshots, see "Backups" above.
6. **Off-site third backup copy / full Supabase mirror:** owner decided — no off-site third copy for now (single-location risk accepted); yes to a full Supabase mirror on the EHD (scope extension accepted), see "Backups" and "Using the 5TB EHD beyond backups" above.
