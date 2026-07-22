export type PlanProgressStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failure'
  | 'failed'
  | 'skipped';

export interface PlanProgressEvent {
  kind?: 'plan_progress';
  planId?: string;
  taskId?: string;
  stepIndex?: number;
  stepCount?: number;
  status?: PlanProgressStatus;
  summary?: string;
  result?: string;
}

export interface PlanProgressGlint {
  key: string;
  text: string;
  tone: 'progress' | 'success' | 'warning' | 'error';
}

function compactProgressText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 96 ? `${compact.slice(0, 95).trimEnd()}…` : compact;
}

/** Converts a native plan lifecycle event into one stable, replace-in-place dock glint. */
export function formatPlanProgressGlint(event: PlanProgressEvent): PlanProgressGlint | null {
  const planId = compactProgressText(event.planId);
  const status = event.status;
  if (!planId || !status) return null;
  const count = Number.isInteger(event.stepCount) && (event.stepCount ?? 0) > 0
    ? event.stepCount as number
    : 0;
  const index = Number.isInteger(event.stepIndex) && (event.stepIndex ?? 0) > 0
    ? Math.min(event.stepIndex as number, count || event.stepIndex as number)
    : 0;
  const position = index && count ? `${index} of ${count}` : 'Plan';
  const summary = compactProgressText(event.summary);
  const result = compactProgressText(event.result);

  if (status === 'completed') {
    return { key: `plan:${planId}`, text: `${position} · ${result || summary || 'Step complete'}`, tone: 'success' };
  }
  if (status === 'cancelled') {
    const detail = result || summary;
    return { key: `plan:${planId}`, text: `${position} · Stopped${detail ? ` · ${detail}` : ''}`, tone: 'warning' };
  }
  if (status === 'failure' || status === 'failed') {
    const detail = result || summary;
    return { key: `plan:${planId}`, text: `${position} · Failed${detail ? ` · ${detail}` : ''}`, tone: 'error' };
  }
  if (status === 'skipped') {
    return { key: `plan:${planId}`, text: `${position} · Skipped${summary ? ` · ${summary}` : ''}`, tone: 'warning' };
  }
  return { key: `plan:${planId}`, text: `${position} · ${summary || 'Working'}`, tone: 'progress' };
}
