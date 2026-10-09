'use client';
import { RamsButton } from '@/components/desktop/settings/shared';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';
import { toolVisualizationReferences } from '@/lib/visualizations/transcript';
import type { VisualizationReference } from '@/lib/visualizations/types';
import { VisualizationFrame } from './VisualizationFrame';

export function MessageVisualizations({ toolCalls, references = [] }: { toolCalls?: MobileTranscriptToolCall[]; references?: VisualizationReference[] }) {
  const embedded = toolVisualizationReferences(toolCalls);
  const merged = new Map<string, VisualizationReference>();
  for (const ref of [...embedded, ...references]) { const key = ref.rootId ?? ref.id; if ((merged.get(key)?.version ?? 0) <= (ref.version ?? 1)) merged.set(key, ref); }
  const refs = [...merged.values()];
  return refs.length ? <div style={{ display: 'flex', flexDirection: 'column', gap: 18, width: '100%' }}>
    {refs.map(reference => !references.length && (reference.version ?? 1) > 1 ? <div key={reference.id} style={{ alignSelf: 'flex-start' }}><RamsButton variant="ghost" onClick={() => window.dispatchEvent(new CustomEvent('o8:open-visualization', { detail: reference }))}>Updated {reference.title} (v{reference.version}) · View</RamsButton></div> : <VisualizationFrame key={reference.rootId ?? reference.id} reference={reference} />)}
  </div> : null;
}
