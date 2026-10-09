export type CodexSessionPruneMode = 'archive' | 'delete';

export type CodexSessionPruneOptions = {
  archiveRoot?: string;
  maxAgeDays?: number;
  mode?: CodexSessionPruneMode;
  now?: number;
  sessionsRoot?: string;
};

/** Provider JSONL files are external records, not o8-owned runtime sessions. */
export class UnsupportedCodexTranscriptRetentionError extends Error {
  readonly code = 'unsupported_external_transcript_retention';
  readonly capabilities = { archive: false, purge: false } as const;

  constructor() {
    super('External Codex transcript retention is controlled by the provider. Use its supported retention controls.');
    this.name = 'UnsupportedCodexTranscriptRetentionError';
  }
}

/**
 * Keep the legacy entry point fail-closed. Age and a missing workspace cannot
 * grant ownership of provider transcripts, and owned runtime archival uses
 * its separate lifecycle interface.
 */
export async function pruneCodexSessions(_options: CodexSessionPruneOptions = {}): Promise<never> {
  throw new UnsupportedCodexTranscriptRetentionError();
}
