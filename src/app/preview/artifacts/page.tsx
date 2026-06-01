'use client';

import type { ArtifactRef } from '@/components/desktop/artifacts/types';
import { ArtifactStrip } from '@/components/desktop/artifacts/ArtifactStrip';

// Mock data — picsum placeholders (CSP allows https img). Seeded so before/after
// are distinct + stable across reloads.
const PAIR: ArtifactRef[] = [
  { id: 'a1', url: 'https://picsum.photos/seed/o8bug/720/440', kind: 'screenshot', source: 'agent-capture', phase: 'before', pairId: 'p1', label: 'Login screen — button overlaps form', width: 720, height: 440, capturedAt: '2026-06-01T10:00:00Z' },
  { id: 'a2', url: 'https://picsum.photos/seed/o8fixed/720/440', kind: 'screenshot', source: 'agent-capture', phase: 'after', pairId: 'p1', label: 'Login screen — button overlaps form', width: 720, height: 440, capturedAt: '2026-06-01T10:02:00Z' },
];
const SINGLE: ArtifactRef[] = [
  { id: 'b1', url: 'https://picsum.photos/seed/o8single/720/440', kind: 'screenshot', source: 'agent-capture', phase: null, pairId: null, label: 'Dashboard after dark-mode fix', width: 720, height: 440, capturedAt: '2026-06-01T10:05:00Z' },
];
const MULTI: ArtifactRef[] = [...PAIR, ...SINGLE];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 36 }}>
      <div style={{ color: 'var(--t-text-faint)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12, fontFamily: 'var(--font-sans-system)' }}>{title}</div>
      <div style={{ padding: 16, borderRadius: 14, border: '1px solid var(--t-divider)', background: 'var(--t-bg-card)' }}>{children}</div>
    </div>
  );
}

export default function ArtifactsPreviewPage() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--t-bg)', color: 'var(--t-text)', padding: 40, fontFamily: 'var(--font-sans-system)' }}>
      <div style={{ maxWidth: 880, marginLeft: 'auto', marginRight: 'auto' }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>Visual proof — ArtifactStrip</h1>
        <div style={{ color: 'var(--t-text-muted)', fontSize: 13, marginBottom: 28 }}>#1147 component lab — before/after pairing, lightbox, empty state.</div>

        <Section title="Before / after pair + single (hero)">
          <ArtifactStrip artifacts={MULTI} />
        </Section>

        <Section title="Single before/after pair only">
          <ArtifactStrip artifacts={PAIR} />
        </Section>

        <Section title="Dense variant (inline chat card)">
          <ArtifactStrip artifacts={PAIR} dense />
        </Section>

        <Section title="Empty state (showEmpty — backend change, no visual)">
          <ArtifactStrip artifacts={[]} showEmpty />
        </Section>
      </div>
    </div>
  );
}
