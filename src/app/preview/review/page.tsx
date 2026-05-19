'use client';

/**
 * /preview/review — dev scaffold that renders the Review surface (ReviewPanel)
 * in isolation against a real repo's working tree. Pass `?repo=<absolute path>`.
 * Not part of the shipped app chrome — a screenshot/iteration harness.
 */

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ThemeProvider } from '@/lib/theme/context';
import { ReviewPanel } from '@/components/desktop/review/ReviewPanel';

function ReviewPreviewInner() {
  const repo = useSearchParams().get('repo');
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', background: 'var(--t-bg)' }}>
      <div style={{ width: 720, height: '100%', borderRight: '1px solid var(--t-divider)' }}>
        <ReviewPanel repoPath={repo} />
      </div>
    </div>
  );
}

export default function ReviewPreviewPage() {
  return (
    <ThemeProvider>
      <Suspense fallback={null}>
        <ReviewPreviewInner />
      </Suspense>
    </ThemeProvider>
  );
}
