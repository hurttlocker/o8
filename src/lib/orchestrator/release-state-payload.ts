import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export function normalizeReleaseStatePayload(
  value: unknown,
): OrchestratorPacket['releaseStatePayload'] {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<NonNullable<OrchestratorPacket['releaseStatePayload']>>;
  const stringField = (field: unknown) => (
    typeof field === 'string' && field.trim() ? field.trim() : null
  );
  const mergeCommit = stringField(raw.mergeCommit);
  const releasedAt = stringField(raw.releasedAt);
  const source = stringField(raw.source);
  const headSha = stringField(raw.headSha);
  const evidenceKind = stringField(raw.evidenceKind);
  if (!mergeCommit && !releasedAt && !source && !headSha && !evidenceKind) return null;
  const payload: NonNullable<OrchestratorPacket['releaseStatePayload']> = {
    mergeCommit,
    releasedAt,
    source,
  };
  // Preserve legacy shape; normalization must not manufacture optional keys.
  if ('headSha' in raw || headSha) payload.headSha = headSha;
  if ('evidenceKind' in raw || evidenceKind) payload.evidenceKind = evidenceKind;
  return payload;
}
