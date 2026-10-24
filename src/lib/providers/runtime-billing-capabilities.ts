const unavailable: Record<string, { label: string; issue: number; code: string }> = {
  codex: { label: 'Codex', issue: 4334, code: 'CODEX_API_BILLING_UNAVAILABLE' },
  hermes: { label: 'Hermes', issue: 4340, code: 'RUNTIME_FILE_API_BILLING_UNAVAILABLE' },
  openclaw: { label: 'OpenClaw', issue: 4340, code: 'RUNTIME_FILE_API_BILLING_UNAVAILABLE' },
  acp: { label: 'generic ACP', issue: 4340, code: 'RUNTIME_FILE_API_BILLING_UNAVAILABLE' },
};

/** A transport identity alone does not establish an environment-auth contract. */
export function runtimeApiBillingUnavailable(runtimeId: string) {
  const entry = Object.hasOwn(unavailable, runtimeId) ? unavailable[runtimeId] : undefined;
  return entry ? { ...entry, error: `API billing for ${entry.label} is not available yet. See #${entry.issue}.`, url: `https://github.com/hurttlocker/o8/issues/${entry.issue}` } : null;
}
