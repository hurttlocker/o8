---
name: o8-checks
description: Choose or run verification for code, process seams, authorization, persistence, or documentation changes.
---

# Verification

- Every code change runs `npx tsc --noEmit` and the hermetic `npm test` completion gate. Run the
  smallest relevant tests while iterating, and use integration or Rust tests when the changed
  boundary requires them. Docs-only changes validate links and the affected documentation checks.

- New cross-process seams, prompt-taught arguments, persistence paths, and principal or authorization
  changes need a test through the real entry point and persisted state. Helper-only tests are not
  reachability proof.

- Run `npm run rule-check -- --base=<ref>` for changed TypeScript or TSX and ESLint only on touched
  files. Read `.github/workflows/ci.yml` before describing current CI.
