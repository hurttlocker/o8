/**
 * Client-safe artifact shapes (#1147). Mirror of the server store's
 * `toArtifactRef` output — defined here so client components never import the
 * server-only store module (which pulls better-sqlite3).
 */

export type ArtifactKind = 'screenshot' | 'video';
export type ArtifactSource = 'agent-capture' | 'review-boundary' | 'manual';
export type ArtifactPhase = 'before' | 'after' | null;

export interface ArtifactRef {
  id: string;
  /** Loopback serve URL for the still/media. */
  url: string;
  kind: ArtifactKind;
  source: ArtifactSource;
  phase: ArtifactPhase;
  pairId: string | null;
  label: string | null;
  width: number | null;
  height: number | null;
  capturedAt: string;
}

/** A before/after pair (or a single frame) grouped for the strip. */
export interface ArtifactGroup {
  key: string;
  before: ArtifactRef | null;
  after: ArtifactRef | null;
  /** Non-paired singles render here when there's no before/after split. */
  single: ArtifactRef | null;
}

/**
 * Group artifacts into before/after pairs (by pairId) + standalone singles.
 * Oldest-first input → pairs preserve capture order; singles fall through.
 */
export function groupArtifacts(artifacts: ArtifactRef[]): ArtifactGroup[] {
  const byPair = new Map<string, ArtifactGroup>();
  const groups: ArtifactGroup[] = [];

  for (const a of artifacts) {
    if (a.pairId && a.phase) {
      let g = byPair.get(a.pairId);
      if (!g) {
        g = { key: `pair:${a.pairId}`, before: null, after: null, single: null };
        byPair.set(a.pairId, g);
        groups.push(g);
      }
      if (a.phase === 'before') g.before = a;
      else g.after = a;
    } else {
      groups.push({ key: `single:${a.id}`, before: null, after: null, single: a });
    }
  }
  return groups;
}
