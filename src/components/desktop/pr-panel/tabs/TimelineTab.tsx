'use client';

/* eslint-disable @next/next/no-img-element -- Provider avatars have fixed dimensions and load directly in native panels. */

import { useMemo } from 'react';
import { Clock, ExternalLink, GitPullRequest } from '../../lucide-shims';
import { relativeTimeLabel } from '@/lib/format/relative-time';
import { PrMarkdown } from '../PrMarkdown';
import { usePrTimeline } from '../usePrTimeline';
import type { PrDetail, PrTimelineEvent } from '../types';

const control: React.CSSProperties = { minHeight: 28, paddingTop: 0, paddingRight: 8, paddingBottom: 0, paddingLeft: 8, border: '1px solid var(--t-divider)', borderRadius: 7, background: 'transparent', color: 'var(--t-text-secondary)', fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' };

export function TimelineTab({ detail, repoSlug, active, newestFirst, onToggleOrder, onOpenFile }: { detail: PrDetail; repoSlug?: string | null; active: boolean; newestFirst: boolean; onToggleOrder: () => void; onOpenFile: (path: string) => void }) {
  const { data, loading, error, refresh, retry, loadMore } = usePrTimeline(detail.number, detail.resolvedRepo || repoSlug, active);
  const events = useMemo(() => {
    const opened: PrTimelineEvent = { id: 'opened', kind: 'opened', title: 'opened this pull request', actor: detail.author, avatarUrl: detail.avatarUrl || null, at: detail.createdAt, body: '', url: detail.url };
    const list = [opened, ...(data?.events || [])];
    list.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
    return newestFirst ? list.reverse() : list;
  }, [data, detail.author, detail.avatarUrl, detail.createdAt, detail.url, newestFirst]);
  return <div style={{ paddingTop: 12, paddingRight: 18, paddingBottom: 18, paddingLeft: 18 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 16 }}>
      <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{data ? `${events.length} events${data.nextPage ? ' loaded' : ''}` : 'Pull request activity'}</span>
      <div style={{ display: 'flex', gap: 6 }}><button type="button" onClick={onToggleOrder} style={control}>{newestFirst ? 'Newest first' : 'Oldest first'}</button><button type="button" onClick={() => void refresh()} disabled={loading} style={control} aria-label="Refresh pull request activity">Refresh</button></div>
    </div>
    {loading && !data ? <div role="status" style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>Loading activity for PR #{detail.number}…</div> : null}
    {error ? <div role="alert" style={{ marginBottom: 12, fontSize: 12, color: 'var(--t-danger)' }}>{error} <button type="button" onClick={() => void retry()} style={control}>Retry activity</button></div> : null}
    {data ? <ol aria-label="Pull request timeline" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {events.map((event) => <li key={event.id} style={{ position: 'relative', display: 'grid', gridTemplateColumns: '24px minmax(0, 1fr)', gap: 12, paddingBottom: 20 }}>
        <div aria-hidden="true" style={{ position: 'absolute', left: 11, top: 25, bottom: 2, width: 1, background: 'var(--t-divider)' }} />
        {event.avatarUrl ? <img src={event.avatarUrl} alt="" width={24} height={24} loading="lazy" decoding="async" style={{ borderRadius: '50%' }} /> : <span aria-hidden="true" style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', borderRadius: '50%', background: 'var(--t-input-bg)', color: 'var(--t-text-muted)' }}>{event.kind === 'opened' ? <GitPullRequest size={13} /> : <Clock size={13} />}</span>}
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, lineHeight: 1.5 }}><span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}><strong style={{ fontWeight: 500 }}>{event.actor}</strong> <span style={{ color: 'var(--t-text-secondary)' }}>{event.title}</span></span><a href={event.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${event.title} on GitHub`} style={{ color: 'var(--t-text-muted)', flexShrink: 0 }}><ExternalLink size={12} /></a></div>
          <div style={{ display: 'flex', gap: 8, marginTop: 3, fontSize: 10, color: 'var(--t-text-muted)' }}>{event.commitSha ? <span style={{ fontFamily: 'var(--font-mono)' }}>{event.commitSha.slice(0, 7)}</span> : null}{event.at ? <time dateTime={event.at} title={event.at}>{relativeTimeLabel(Date.parse(event.at), { overflow: 'days', subMinute: 'just-now-lower' })}</time> : null}</div>
          {event.body ? <div style={{ marginTop: 8, paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12, background: 'var(--t-bg-card)', border: '1px solid var(--t-divider-subtle)', borderRadius: 9 }}><PrMarkdown text={event.body} detail={detail} onOpenFile={onOpenFile} /></div> : null}
        </div>
      </li>)}
    </ol> : null}
    {loading && data ? <div role="status" style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Loading activity…</div> : null}
    {data?.nextPage ? <button type="button" onClick={() => void loadMore()} disabled={loading} style={control}>Load more activity</button> : null}
  </div>;
}
