/**
 * #729 — Shared types + style tokens for the Packet Review Card panes.
 */

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export type Verdict = 'merge' | 'respec' | 'kill' | 'pending';

export interface DirectiveSummary {
  id: string;
  title: string;
  scope: string;
  repoName: string | null;
  priority: number | null;
  body: string;
}

export interface DiffPayload {
  diff: string;
  additions: number;
  deletions: number;
  fileCount: number;
  baseBranch: string | null;
  sourceLabel?: string | null;
}

export interface ParsedFileDiff {
  path: string;
  additions: number;
  deletions: number;
  patch: string;
  status: 'A' | 'M' | 'D' | 'R';
}

export interface Concern {
  category: 'read-budget' | 'edge-cases' | 'mechanical' | 'review';
  label: string;
  detail: string;
}

export const PANE_BORDER_COLOR = 'var(--t-divider-subtle)';
export const LABEL_COLOR = 'var(--t-text-muted)';
export const FONT_FAMILY = 'var(--font-sans-system)';
export const MONO_FAMILY = 'var(--font-mono, "SF Mono", Menlo, monospace)';

export function deriveVerdict(packet: OrchestratorPacket): Verdict {
  if (packet.review) return packet.review.approved ? 'merge' : 'respec';
  return 'pending';
}

export function verdictTone(verdict: Verdict) {
  switch (verdict) {
    case 'merge':
      return { label: 'MERGE', color: '#15803d', background: 'rgba(34, 197, 94, 0.12)', border: 'rgba(34, 197, 94, 0.32)' };
    case 'respec':
      return { label: 'RE-SPEC', color: '#b45309', background: 'rgba(245, 158, 11, 0.14)', border: 'rgba(245, 158, 11, 0.36)' };
    case 'kill':
      return { label: 'KILL', color: '#b91c1c', background: 'rgba(239, 68, 68, 0.12)', border: 'rgba(239, 68, 68, 0.32)' };
    default:
      return { label: 'PENDING', color: 'var(--t-text-muted)', background: 'rgba(148, 163, 184, 0.12)', border: 'rgba(148, 163, 184, 0.28)' };
  }
}

export function paneStyle(): React.CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    paddingTop: 10,
    paddingRight: 11,
    paddingBottom: 10,
    paddingLeft: 11,
    minHeight: 280,
    maxHeight: 460,
    overflowY: 'auto',
  };
}

export function paneLabelStyle(): React.CSSProperties {
  return {
    fontSize: 9,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: LABEL_COLOR,
    fontFamily: FONT_FAMILY,
  };
}

export function buildConcerns(packet: OrchestratorPacket): Concern[] {
  const out: Concern[] = [];

  if (packet.readBudget) {
    const reads = packet.readBudget.requiredReads.length;
    if (reads > 0) {
      out.push({
        category: 'read-budget',
        label: 'Read budget',
        detail: `Required ${packet.readBudget.minToolCalls} read-only call(s) across ${reads} surface file(s).`,
      });
    }
  }

  if (packet.edgeCaseSites && packet.edgeCaseSites.length > 0) {
    const top = packet.edgeCaseSites[0];
    out.push({
      category: 'edge-cases',
      label: 'Edge cases flagged',
      detail: `${packet.edgeCaseSites.length} site(s) including ${top.location}.`,
    });
  }

  if (packet.review?.findings) {
    for (const finding of packet.review.findings.slice(0, 5)) {
      out.push({
        category: finding.severity === 'high' ? 'mechanical' : 'review',
        label: finding.file,
        detail: finding.description,
      });
    }
  }

  return out;
}
