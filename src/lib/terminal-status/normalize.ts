import type { RuntimeId } from '@/lib/runtimes/types';
import type {
  TerminalStatusAuthority,
  TerminalStatusEvidence,
  TerminalStatusState,
} from '@/lib/terminal-status/resolve';

const TERMINAL_STATUS_STATES = new Set<TerminalStatusState>([
  'idle',
  'working',
  'blocked',
  'failed',
  'complete',
  'review-ready',
  'unknown',
]);

const TERMINAL_STATUS_AUTHORITIES = new Set<TerminalStatusAuthority>([
  'runtime-event',
  'lane-state',
  'known-screen-adapter',
  'raw-terminal',
]);

/** Preserve a route-projected record when valid; never manufacture evidence. */
export function normalizeTerminalStatusEvidence(value: unknown): TerminalStatusEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.sessionId !== 'string'
    || !raw.sessionId.trim()
    || typeof raw.runtime !== 'string'
    || !raw.runtime.trim()
    || !TERMINAL_STATUS_STATES.has(raw.state as TerminalStatusState)
    || !TERMINAL_STATUS_AUTHORITIES.has(raw.authority as TerminalStatusAuthority)
    || typeof raw.observedAt !== 'string'
    || !Number.isFinite(Date.parse(raw.observedAt))
    || typeof raw.summary !== 'string'
    || !Array.isArray(raw.evidence)
    || !raw.evidence.every((item) => (
      item
      && typeof item === 'object'
      && typeof (item as Record<string, unknown>).source === 'string'
      && typeof (item as Record<string, unknown>).value === 'string'
    ))
    || (raw.fallbackReason !== undefined && typeof raw.fallbackReason !== 'string')
  ) {
    return undefined;
  }

  return {
    sessionId: raw.sessionId,
    runtime: raw.runtime as RuntimeId,
    state: raw.state as TerminalStatusState,
    authority: raw.authority as TerminalStatusAuthority,
    observedAt: raw.observedAt,
    summary: raw.summary,
    evidence: raw.evidence.map((item) => ({
      source: (item as Record<string, string>).source,
      value: (item as Record<string, string>).value,
    })),
    ...(raw.fallbackReason === undefined ? {} : { fallbackReason: raw.fallbackReason }),
  };
}

export function normalizeTerminalStatusEvidenceField(
  value: unknown,
): Pick<{ statusEvidence?: TerminalStatusEvidence }, 'statusEvidence'> {
  const statusEvidence = normalizeTerminalStatusEvidence(value);
  return statusEvidence ? { statusEvidence } : {};
}
