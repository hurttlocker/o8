import type { ApprovalRecord, ApprovalReferee } from '@/lib/approvals/types';

/** Key inside `metadata_json` that holds the typed referee object (#2435). */
export const APPROVAL_REFEREE_METADATA_KEY = 'referee';

function isRefereeObject(value: unknown): value is ApprovalReferee {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as ApprovalReferee).model === 'string'
    && Boolean((value as ApprovalReferee).answers) && typeof (value as ApprovalReferee).answers === 'object';
}

/**
 * Split a stored `metadata_json` into the string metadata bag and the typed
 * referee. Only an object value under the key counts as a referee, so an
 * existing string metadata entry with that name stays in the bag.
 */
export function parseApprovalMetadataJson(
  metadataJson: string | null | undefined,
): Pick<ApprovalRecord, 'metadata' | 'referee'> {
  if (!metadataJson) return { metadata: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return { metadata: undefined };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { metadata: parsed as ApprovalRecord['metadata'] };
  }
  const bag = parsed as Record<string, unknown>;
  const candidate = bag[APPROVAL_REFEREE_METADATA_KEY];
  if (!isRefereeObject(candidate)) return { metadata: bag as Record<string, string> };
  const { [APPROVAL_REFEREE_METADATA_KEY]: _referee, ...metadata } = bag;
  return { metadata: metadata as Record<string, string>, referee: candidate };
}

/** Inverse of {@link parseApprovalMetadataJson}. Without a referee the bytes match the plain bag. */
export function serializeApprovalMetadata(
  metadata: ApprovalRecord['metadata'],
  referee: ApprovalRecord['referee'],
): string | null {
  if (!referee) return metadata === undefined ? null : JSON.stringify(metadata);
  return JSON.stringify({ ...metadata, [APPROVAL_REFEREE_METADATA_KEY]: referee });
}
