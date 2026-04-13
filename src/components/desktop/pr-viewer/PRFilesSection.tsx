'use client';

import React, { memo } from 'react';
import { FileText } from '../lucide-shims';
import type { PRDetail } from './types';

interface PRFilesSectionProps {
  pr: PRDetail;
  activeItemIndex: number;
}

function PRFilesSectionBase({ pr, activeItemIndex }: PRFilesSectionProps) {
  return (
    <div>
      {pr.files?.length > 0 ? (
        pr.files.map((file, index) => (
          <div key={file.path} data-pr-section="files" data-pr-index={index} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingTop: 6,
            paddingRight: 10,
            paddingBottom: 6,
            paddingLeft: 8,
            borderRadius: 10,
            borderBottom: '1px solid var(--t-divider-subtle)',
            fontSize: 13,
            background: activeItemIndex === index ? 'rgba(37,99,235,0.08)' : 'transparent',
            border: activeItemIndex === index ? '1px solid rgba(37,99,235,0.16)' : '1px solid transparent',
          }}>
            <FileText size={14} strokeWidth={1.8} style={{ color: 'var(--t-text-muted)', flexShrink: 0 }} />
            <span style={{ flex: 1, color: 'var(--t-text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {file.path}
            </span>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 600 }}>
              {file.additions > 0 ? <span style={{ color: '#22c55e' }}>+{file.additions}</span> : null}
              {file.deletions > 0 ? <span style={{ color: '#ef4444' }}>-{file.deletions}</span> : null}
            </div>
            <span style={{ fontSize: 10, color: 'var(--t-text-faint)', flexShrink: 0 }}>
              {'\u21B5'} copies path
            </span>
          </div>
        ))
      ) : (
        <div style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>No changed files data</div>
      )}
      {pr.diffStat ? (
        <pre style={{
          marginTop: 12,
          fontSize: '0.75rem',
          lineHeight: 1.5,
          fontFamily: '"SF Mono", ui-monospace, monospace',
          color: 'var(--t-text-secondary)',
          whiteSpace: 'pre-wrap',
        }}>
          {pr.diffStat}
        </pre>
      ) : null}
    </div>
  );
}

export const PRFilesSection = memo(PRFilesSectionBase);
