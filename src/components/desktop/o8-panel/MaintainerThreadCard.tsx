'use client';

import { useState } from 'react';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { maintainerReplyDraft, type MaintainerReplyContext } from '@/lib/inbox/maintainer-draft';
import type { MaintainerContribution } from '@/lib/inbox/maintainer-types';
import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';
import { RamsButton } from '../settings/RamsButton';
import { ExternalLink } from '../lucide-shims';

function ageLabel(since: unknown): string {
  if (typeof since !== 'string' || !Number.isFinite(Date.parse(since))) return 'Waiting for a reply';
  const hours = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 3_600_000));
  return hours < 24 ? `Waiting ${hours}h` : `Waiting ${Math.floor(hours / 24)}d`;
}

export function MaintainerThreadCard({ source, onPrepareReply, onDismiss }: { source: SupervisorInboxItem | MaintainerContribution; onPrepareReply?: (context: MaintainerReplyContext) => void; onDismiss?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const incident = 'payload' in source;
  const payload = incident ? source.payload : null;
  const repo = incident ? String(payload?.threadRepo ?? '') : source.repo;
  const number = incident ? payload?.threadNumber : source.number;
  const title = incident ? String(payload?.threadTitle ?? payload?.title ?? 'GitHub thread') : source.title;
  const url = incident ? String(payload?.url ?? '') : source.url;
  const kind = incident ? payload?.threadKind === 'pr' ? 'PR' : 'Issue' : source.kind === 'pull_request' || source.threadKind === 'pr' ? 'PR' : source.kind === 'claim' ? 'Claim' : 'Issue';
  const person = incident ? payload?.waitingLogin : source.assignees.length ? source.assignees.join(', ') : source.kind === 'claim' ? null : source.author;
  const firstContribution = !incident && ['FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR'].includes(source.authorAssociation ?? '');
  const settled = incident && ['resolved', 'dismissed', 'self_healed'].includes(source.status);
  const waiting = incident && !settled || !incident && source.kind === 'reply';
  const state = incident ? settled ? source.status === 'dismissed' ? 'Dismissed' : 'Replied or closed' : ageLabel(payload?.waitingSince) : source.kind === 'claim' ? 'Claimed' : source.kind === 'reply' ? ageLabel(source.waitingSince) : 'Open';
  const draftContext = maintainerReplyDraft(source);
  return <article data-maintainer-thread={source.id} style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, marginBottom: 8, borderRadius: 10, border: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg-card)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-muted)', marginBottom: 6 }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo} · {kind} #{String(number ?? '')}</span>
      <span style={{ marginLeft: 'auto', flexShrink: 0, color: waiting ? 'var(--t-warning)' : 'var(--t-text-faint)' }}>{state}</span>
    </div>
    <div style={{ color: 'var(--t-text)', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.35, overflowWrap: 'anywhere' }}>{title}</div>
    {person ? <div style={{ marginTop: 4, color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300, overflowWrap: 'anywhere' }}>{String(person)}{waiting ? ' is waiting for a response' : ''}</div> : null}
    {firstContribution ? <div style={{ marginTop: 4, color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260 }}>First-time contributor</div> : null}
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      <RamsButton variant="ghost" busy={busy} disabled={!draftContext || !onPrepareReply || settled} onClick={() => { if (draftContext) onPrepareReply?.(draftContext); }}>Prepare reply</RamsButton>
      <a href={url} target="_blank" rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); void openExternalUrl(url); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300, textDecoration: 'none' }}>Open on GitHub<ExternalLink size={11} aria-hidden="true" /></a>
      {!incident && source.kind === 'pull_request' ? <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('o8:open-pr', { detail: { prNumber: source.number, repo: source.repo, repoPath: source.repoPaths[0] } }))} style={{ border: 0, background: 'transparent', color: 'var(--t-text-muted)', font: 'inherit', fontSize: 11, cursor: 'pointer' }}>Open review</button> : null}
      {onDismiss && !settled ? <button type="button" aria-label={`Dismiss ${kind} #${String(number)}`} disabled={busy} onClick={() => { setBusy(true); void onDismiss().catch(() => setNote('The thread could not be dismissed.')).finally(() => setBusy(false)); }} style={{ marginLeft: 'auto', height: 26, width: 26, padding: 0, border: 0, borderRadius: 7, background: 'transparent', color: 'var(--t-text-faint)', cursor: 'pointer' }}><svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button> : null}
    </div>
    {note ? <div role="status" style={{ marginTop: 8, color: 'var(--t-text-muted)', fontSize: 11, lineHeight: 1.4 }}>{note}</div> : null}
  </article>;
}
