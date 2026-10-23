export const TRANSCRIPT_READ_TOOL = {
  description:
    'Read a runtime transcript with stable entry IDs. Pass nextCursor as sinceId for newer entries. Retrieve omitted text with entryId, nextTextOffset as textOffset, and textHash as expectedTextHash. Reads are bounded; changed text and unavailable entries are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionKey: {
        type: 'string',
        description: 'The surfaceId/sessionKey of the agent session.',
      },
      limit: {
        type: 'number',
        description: 'Number of transcript entries to return, 1 to 100. Default 20.',
      },
      entryId: { type: 'string', description: 'Read text from this exact entry within the selected runtime window (up to 100 entries). Reuse sinceId to locate the same window.' },
      textOffset: { type: 'integer', minimum: 0, description: 'UTF-16 character offset within entryId. Default 0; a positive offset requires expectedTextHash.' },
      expectedTextHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Full-entry textHash from the prior read; required for a positive textOffset. Changed text is refused.' },
      sinceId: { type: 'string', description: 'Existing transcript entry ID; return entries after it.' },
      maxTextChars: { type: 'integer', minimum: 100, maximum: 12000, description: 'Maximum characters per text preview. Default 4000; total text is bounded to 24000 characters.' },
    },
    required: ['sessionKey'],
  },
};
