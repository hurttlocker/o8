import type { MobileTranscriptEntry } from '@/lib/mobile/types';

const CARRY_LAYERS = ['narrative', 'intent', 'workspace', 'governance', 'provenance'] as const;

export function parseHandoffEventData(value: Record<string, unknown> | undefined): MobileTranscriptEntry['handoff'] | null {
  const from = value?.from && typeof value.from === 'object' ? value.from as Record<string, unknown> : null;
  const to = value?.to && typeof value.to === 'object' ? value.to as Record<string, unknown> : null;
  if (!to || typeof to.backend !== 'string' || typeof value?.handoffId !== 'string') return null;
  const carries = value.carries && typeof value.carries === 'object'
    ? value.carries as NonNullable<MobileTranscriptEntry['handoff']>['carries']
    : null;
  if (!carries || CARRY_LAYERS.some((layer) => {
    const level = carries[layer];
    return level !== 'full' && level !== 'summary' && level !== 'omitted';
  })) return null;
  return {
    handoffId: value.handoffId,
    from: from && typeof from.backend === 'string'
      ? { backend: from.backend, model: typeof from.model === 'string' ? from.model : null }
      : null,
    to: { backend: to.backend, model: typeof to.model === 'string' ? to.model : null },
    lossless: value.lossless === true,
    carries,
    packet: value.packet && typeof value.packet === 'object' ? value.packet as Record<string, unknown> : undefined,
  };
}
