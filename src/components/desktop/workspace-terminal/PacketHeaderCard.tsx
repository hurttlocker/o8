'use client';

import { useMemo, useState } from 'react';
import type { WorkerLaunchContext } from '@/lib/orchestrator/types';
import { workerLaunchOriginLabel } from '@/lib/orchestrator/worker-launch-context';

function PacketMetaChip({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
      <span
        style={{
          fontSize: 9,
          fontWeight: 300,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--t-text-faint)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 11,
          color: 'var(--t-text)',
          fontFamily: mono ? '"SF Mono", ui-monospace, Menlo, monospace' : undefined,
          letterSpacing: '-0.005em',
          maxWidth: 220,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </span>
  );
}

export function PacketHeaderCard({
  title,
  branch,
  runtime,
  status,
  repo,
  launchContext,
  prompt,
}: {
  title: string;
  branch?: string | null;
  runtime?: string | null;
  status?: string | null;
  repo?: string | null;
  launchContext?: WorkerLaunchContext | null;
  prompt: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const previewLine = useMemo(() => {
    const summaryMatch = prompt.match(/Summary:\s*([^\n]+)/i);
    if (summaryMatch?.[1]) return summaryMatch[1].trim();
    const firstLine = prompt.split('\n').find((line) => line.trim());
    return firstLine ? firstLine.trim() : '';
  }, [prompt]);
  const statusLabel = status ? status.replace(/_/g, ' ') : null;
  const originLabel = workerLaunchOriginLabel(launchContext);

  return (
    <div
      style={{
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-panel-border)',
        borderRadius: 12,
        backgroundColor: 'var(--t-panel-solid)',
        boxShadow: 'var(--t-panel-shadow)',
        overflow: 'hidden',
        marginBottom: 4,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          width: '100%',
          paddingTop: 12,
          paddingRight: 16,
          paddingBottom: 12,
          paddingLeft: 16,
          backgroundColor: 'transparent',
          borderWidth: 0,
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 300,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--t-text-faint)',
            }}
          >
            {originLabel ? 'External worker' : 'Packet'}
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 400,
              color: 'var(--t-text)',
              letterSpacing: '-0.1px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0,
            }}
          >
            {title}
          </span>
          <svg
            width={10}
            height={10}
            viewBox="0 0 10 10"
            fill="none"
            stroke="var(--t-text-faint)"
            strokeWidth={1.6}
            strokeLinecap="round"
            style={{
              flexShrink: 0,
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            <path d="M2.5 3.5 L5 6 L7.5 3.5" />
          </svg>
        </div>
        {previewLine ? (
          <div
            style={{
              fontSize: 12,
              color: 'var(--t-text-secondary)',
              letterSpacing: '-0.005em',
              lineHeight: 1.45,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {previewLine}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
          {runtime ? <PacketMetaChip label="Runtime" value={runtime} /> : null}
          {repo ? <PacketMetaChip label="Repo" value={repo} /> : null}
          {originLabel ? <PacketMetaChip label="Started by" value={originLabel} /> : null}
          {launchContext?.repoContext === 'transient' ? <PacketMetaChip label="Scope" value="Temporary repo" /> : null}
          {branch ? <PacketMetaChip label="Branch" value={branch} mono /> : null}
          {statusLabel ? <PacketMetaChip label="Status" value={statusLabel} /> : null}
        </div>
      </button>
      {expanded ? (
        <div
          style={{
            paddingTop: 10,
            paddingRight: 16,
            paddingBottom: 14,
            paddingLeft: 16,
            borderTopWidth: 1,
            borderTopStyle: 'solid',
            borderTopColor: 'var(--t-divider-subtle)',
            backgroundColor: 'var(--t-panel-hover, transparent)',
          }}
        >
          <pre
            style={{
              marginTop: 0,
              marginRight: 0,
              marginBottom: 0,
              marginLeft: 0,
              fontSize: 11.5,
              lineHeight: 1.5,
              color: 'var(--t-text-secondary)',
              fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              letterSpacing: '-0.002em',
            }}
          >
            {prompt}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
