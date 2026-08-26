import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printJson, type OutputMode } from '../output.js';

interface HistoryAudit {
  laneId: string;
  packetId: string | null;
}

interface HistoryEntry {
  kind: 'message' | 'handoff';
  id: string;
  timestamp: number;
  role: string;
  content: string;
  backend: string | null;
  model: string | null;
  handoff: {
    from: { backend: string; model: string | null } | null;
    to: { backend: string; model: string | null };
    lossless: boolean;
    carries: Record<string, 'full' | 'summary' | 'omitted'>;
  } | null;
  audits: HistoryAudit[];
}

interface HistoryResponse {
  ok: boolean;
  thread: { id: string; title: string | null; repoPath: string | null; modifiedAt: string };
  count: number;
  truncated: boolean;
  timeline: HistoryEntry[];
}

function parseArgs(args: string[]): { threadId: string; limit?: number } {
  let threadId = '';
  let limit: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--limit') {
      const raw = args[index + 1];
      const parsed = Number.parseInt(raw ?? '', 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) {
        throw new CliError('invalid_args', '--limit must be an integer from 1 to 1000.', EXIT.INVALID_ARGS);
      }
      limit = parsed;
      index += 1;
    } else if (!value.startsWith('-') && !threadId) {
      threadId = value;
    } else {
      throw new CliError('invalid_args', `Unknown history argument: ${value}`, EXIT.INVALID_ARGS);
    }
  }
  if (!threadId.startsWith('thoughts-')) {
    throw new CliError('invalid_args', 'Usage: o8 history <thoughts-thread-id> [--limit 200]', EXIT.INVALID_ARGS);
  }
  return { threadId, limit };
}

function oneLine(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 180 ? `${compact.slice(0, 179)}…` : compact;
}

export async function runHistory(mode: OutputMode, args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const cfg = resolveConfig();
  const response = await apiFetch<HistoryResponse>(cfg, '/api/orchestrator/history', {
    query: { threadId: parsed.threadId, limit: parsed.limit },
  });
  const history = response.data;
  if (!history?.ok || !Array.isArray(history.timeline)) {
    throw new CliError('invalid_response', 'History endpoint returned an invalid response.', EXIT.INVALID_ARGS);
  }

  if (!mode.human) {
    printJson({ ...history, schema: 'o8/cli/history/v1' });
    return 0;
  }

  printHumanHeading(`o8 history ${history.thread.id}`);
  for (const entry of history.timeline) {
    const at = Number.isFinite(entry.timestamp) ? new Date(entry.timestamp).toISOString() : 'unknown-time';
    if (entry.kind === 'handoff' && entry.handoff) {
      const source = entry.handoff.from?.model ?? entry.handoff.from?.backend ?? 'unknown';
      const destination = entry.handoff.to.model ?? entry.handoff.to.backend;
      const omitted = Object.entries(entry.handoff.carries)
        .filter(([, carried]) => carried === 'omitted')
        .map(([layer]) => layer);
      process.stdout.write(`${at}  handoff  ${source} -> ${destination}  ${entry.handoff.lossless ? 'lossless' : 'cold'}${omitted.length ? `  omitted:${omitted.join(',')}` : ''}  audit:${entry.audits.length}\n`);
      continue;
    }
    process.stdout.write(`${at}  ${entry.role.padEnd(9)} ${(entry.model ?? entry.backend ?? 'operator').padEnd(22)} ${oneLine(entry.content)}\n`);
  }
  if (history.truncated) process.stdout.write(`… showing ${history.timeline.length} of ${history.count} entries; raise --limit for more.\n`);
  return 0;
}
