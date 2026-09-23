'use client';

import type {
  ArchitectureAttentionResult,
  ArchitectureReviewLens,
} from '@/lib/review/architecture-attention-types';
import type { ArchitectureAttentionState } from '../useArchitectureAttention';
import { UI_FONT } from './constants';

const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

export const ARCHITECTURE_LENS_LABEL: Record<ArchitectureReviewLens, string> = {
  auth_trust: 'Auth + trust',
  state_persistence: 'State + persistence',
  async_lifecycle: 'Async lifecycle',
  interface_contract: 'API + contracts',
  ui_behavior: 'UI behavior',
  tests_docs: 'Tests + docs',
  general: 'General review',
};

function receiptLabel(result: ArchitectureAttentionResult) {
  return [
    result.model,
    typeof result.latencyMs === 'number' ? `${result.latencyMs} ms` : null,
    result.cached ? 'cached' : null,
  ].filter(Boolean).join(' · ');
}

export function ArchitectureAttentionStrip({
  attention,
  onSelectFile,
}: {
  attention: ArchitectureAttentionState;
  onSelectFile: (path: string) => void;
}) {
  const result = attention.result;
  const suggestions = result?.status === 'ready' ? result.items.slice(0, 3) : [];
  return (
    <aside aria-label="Advisory architecture review order" style={{ marginBottom: 10, paddingTop: 9, paddingRight: 9, paddingBottom: 9, paddingLeft: 9, border: '1px solid color-mix(in srgb, var(--t-accent) 30%, var(--t-divider-subtle))', borderRadius: 9, background: 'color-mix(in srgb, var(--t-accent) 5%, var(--t-canvas-bg))', fontFamily: UI_FONT }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minHeight: 18 }}>
        <span style={{ color: 'var(--t-text)', fontSize: 11.5, fontWeight: 500 }}>Jev review lens</span>
        <span style={{ paddingTop: 2, paddingRight: 5, paddingBottom: 2, paddingLeft: 5, border: '1px solid var(--t-accent)', borderRadius: 999, color: 'var(--t-accent)', fontSize: 8, fontWeight: 500, letterSpacing: '0.07em' }}>ADVISORY</span>
        <span style={{ marginLeft: 'auto', color: 'var(--t-text-faint)', fontSize: 8.5, fontWeight: 300 }}>paths + topology only</span>
      </div>
      {attention.loading ? (
        <p style={{ marginTop: 7, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-muted)', fontSize: 10.5, fontWeight: 300 }}>Ranking the review path…</p>
      ) : result?.status === 'ready' && suggestions.length ? (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
            {suggestions.map((item) => (
              <button
                key={item.path}
                type="button"
                title={`Open ${item.reviewPath} diff`}
                onClick={() => onSelectFile(item.reviewPath)}
                style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 150, minHeight: 44, flex: '1 1 150px', paddingTop: 5, paddingRight: 8, paddingBottom: 5, paddingLeft: 6, border: '1px solid var(--t-divider-subtle)', borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text)', cursor: 'pointer', fontFamily: UI_FONT, textAlign: 'left' }}
              >
                <span style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, flexShrink: 0, borderRadius: 999, background: 'var(--t-accent)', color: 'white', fontFamily: MONO_FONT, fontSize: 10, fontWeight: 500 }}>{item.rank}</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: MONO_FONT, fontSize: 9.5 }}>{item.path.split('/').at(-1)}</span>
                  <span style={{ display: 'block', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text-faint)', fontSize: 9 }}>{ARCHITECTURE_LENS_LABEL[item.lens]}</span>
                </span>
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 6, color: 'var(--t-text-faint)', fontSize: 8.5, fontWeight: 300 }}>
            <span>Suggested order only; every module remains visible.</span>
            <span style={{ marginLeft: 'auto', fontFamily: MONO_FONT }}>{receiptLabel(result)}</span>
          </div>
        </>
      ) : (
        <p style={{ marginTop: 7, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-faint)', fontSize: 10, fontWeight: 300 }}>
          {result?.reason ?? attention.error ?? 'The architecture map remains available without an advisory order.'}
        </p>
      )}
    </aside>
  );
}
