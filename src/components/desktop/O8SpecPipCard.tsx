'use client';

import dynamic from 'next/dynamic';
import { HoverPipCard } from '@/components/desktop/HoverPipCard';

export const O8_SPEC_PIP_EVENT = 'o8:spec-pip';

const ORIENTATION_KEY = 'o8:spec-pip-orientation';
const LazyO8SpecPane = dynamic(
  () => import('@/components/desktop/o8-panel/O8SpecPane').then((module) => module.O8SpecPane),
  {
    ssr: false,
    loading: () => (
      <div
        aria-label="Loading o8.md preview"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 1,
          color: 'var(--t-text-faint)',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 11,
        }}
      >
        Loading o8.md…
      </div>
    ),
  },
);

export function O8SpecPipCard({
  active,
  repoPath,
  onOpenSpec,
}: {
  active: boolean;
  repoPath?: string | null;
  onOpenSpec?: () => void;
}) {
  return (
    <HoverPipCard
      active={active}
      available={Boolean(repoPath)}
      eventName={O8_SPEC_PIP_EVENT}
      storageKey={ORIENTATION_KEY}
      title="o8.md"
      titleTooltip={repoPath ?? undefined}
      openLabel="Open o8.md panel"
      onOpen={onOpenSpec}
    >
      {({ shape }) => (
        <div
          style={{
            position: 'relative',
            display: 'flex',
            height: shape.frameHeight,
            overflow: 'hidden',
            background: 'var(--t-canvas-bg)',
          }}
        >
          <div
            style={{
              display: 'flex',
              flex: 1,
              minWidth: 0,
            }}
          >
            <LazyO8SpecPane repoPath={repoPath} active embedded />
          </div>
        </div>
      )}
    </HoverPipCard>
  );
}
