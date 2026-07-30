Decompose `{{targetFile}}` ({{lineCount}} lines) into smaller modules, each under {{ceiling}} lines. This is a PURE refactor — ZERO functional changes.

## Context

The file crossed the {{ceiling}}-line ceiling after merge `{{postMergeSha}}` (diff vs parent confirmed new lines were added). The governance pipeline caught this and enqueued a LOW-PRIORITY maintenance packet because the merge that triggered this scan is already landed.

Runtimes with proactive structural-review behavior typically decompose during review, so this scan finds nothing. For runtimes that benefit from explicit decomposition instructions, this packet IS the primary enforcement. Treat every run as the only thing standing between main and unmaintainable sprawl.

## Approach

1. Read the entire file first to understand its shape and public surface. Do not write anything until you have a clear extraction map.
2. Identify natural extraction boundaries — custom hooks, subcomponents, pure utilities, types/constants, data-fetching helpers.
3. Create new files in a sibling directory matching the file's role:
   - Components: `src/components/<area>/<feature>/<submodule>.tsx`
   - Libs: `src/lib/<domain>/<submodule>.ts`
   - Hooks: co-located with the component that owns them, in a `hooks/` subdirectory when there are multiple.
4. Keep the original file as the public surface — **import sites MUST NOT change**. Re-export from the original path if needed.
5. Private types/utilities travel with the module that owns them. Only shared contracts stay at the original path.

## Invariants (these are the platform's rules, not suggestions)

- Inline styles only — never className. iOS Safari reliability rule, enforced globally.
- Longhand padding properties (`paddingTop`, `paddingLeft`) only. CSS shorthand is banned.
- No emoji in code, comments, or commit messages.
- Raw SVG in the Tauri webview — no `lucide-react` or `@phosphor-icons/react` direct imports inside `src/components/desktop`. Use the existing shim pattern.
- **Every new file must also stay under {{ceiling}} lines.** If a single extraction would still produce an over-ceiling module, decompose further before writing.
- Path aliases: `@/*` maps to `./src/*`.
- No hardcoded ports (3001 / 3002) or absolute home paths. Use `process.env`, `os.homedir()`, or an explicit env var.

## Verification (acceptance gates)

Before reporting completion, all of these must pass:

1. `{{targetFile}}` drops under {{ceiling}} lines (run `wc -l {{targetFile}}`).
2. Every new file you created is also under {{ceiling}} lines.
3. `npx tsc --noEmit` passes with zero errors.
4. `npm run rule-check` passes with zero violations.
5. No behavioural changes — every externally-observable UI, API, or store outcome is identical before and after. If you cannot rule this out by reading, keep the diff surgical and flag it in the commit body.

## Commit

Single commit with message `refactor: decompose {{basename}} into modules`. Stage files individually; do not use `git add -A`.

## Escape hatch

If the file genuinely cannot be decomposed (e.g. a tightly-coupled state machine with no natural seams, a layout orchestrator whose whole point is the wiring), stop and leave a short explanation as your final message. Do not force unnatural splits — the pipeline will archive the packet as `failed` and the operator can decide whether to add a waiver. Do not touch `FILE_SIZE_WAIVERS` yourself.

The main lane that triggered this scan is already merged and will not be rolled back regardless of your outcome. This packet is best-effort cleanup, not a merge gate.
