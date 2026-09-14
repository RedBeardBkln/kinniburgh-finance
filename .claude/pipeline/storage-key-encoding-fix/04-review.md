# Review — storage-key-encoding-fix

## Verdict: APPROVED

## What I checked (independently, not just the write-ups)

- Read `00-request.md`, `02-implementation.md`, `03-test-report.md` (Tester: PASS) in full.
- Read the full current `lib/supabase-storage.ts` (289 lines) fresh, not a diff-only view.
- Read the full `git diff` for `lib/supabase-storage.ts`.
- Read all 8 new tests plus the 6 pre-existing tests in `lib/__tests__/supabase-storage.test.ts`.
- Re-ran `pnpm typecheck`, `pnpm lint`, `pnpm test` myself.
- Ran `git status --porcelain` and `git diff --stat` to check scope.
- Grepped the whole repo for `encodeURIComponent` to confirm no stray whole-key occurrences remain.

## Correctness

`encodeStoragePath()` (`key.split("/").map(encodeURIComponent).join("/")`) is defined once, directly after `getStorageConfig()`, with a comment that correctly explains the root cause and cites the production confirmation date. Confirmed by direct read (not grep alone) that all 6 call sites use it:

1. `uploadFile` (line 88) — previously had **no encoding at all** on `fileKey`; now fixed. This is the Coder's one deviation beyond the request doc's named 5, and it's correctly justified (same shared helper, no realistic-key regression risk, closes a real latent gap on the upload path).
2. `downloadFile` (line 107)
3. `getSignedUploadUrl` (line 127)
4. `getReceiptSignedUrl` (line 150)
5. `getPaystubSignedUrl` (line 184)
6. `getTaxSignedUrl` (line 230)

Repo-wide grep for `encodeURIComponent` outside the helper: zero matches in any `.ts` source file — the only hits are the helper's own `.map(encodeURIComponent)` call, its comment, and one comment line in the test file describing the historical bug. Matches both the Coder's and Tester's claims exactly.

## Composes correctly with the two earlier same-day fixes

Read the full file (not just this diff) specifically to check this, per the task brief:

- **Bucket-routing dispatch** (`getDocumentFileSignedUrl` / `downloadDocumentFile`, lines 278–288): still present, unchanged by this diff, dispatches on `taxes/` / `statements/` prefix to the tax-bucket functions and falls back to receipts. Both branches call functions (`getTaxSignedUrl`, `getReceiptSignedUrl`, `downloadTaxFile`, `downloadReceiptFile`) that now correctly use `encodeStoragePath` internally, so the routing fix and the encoding fix compose cleanly — routing decides *which* function runs, encoding decides *how that function's URL is built*, no overlap or conflict.
- **`taxes/` prefix no longer stripped**: the large comment block above the routing functions (lines 249–277) still documents the "do NOT strip" invariant from the prior fix, and no stripping logic exists anywhere in the current file. The new encoding fix doesn't touch key *construction* at all (per the request doc's explicit instruction), only how an already-correct key gets percent-encoded into the URL — verified this boundary was respected.

All three same-day fixes compose into one coherent, currently-correct file.

## Test quality

The 8 new tests in the `"per-segment path encoding"` block are meaningful, not tautological:
- Each mocks `global.fetch` and asserts on the **raw, non-decoded** constructed URL (`expect(url).toContain(...)` with a literal `/`, plus `expect(url).not.toContain("%2F")`), which is exactly what would have caught the original bug — the 6 pre-existing tests use `decodeURIComponent(url)` and would not have (I traced through each: if `encodeStoragePath` were reverted, `%2F` would appear in the raw URL and every `not.toContain("%2F")` assertion would fail).
- One test (`"still percent-encodes non-slash special characters within a segment"`) proves per-segment encoding, not "encode nothing" — a space in a segment still becomes `%20` while surrounding `/` stay literal. This is the right check to rule out the naive "just stop encoding" false fix.
- I manually verified each test's expected URL against the actual code path (bucket constants, routing functions) rather than trusting the assertions blindly — all match the real function behavior exactly (e.g. `getTaxSignedUrl("taxes/e1/d1.pdf")` correctly produces the redundant nested `/object/sign/taxes/taxes/e1/d1.pdf` path, matching the documented "do not strip" behavior from the prior fix).

**Gap, non-blocking**: `uploadFile` (the 6th, previously-unencoded call site) has no direct unit test asserting its raw request path. It's not trivially mockable the same way (it uses `node:https` via `httpsPost`, not `global.fetch`), which likely explains the omission. Risk is low since it calls the exact same, well-tested `encodeStoragePath` helper as the other 5 sites — but it's the one call site this diff changed behaviorally the most (no encoding → per-segment encoding) and it's the only one with zero direct test coverage. Worth a follow-up test using a `node:https` mock if this file gets touched again, not worth blocking on today given the low realistic risk and the live verification below.

## Live verification (Tester's claims)

The Tester's report is specific enough to trust: real entity/document UUIDs, a `Storage.list()`-sourced byte count cross-checked against `content-length` on the GET, and a positive/negative control (old buggy logic reproducing the exact `sign=200/get=400 InvalidSignature` from the original bug report, run against the same real objects as the fix). Notably, one of the three sampled byte counts (514586, the w2 document) matches the number already cited in `00-request.md`'s own root-cause section — consistent with the Tester actually re-running against the same real object the orchestrator originally found the bug on, not fabricating numbers. The receipt/paystub finding (real fileKeys are flat, no `/`, so old and new code are byte-identical there today) is a corrected scope claim, not a defect, and is reported as such rather than glossed over — appropriately transparent.

## Command re-verification (independent)

- `pnpm typecheck` — clean, no output.
- `pnpm lint` — 0 errors, 43 warnings, all in files untouched by this diff (spot-checked the list — matches the Coder's/Tester's claimed baseline).
- `pnpm test` — **435/435 passed, 37 files**, matches claims exactly.

## Scope

`git status --porcelain` and `git diff --stat` confirm exactly two files changed: `lib/supabase-storage.ts` (+26/-7) and `lib/__tests__/supabase-storage.test.ts` (+123 lines, additive only). No unrelated files. The other untracked paths in git status (`.claude/agent-memory/`, `.claude/agents/`, `.claude/commands/`, other pipeline dirs, `pnpm-workspace.yaml`) predate this task and are unrelated infrastructure, not scope creep from this change.

## What's good

- The Coder re-derived the current file state from scratch rather than trusting prior task descriptions, exactly as the request doc demanded for a third same-day fix to this file — and caught a 6th, previously-undocumented unencoded call site (`uploadFile`) beyond the request doc's named 5, with a specific, low-risk justification for including it.
- The Coder's own verification methodology (temporarily reverting the fix via `sed`, confirming the new tests fail and the old tests don't, then restoring) is a genuinely strong regression-proof step, not just "tests pass."
- The Tester correctly identified that the pre-existing 6 tests used `decodeURIComponent` and could never have caught this bug, and built the new tests around the actual production failure mode (raw URL `%2F`) instead of a superficial check.
- The Tester's live round-trip test is real proof (byte-exact content match, real negative control), and the file's central bucket-routing comment block continues to serve as living documentation of the three prefixes and their upload/read agreement — good practice this repo has now converged on after three same-day fixes.

No blocking findings. Routing not applicable (approved).
