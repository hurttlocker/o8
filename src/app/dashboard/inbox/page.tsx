import { basename } from 'node:path';
import { revalidatePath } from 'next/cache';
import { dismissInboxItem, listInboxItems, type SupervisorInboxItem } from '@/lib/supervisor/inbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KIND_LABELS: Record<SupervisorInboxItem['kind'], string> = {
  verification_failed: 'Verification Failed',
  session_lost: 'Session Lost',
  packet_missing: 'Packet Missing',
  bounded_retry_exhausted: 'Retry Exhausted',
  merge_blocked: 'Merge Blocked',
};

const STATUS_LABELS: Record<SupervisorInboxItem['status'], string> = {
  pending: 'Pending',
  self_healed: 'Self healed',
  human_required: 'Human required',
  dismissed: 'Dismissed',
};

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function packetLabel(item: SupervisorInboxItem) {
  if (item.packetReferenceLabel && item.packetTitle) {
    return `${item.packetReferenceLabel} · ${item.packetTitle}`;
  }
  return item.packetTitle ?? item.packetReferenceLabel ?? 'Unbound lane';
}

function repoLabel(repoPath: string) {
  const label = basename(repoPath);
  return label || repoPath;
}

function shortPath(pathValue: string | null) {
  if (!pathValue) {
    return 'Unavailable';
  }
  const parts = pathValue.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : pathValue;
}

async function dismissAction(formData: FormData) {
  'use server';

  const id = formData.get('id');
  if (typeof id === 'string' && id.trim()) {
    dismissInboxItem(id.trim());
  }

  revalidatePath('/dashboard/inbox');
}

function InboxList({
  items,
}: {
  items: SupervisorInboxItem[];
}) {
  if (items.length === 0) {
    return (
      <div
        style={{
          borderRadius: 20,
          border: '1px solid rgba(148, 163, 184, 0.18)',
          background: 'rgba(255,255,255,0.78)',
          boxShadow: '0 20px 45px rgba(15, 23, 42, 0.08)',
          padding: 28,
          color: '#475569',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        }}
      >
        No active supervisor inbox items.
      </div>
    );
  }

  return (
    <div
      style={{
        borderRadius: 22,
        overflow: 'hidden',
        border: '1px solid rgba(148, 163, 184, 0.18)',
        background: 'rgba(255,255,255,0.8)',
        boxShadow: '0 28px 60px rgba(15, 23, 42, 0.08)',
        backdropFilter: 'blur(14px)',
      }}
    >
      {items.map((item, index) => {
        const verificationKind = typeof item.payload.verificationKind === 'string'
          ? item.payload.verificationKind
          : null;
        const diffStat = typeof item.payload.diffStat === 'string'
          ? item.payload.diffStat
          : null;
        const lastCommit = item.payload.lastCommit && typeof item.payload.lastCommit === 'object'
          ? item.payload.lastCommit as { subject?: string }
          : null;

        return (
          <div
            key={item.id}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              gap: 18,
              padding: '18px 22px',
              borderTop: index === 0 ? 'none' : '1px solid rgba(226, 232, 240, 0.9)',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    height: 22,
                    paddingLeft: 9,
                    paddingRight: 9,
                    borderRadius: 999,
                    background: item.status === 'human_required' ? 'rgba(249, 115, 22, 0.12)' : 'rgba(37, 99, 235, 0.1)',
                    color: item.status === 'human_required' ? '#c2410c' : '#1d4ed8',
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {KIND_LABELS[item.kind]}
                </span>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b' }}>
                  {STATUS_LABELS[item.status]}
                </span>
                {verificationKind ? (
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8' }}>
                    {verificationKind}
                  </span>
                ) : null}
                <span style={{ fontSize: 11, color: '#94a3b8' }}>
                  {formatTimestamp(item.createdAt)}
                </span>
              </div>

              <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>
                {packetLabel(item)}
              </div>

              <div style={{ fontSize: 13, lineHeight: 1.55, color: '#334155', marginBottom: 10 }}>
                {item.errorExcerpt}
              </div>

              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 10,
                  fontSize: 12,
                  color: '#64748b',
                }}
              >
                <span>Repo: {repoLabel(item.repoPath)}</span>
                <span>Path: {shortPath(item.worktreePath ?? item.repoPath)}</span>
                {lastCommit?.subject ? <span>Commit: {lastCommit.subject}</span> : null}
                {diffStat ? <span>Diff: {diffStat}</span> : null}
              </div>

              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 14,
                  marginTop: 12,
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {item.transcriptLink ? (
                  <a href={item.transcriptLink} target="_blank" rel="noreferrer" style={{ color: '#2563eb', textDecoration: 'none' }}>
                    Open transcript
                  </a>
                ) : null}
                {item.worktreeLink ? (
                  <a href={item.worktreeLink} style={{ color: '#0f766e', textDecoration: 'none' }}>
                    Open worktree
                  </a>
                ) : null}
              </div>
            </div>

            <form action={dismissAction}>
              <input type="hidden" name="id" value={item.id} />
              <button
                type="submit"
                style={{
                  alignSelf: 'start',
                  height: 34,
                  paddingLeft: 12,
                  paddingRight: 12,
                  borderRadius: 12,
                  border: '1px solid rgba(148, 163, 184, 0.22)',
                  background: 'rgba(255,255,255,0.9)',
                  color: '#475569',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Dismiss
              </button>
            </form>
          </div>
        );
      })}
    </div>
  );
}

export default async function DashboardInboxPage() {
  const items = listInboxItems();
  const humanRequiredCount = items.filter((item) => item.status === 'human_required').length;

  return (
    <main
      style={{
        minHeight: '100vh',
        padding: '40px 24px 56px',
        background: 'linear-gradient(180deg, #f8fbff 0%, #eef4ff 50%, #f8fafc 100%)',
      }}
    >
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 16,
            marginBottom: 20,
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#64748b', marginBottom: 8 }}>
              Governance
            </div>
            <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.05, letterSpacing: '-0.03em', color: '#0f172a' }}>
              Supervisor Inbox
            </h1>
            <p style={{ margin: '10px 0 0', fontSize: 14, color: '#475569', maxWidth: 760 }}>
              Persistent escalation ledger for packet failures that need operator review. No transcript injection, no overnight chat noise.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                height: 38,
                paddingLeft: 14,
                paddingRight: 14,
                borderRadius: 16,
                background: 'rgba(249, 115, 22, 0.12)',
                color: '#c2410c',
                fontSize: 13,
                fontWeight: 800,
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
            >
              {humanRequiredCount} human-required
            </div>
            <a
              href="/dashboard"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                height: 38,
                paddingLeft: 14,
                paddingRight: 14,
                borderRadius: 16,
                background: 'rgba(255,255,255,0.78)',
                border: '1px solid rgba(148, 163, 184, 0.18)',
                color: '#334155',
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: 700,
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
            >
              Back to dashboard
            </a>
          </div>
        </div>

        <InboxList items={items} />
      </div>
    </main>
  );
}
