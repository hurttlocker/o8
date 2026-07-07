export function stableThreadTimestampLabel(value: Date | string | number | null | undefined): string {
  const date = value instanceof Date ? value : value != null ? new Date(value) : new Date();
  const safe = Number.isFinite(date.getTime()) ? date : new Date();
  const yyyy = safe.getFullYear();
  const mm = String(safe.getMonth() + 1).padStart(2, '0');
  const dd = String(safe.getDate()).padStart(2, '0');
  const hh = String(safe.getHours()).padStart(2, '0');
  const min = String(safe.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

export function stableOrchestratorThreadTitle(value: Date | string | number | null | undefined): string {
  return `Orchestrator session · ${stableThreadTimestampLabel(value)}`;
}

export function stableOrchestratorThreadTitleForId(
  threadId: string | null | undefined,
  fallback: Date | string | number | null | undefined,
): string {
  const match = typeof threadId === 'string' ? /^thoughts-(\d{10,})/.exec(threadId) : null;
  const timestamp = match ? Number(match[1]) : NaN;
  return stableOrchestratorThreadTitle(Number.isFinite(timestamp) ? timestamp : fallback);
}

export function stableNewThreadTitle(value: Date | string | number | null | undefined): string {
  const date = value instanceof Date ? value : value != null ? new Date(value) : new Date();
  const safe = Number.isFinite(date.getTime()) ? date : new Date();
  const hh = String(safe.getHours()).padStart(2, '0');
  const min = String(safe.getMinutes()).padStart(2, '0');
  return `New thread · ${hh}:${min}`;
}
