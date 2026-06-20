/**
 * Local-model dispatch for Codex workers (#shore-up-1, 2026-06-20).
 *
 * Codex CLI 0.130.0 ships first-class local support: `--oss --local-provider
 * {ollama|lmstudio} --model <name>` runs a worker against a model on the
 * operator's own machine — zero cloud, zero per-token cost. That's the headline
 * for the BYOK / local-model developer: dispatch your agents to YOUR models.
 *
 * We carry the choice through o8's existing `model` field (no new plumbing) with
 * a tiny convention: a model string of the form `ollama:<model>` or
 * `lmstudio:<model>` means "run this locally". Anything else is a normal
 * (cloud) model name passed straight through as `--model`.
 *
 * Scoped to o8-DISPATCHED workers only — it's built into the worker launch args,
 * so the operator's interactive Codex.app is never touched (same philosophy as
 * the image-tool disable).
 *
 * Examples:
 *   ollama:qwen2.5-coder:32b  → --oss --local-provider ollama  --model qwen2.5-coder:32b
 *   lmstudio:qwen2.5-coder    → --oss --local-provider lmstudio --model qwen2.5-coder
 *   gpt-5.5                    → --model gpt-5.5
 *   (empty)                    → []  (Codex falls back to its own configured default)
 */

export type LocalProvider = 'ollama' | 'lmstudio';

const LOCAL_PREFIXES: Record<string, LocalProvider> = {
  ollama: 'ollama',
  lmstudio: 'lmstudio',
};

/**
 * Parse a `provider:model` local-dispatch string. Returns null for a normal
 * cloud model name (or empty input). Splits on the FIRST colon only, so Ollama
 * tag names that contain colons (e.g. `qwen2.5-coder:32b`) survive intact.
 */
export function parseLocalModel(model: string | undefined | null): { provider: LocalProvider; model: string } | null {
  if (!model) return null;
  const trimmed = model.trim();
  const idx = trimmed.indexOf(':');
  if (idx <= 0) return null;
  const provider = LOCAL_PREFIXES[trimmed.slice(0, idx).toLowerCase()];
  if (!provider) return null;
  const rest = trimmed.slice(idx + 1).trim();
  if (!rest) return null;
  return { provider, model: rest };
}

/**
 * Build the Codex `exec` model flags for a model string. Local strings expand to
 * the `--oss --local-provider` form; cloud strings to `--model`; empty to [].
 */
export function codexModelArgs(model: string | undefined | null): string[] {
  const local = parseLocalModel(model);
  if (local) {
    return ['--oss', '--local-provider', local.provider, '--model', local.model];
  }
  const trimmed = model?.trim();
  return trimmed ? ['--model', trimmed] : [];
}
