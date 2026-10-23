import { createHash } from 'node:crypto';
import { McpInputError } from './api-error';

type Value = Record<string, unknown>;
interface TranscriptRow {
  id: string; role: string | null; text: string; type: string | null; tool: string | null; file: string | null;
  time: string | null; timestamp: number | null; truncated: boolean; originalTextChars: number;
  textOffset: number; nextTextOffset: number | null; textHash: string;
}
type ApiFetch = (path: string, options?: RequestInit) => Promise<unknown>;
const record = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {};
const meta = (value: unknown, max = 1000) => typeof value === 'string' ? value.slice(0, max) : null;
function integer(value: unknown, fallback: number, min: number, max: number, name: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new McpInputError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

/** Project the existing authenticated transcript read into recoverable bounded text pages. */
export async function readTranscriptTextPage(args: Value, apiFetch: ApiFetch) {
  if (typeof args.sessionKey !== 'string' || !args.sessionKey || args.sessionKey.length > 240) throw new McpInputError('sessionKey is required.');
  if (args.sinceId !== undefined && (typeof args.sinceId !== 'string' || args.sinceId.length > 1000)) throw new McpInputError('sinceId must be a transcript entry ID.');
  const named = args.entryId !== undefined;
  if (named && (typeof args.entryId !== 'string' || !args.entryId || args.entryId.length > 1000)) throw new McpInputError('entryId must be a nonempty transcript entry ID.');
  if (!named && (args.textOffset !== undefined || args.expectedTextHash !== undefined)) throw new McpInputError('Text continuation requires entryId.');
  const offset = integer(args.textOffset, 0, 0, Number.MAX_SAFE_INTEGER, 'textOffset');
  if (args.expectedTextHash !== undefined && (typeof args.expectedTextHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedTextHash))) throw new McpInputError('expectedTextHash must be the returned textHash.');
  if (offset > 0 && args.expectedTextHash === undefined) throw new McpInputError('Text continuation requires expectedTextHash.');
  const limit = integer(args.limit, 20, 1, 100, 'limit');
  const maxTextChars = integer(args.maxTextChars, 4000, 100, 12_000, 'maxTextChars');
  const entryWindowLimit = named ? 100 : limit;
  const query = new URLSearchParams({ sessionKey: args.sessionKey, limit: String(entryWindowLimit) });
  if (typeof args.sinceId === 'string') query.set('sinceId', args.sinceId);
  const data = record(await apiFetch(`/api/runtime/transcript?${query}`, { signal: AbortSignal.timeout(10_000) }));
  let source = Array.isArray(data.transcript) ? data.transcript.map(record) : [];
  if (named) {
    const entry = source.find(entry => entry.id === args.entryId);
    if (!entry) throw new McpInputError('Requested entry is unavailable in this runtime transcript window. Use sinceId to select its preceding entry.');
    source = [entry];
  }
  let textBudget = 24_000;
  let responseBudget = 32_000;
  const transcript: TranscriptRow[] = [];
  const envelope = (entries: TranscriptRow[]) => ({
    entryCount: entries.length, transcript: entries, nextCursor: entries.at(-1)?.id ?? args.sinceId ?? null,
    truncated: source.length > entries.length || entries.some(entry => entry.truncated),
    omittedEntries: Math.max(0, source.length - entries.length), textBudgetChars: 24_000, responseBudgetChars: 35_000,
    maxTextChars, entryWindowLimit,
    cursorPolicy: 'Pass nextCursor as sinceId for newer entries. For omitted text pass entryId, nextTextOffset as textOffset, and textHash as expectedTextHash; reuse sinceId to locate the same window. Named-entry reads search up to 100 entries returned by the runtime; unavailable entries are refused.',
  });
  for (const entry of source.slice(0, named ? 1 : limit)) {
    if (textBudget <= 0) break;
    if (typeof entry.id !== 'string' || entry.id.length > 1000) throw new Error('Transcript entry identity is unavailable.');
    const original = typeof entry.text === 'string' ? entry.text : '';
    const textOffset = named ? offset : 0;
    const textHash = createHash('sha256').update(original).digest('hex');
    if (named && args.expectedTextHash !== undefined && args.expectedTextHash !== textHash) throw new McpInputError('Transcript text changed. Restart this entry at textOffset 0 before continuing.');
    if (textOffset > original.length) throw new McpInputError('textOffset exceeds the current entry text length.');
    const project = (length: number) => ({
      id: entry.id as string, role: meta(entry.role, 100), text: original.slice(textOffset, textOffset + length),
      type: meta(entry.type, 100), tool: meta(entry.toolName), file: meta(entry.filePath), time: meta(entry.timestampLabel, 100),
      timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : null,
      truncated: textOffset > 0 || textOffset + length < original.length, originalTextChars: original.length,
      textOffset, nextTextOffset: textOffset + length < original.length ? textOffset + length : null, textHash,
    });
    let length = Math.min(maxTextChars, textBudget, original.length - textOffset);
    let row = project(length);
    const fits = (candidate: TranscriptRow) => JSON.stringify(candidate).length <= responseBudget
      && JSON.stringify(envelope([...transcript, candidate])).length <= 35_000;
    // Escaping can expand text sixfold in JSON. Shrink the text, rather than
    // dropping a large first row and leaving the caller without a cursor.
    if (!fits(row)) {
      let low = 0; let high = length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(project(middle))) low = middle;
        else high = middle - 1;
      }
      length = low; row = project(length);
    }
    const size = JSON.stringify(row).length;
    if (!fits(row) || (length === 0 && textOffset < original.length)) break;
    textBudget -= length; responseBudget -= size;
    transcript.push(row);
  }
  return envelope(transcript);
}
