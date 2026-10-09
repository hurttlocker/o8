'use client';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';
import { toolVisualizationReferences } from '@/lib/visualizations/transcript';
import type { VisualizationReference } from '@/lib/visualizations/types';
import { VisualizationFrame } from './VisualizationFrame';

export function MessageVisualizations({ toolCalls, references = [] }: { toolCalls?: MobileTranscriptToolCall[]; references?: VisualizationReference[] }) {
  const refs = [...new Map([...toolVisualizationReferences(toolCalls), ...references].map(ref => [ref.id, ref])).values()];
  return refs.length ? <div style={{ display: 'flex', flexDirection: 'column', gap: 18, width: '100%' }}>
    {refs.map(reference => <VisualizationFrame key={reference.id} reference={reference} />)}
  </div> : null;
}
