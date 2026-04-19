import type { OrchestratorPacket, OrchestratorPacketType } from '@/lib/orchestrator/types';

/**
 * Narrow an arbitrary value to a known packet type tag. Only `decompose` is
 * recognised today; unknown tags are dropped silently so unrecognised future
 * governance tags don't break hydration.
 */
export function normalizePacketType(value: unknown): OrchestratorPacketType | undefined {
  return value === 'decompose' ? 'decompose' : undefined;
}

/**
 * Normalise the decomposition metadata block carried by `packetType: 'decompose'`
 * packets. Returns undefined if any required field is missing or malformed so
 * partial/stale records never confuse the pipeline — the dispatch path can
 * always assume `decomposition` is either complete or absent.
 */
export function normalizeDecompositionMetadata(value: unknown): OrchestratorPacket['decomposition'] {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as Partial<OrchestratorPacket['decomposition']>;
  const targetFile = typeof raw?.targetFile === 'string' ? raw.targetFile.trim() : '';
  const postMergeSha = typeof raw?.postMergeSha === 'string' ? raw.postMergeSha.trim() : '';
  const lineCount = typeof raw?.lineCount === 'number' && Number.isFinite(raw.lineCount) && raw.lineCount > 0
    ? Math.floor(raw.lineCount)
    : 0;
  if (!targetFile || !postMergeSha || lineCount === 0) {
    return undefined;
  }
  return { targetFile, postMergeSha, lineCount };
}
