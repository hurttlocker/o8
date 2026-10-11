'use client';

import Image from 'next/image';
import { memo } from 'react';
import { relativeTimeLabel } from '@/lib/format/relative-time';
import { CircleUser } from '../lucide-shims';

export const PrPanelTitle = memo(function PrPanelTitle({ title, author, avatarUrl, updatedAt }: {
  title: string; author: string; avatarUrl?: string | null; updatedAt: string;
}) {
  const timestamp = Date.parse(updatedAt);
  return <div style={{ display: 'grid', gap: 6 }}>
    <h2 style={{ margin: 0, fontSize: 15, fontWeight: 350, letterSpacing: '-0.1px', lineHeight: 1.4, overflowWrap: 'anywhere' }}>{title}</h2>
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--t-text-secondary)' }}>
      {avatarUrl ? <Image src={avatarUrl} alt="" width={20} height={20} unoptimized style={{ borderRadius: '50%' }} /> : <CircleUser size={20} aria-hidden="true" />}
      <span>{author}</span>
      {Number.isFinite(timestamp) ? <><span aria-hidden="true">·</span><time dateTime={updatedAt} title={new Date(timestamp).toLocaleString()} style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>updated {relativeTimeLabel(timestamp, { overflow: 'days', subMinute: 'just-now-lower' })}</time></> : null}
    </div>
  </div>;
});
