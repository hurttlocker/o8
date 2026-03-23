/**
 * Demo approval requests — structured data that the mobile shell renders
 * as native approval cards.
 *
 * In production, these would arrive from the gateway when an agent hits
 * a checkpoint requiring human confirmation (deploy, destructive action,
 * spend threshold, permission escalation).
 */

export interface ApprovalRequest {
  id: string;
  agent: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  metadata?: Record<string, string>;
  actions: {
    approve: { label: string };
    reject: { label: string };
  };
  createdAt: number;
}

export const demoApprovals: ApprovalRequest[] = [
  {
    id: 'demo-deploy-001',
    agent: 'Niot',
    severity: 'warning',
    title: 'Deploy cortex-ide to production?',
    description: 'Branch batch/2-command-surface has 44 commits and all checks pass. Ready to deploy to Vercel production.',
    metadata: {
      Branch: 'batch/2-command-surface',
      Commits: '44',
      'Files changed': '19',
      'Lines added': '+4,650',
    },
    actions: {
      approve: { label: 'Approve' },
      reject: { label: 'Reject' },
    },
    createdAt: Date.now() - 120_000,
  },
  {
    id: 'demo-permission-002',
    agent: 'Codex',
    severity: 'critical',
    title: 'Delete 23 stale branches?',
    description: 'Codex wants to run git branch cleanup on cortex-ide. This will permanently delete 23 remote branches older than 30 days.',
    metadata: {
      Repository: '',
      Branches: '23',
      Action: 'git push origin --delete',
    },
    actions: {
      approve: { label: 'Allow' },
      reject: { label: 'Deny' },
    },
    createdAt: Date.now() - 45_000,
  },
  {
    id: 'demo-decision-003',
    agent: 'Hawk',
    severity: 'info',
    title: 'Skip failing test in cortex/search?',
    description: 'The BM25 relevance test is flaky after the index migration. Hawk recommends marking it as known and shipping the rest of the PR.',
    metadata: {
      Test: 'search.bm25.relevance',
      'Failure rate': '2 of 10 runs',
      PR: '#42',
    },
    actions: {
      approve: { label: 'Skip & Ship' },
      reject: { label: 'Fix First' },
    },
    createdAt: Date.now() - 10_000,
  },
];
