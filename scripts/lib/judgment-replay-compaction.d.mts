// Types for judgment-replay-compaction.mjs (allowJs is off repo-wide).
export interface CompactionRow {
  p: number;
  y: 0 | 1;
  packet: string;
  entryId: string;
  identifiers: string[];
}
export interface CompactionNotes {
  archivesRead: number;
  scored: number;
  withoutScorer: number;
  withoutLaterTurns: number;
  entriesWithoutIdentifiers: number;
}
export interface CompactionArchive {
  ref: string;
  tabId?: string | null;
  archivedAt: string;
  turns: Array<Record<string, unknown>>;
  scorer?: { scores?: Record<string, number> };
}
export function extractIdentifiers(text: string): string[];
export function labelCompaction(
  archives: CompactionArchive[],
  threads: Map<string, Array<Record<string, unknown>>>,
): { rows: CompactionRow[]; notes: CompactionNotes };
export function loadCompactionHistory(dataDir: string): {
  archives: CompactionArchive[];
  threads: Map<string, Array<Record<string, unknown>>>;
};
