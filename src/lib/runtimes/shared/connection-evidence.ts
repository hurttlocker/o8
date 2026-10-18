/** Safe connection observations only: never tokens, raw CLI output or profile paths. */
export type ConnectionSource = 'cli_report' | 'credential_file' | 'credential_store' | 'environment' | 'runtime_config';
export interface ConnectionObservation {
  source: ConnectionSource;
  outcome: 'present' | 'absent' | 'unknown' | 'configured';
}
export interface RuntimeConnectionEvidence {
  state: 'observed' | 'configured' | 'indeterminate' | 'not_connected' | 'not_installed';
  providers: string[];
  observations: ConnectionObservation[];
  checkedAt: number;
  account: 'not_reported';
  externalTools: 'not_inspected';
}

export function connectionEvidence(
  providers: string[], observations: ConnectionObservation[], checkedAt = Date.now(),
): RuntimeConnectionEvidence {
  return {
    state: observations.some(item => item.outcome === 'present') ? 'observed'
      : observations.some(item => item.outcome === 'configured') ? 'configured'
      : observations.some(item => item.source === 'cli_report' && item.outcome === 'absent') ? 'not_connected'
      : 'indeterminate',
    providers: [...new Set(providers.filter(id => /^[a-z][a-z0-9 _.-]{0,63}$/i.test(id)))].sort(), observations, checkedAt,
    account: 'not_reported', externalTools: 'not_inspected',
  };
}

export function runtimeConnection(status?: {
  installed: boolean; checkedAt: number; connection?: RuntimeConnectionEvidence;
} | null): RuntimeConnectionEvidence {
  const result = status?.connection ?? connectionEvidence([], [], status?.checkedAt ?? 0);
  return status?.installed === false ? { ...result, state: 'not_installed' } : result;
}

export function connectionLabel(connection: RuntimeConnectionEvidence): string {
  switch (connection.state) {
    case 'observed': return 'Connection evidence found';
    case 'configured': return 'Configured route';
    case 'not_connected': return 'CLI reports signed out';
    case 'not_installed': return 'Not installed';
    default: return 'Connection unknown';
  }
}

const SOURCE_LABELS: Record<ConnectionSource, string> = {
  cli_report: 'CLI report', credential_file: 'Credential file', credential_store: 'Runtime credential store',
  environment: 'Environment', runtime_config: 'Runtime configuration',
};
export function connectionDetail(connection: RuntimeConnectionEvidence): string {
  const providers = connection.providers.length ? connection.providers.join(', ') : 'Providers not reported';
  const sources = connection.observations.map(item => `${SOURCE_LABELS[item.source]}: ${item.outcome}`).join(' · ');
  return `${providers}. ${sources || 'Connection evidence not reported'}. Provider access has not been tested.`;
}

/** Project the existing protected status DTO without forwarding defaults or paths. */
export function runtimeConnectionRows(payload: unknown) {
  const rows = (payload as { dispatchableRuntimes?: unknown } | null)?.dispatchableRuntimes;
  if (!Array.isArray(rows)) return { status: 'unavailable' as const, runtimes: [] };
  return { status: 'available' as const, runtimes: rows.map((row: {
    id: string; label: string; available: boolean; connection?: RuntimeConnectionEvidence;
  }) => ({ id: row.id, label: row.label, available: row.available, connection: row.connection ?? null })) };
}

/** Called at the existing local evidence seam; does not perform another probe. */
export function localCredentialEvidence(
  environmentProviders: string[], authenticated: boolean, provider?: string,
  storedSource: 'credential_file' | 'runtime_config' = 'credential_file',
): RuntimeConnectionEvidence {
  return connectionEvidence(environmentProviders.length ? environmentProviders : authenticated && provider ? [provider] : [], [
    { source: 'environment', outcome: environmentProviders.length ? 'present' : 'absent' },
    { source: storedSource, outcome: environmentProviders.length ? 'unknown' : authenticated ? storedSource === 'runtime_config' ? 'configured' : 'present' : 'unknown' },
  ]);
}
