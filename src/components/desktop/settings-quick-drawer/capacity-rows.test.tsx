import { readFileSync } from 'node:fs';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { RuntimeCapacityControlSnapshot } from '@/lib/runtime/capacity-service';
import type { RuntimeCapacityConfidence, RuntimeCapacityStatus } from '@/lib/runtimes/types';
import { CapacityRows } from './capacity-rows';

function capacity(
  runtime: string,
  status: RuntimeCapacityStatus,
  confidence: RuntimeCapacityConfidence | null,
) {
  return {
    runtime,
    identityId: null,
    status,
    reason: status === 'available' ? null : `${status}_fixture`,
    observedAt: status === 'available' || status === 'stale' ? '2026-08-12T12:00:00.000Z' : null,
    source: confidence === null ? null : confidence === 'exact' ? 'structured-cli' as const : 'local-state' as const,
    confidence,
    buckets: status === 'available' || status === 'stale'
      ? [{
        id: 'window',
        label: '5h',
        usedRatio: confidence === 'exact' ? 0.5 : null,
        used: confidence === 'estimated' ? 1_200 : null,
        unit: confidence === 'estimated' ? 'tokens' as const : null,
        remaining: null,
        resetsAt: null,
        expiresAt: null,
      }]
      : [],
  };
}

describe('capacity rows', () => {
  it('renders exact, estimated, exhausted-only, stale, unavailable, and malformed truth distinctly', () => {
    const snapshot: RuntimeCapacityControlSnapshot = {
      schema: 'o8/runtime-capacity-control/v1',
      generatedAt: Date.parse('2026-08-12T12:00:00.000Z'),
      capacities: [
        capacity('codex', 'available', 'exact'),
        capacity('claude-code', 'available', 'estimated'),
        capacity('runtime-signal', 'available', 'exhausted-only'),
        capacity('runtime-stale', 'stale', 'estimated'),
        capacity('runtime-unavailable', 'unavailable', null),
        capacity('runtime-malformed', 'malformed', null),
      ],
      identities: [],
      runtimes: [],
    };
    const html = renderToStaticMarkup(
      <CapacityRows snapshot={snapshot} loading={false} error={null} onRefresh={() => {}} />,
    );
    expect(html).toContain('Exact provider limits');
    expect(html).toContain('Estimated local activity');
    expect(html).toContain('Exhaustion signal only');
    expect(html).toContain('Stale observation');
    expect(html).toContain('Capacity unavailable');
    expect(html).toContain('Provider data malformed');
    expect(html).toContain('50% used');
    expect(html).toContain('1.2k tokens used');
    expect(html).toContain('No quota total');
  });

  it('uses one drawer-scoped 30 second refresh loop and the generic route', () => {
    const source = readFileSync('src/components/desktop/SettingsQuickDrawer.tsx', 'utf8');
    expect(source.match(/setInterval\(/g)).toHaveLength(1);
    expect(source).toContain('const POLL_MS = 30_000;');
    expect(source).toContain("/api/runtime/capacity${fresh ? '?fresh=1' : ''}");
    expect(source).not.toContain('/api/panel/cli-usage');
  });
});
