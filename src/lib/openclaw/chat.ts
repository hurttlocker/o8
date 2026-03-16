import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MobileTranscriptMedia } from '@/lib/mobile/types';
import type { AgentActivity } from '@/lib/fleet/types';

const execFileAsync = promisify(execFile);
const WORKSPACE_ROOT = process.env.CORTEX_IDE_WORKSPACE_ROOT || '/Users/marquisehurtt/clawd';

export interface SessionTranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  media?: MobileTranscriptMedia[];
  timestamp?: number;
  timestampLabel?: string;
}

type GatewayChatHistoryBlock = Record<string, unknown>;

type GatewayChatHistoryMessage = {
  role?: string;
  content?: unknown;
  timestamp?: number;
};

type GatewayChatHistoryResult = {
  sessionKey: string;
  sessionId?: string;
  messages?: GatewayChatHistoryMessage[];
};

type GatewayChatSendResult = {
  runId?: string;
  status?: 'started' | 'in_flight' | 'ok';
};

type GatewayChatAbortResult = {
  aborted?: boolean;
  runIds?: string[];
};

type ExtractedVisiblePayload = {
  text: string;
  media: MobileTranscriptMedia[];
};

function extractJsonPayload(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('OpenClaw gateway call returned an empty response.');
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }

  const objectIndex = trimmed.indexOf('{');
  const arrayIndex = trimmed.indexOf('[');
  const startIndex = [objectIndex, arrayIndex]
    .filter((value) => value >= 0)
    .sort((left, right) => left - right)[0];

  if (startIndex == null) {
    throw new Error('OpenClaw gateway call did not return JSON output.');
  }

  return trimmed.slice(startIndex);
}

function formatGatewayError(error: unknown) {
  if (error && typeof error === 'object') {
    const stderr = 'stderr' in error ? error.stderr : undefined;
    if (typeof stderr === 'string' && stderr.trim()) {
      return stderr.trim();
    }
    const stdout = 'stdout' in error ? error.stdout : undefined;
    if (typeof stdout === 'string' && stdout.trim()) {
      return stdout.trim();
    }
  }

  return error instanceof Error ? error.message : 'Unknown OpenClaw gateway error';
}

async function callGateway<T>(method: string, params: Record<string, unknown>) {
  // Uses gateway-client which handles REST API + CLI fallback
  try {
    const { gatewayRpc } = await import('@/lib/openclaw/gateway-client');
    return await gatewayRpc<T>(method, params);
  } catch (error) {
    throw new Error(formatGatewayError(error));
  }
}

function formatTimestampLabel(timestamp?: number) {
  if (!timestamp) return undefined;
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function normalizeRole(role?: string): SessionTranscriptEntry['role'] {
  if (role === 'assistant' || role === 'user' || role === 'system' || role === 'tool') {
    return role;
  }

  if (typeof role === 'string' && role.toLowerCase().includes('tool')) {
    return 'tool';
  }

  return 'assistant';
}

function sanitizeVisibleText(text: string) {
  let cleaned = text;

  cleaned = cleaned.replace(/<cortex-memories>[\s\S]*?<\/cortex-memories>/gi, '').trim();
  cleaned = cleaned.replace(/Conversation info \(untrusted metadata\):[\s\S]*?```[\s\S]*?```/gi, '').trim();
  cleaned = cleaned.replace(/Sender \(untrusted metadata\):[\s\S]*?```[\s\S]*?```/gi, '').trim();
  cleaned = cleaned.replace(/To send an image back, prefer the message tool[\s\S]*?Keep caption in the text body\./gi, '').trim();
  cleaned = cleaned.replace(/^System:\s.*$/gim, '').trim();
  cleaned = cleaned.replace(/^Current time:\s.*$/gim, '').trim();
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}

function isAdministrativeEnvelope(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return (
    normalized.startsWith('pre-compaction memory flush.')
    || normalized.includes('reply with exactly: update-recovered')
    || normalized.includes('session was just compacted. the conversation summary above is a hint')
    || normalized === 'no_reply'
    || normalized === 'update-recovered'
  );
}

function inferMediaKind(path: string): MobileTranscriptMedia['kind'] {
  const extension = extname(path).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(extension)) {
    return 'image';
  }
  if (extension === '.pdf') {
    return 'pdf';
  }
  return 'file';
}

function inferMimeType(path: string) {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.pdf':
      return 'application/pdf';
    default:
      return undefined;
  }
}

function normalizeMediaPath(rawPath: string) {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  const unquoted = trimmed.replace(/^['"]|['"]$/g, '').trim();
  if (!unquoted) return null;

  return unquoted;
}

function addMediaPath(media: Map<string, MobileTranscriptMedia>, rawPath: string | null | undefined) {
  const mediaPath = rawPath ? normalizeMediaPath(rawPath) : null;
  if (!mediaPath || media.has(mediaPath)) {
    return;
  }

  media.set(mediaPath, {
    path: mediaPath,
    name: basename(mediaPath),
    kind: inferMediaKind(mediaPath),
    mimeType: inferMimeType(mediaPath),
  });
}

function extractAttachmentEnvelopePath(line: string) {
  const attachmentMatch = line.match(/^\[media attached(?: \d+\/\d+)?:\s*(.+?)\]$/i);
  if (!attachmentMatch) {
    return null;
  }

  const payload = attachmentMatch[1]?.trim() ?? '';
  if (!payload || /^\d+\s+files?$/i.test(payload)) {
    return null;
  }

  const primarySegment = payload.split(' | ')[0]?.trim() ?? '';
  const withoutMime = primarySegment.replace(/\s+\([^)]+\)\s*$/, '').trim();
  return withoutMime || null;
}

function parseMediaLines(text: string) {
  const media = new Map<string, MobileTranscriptMedia>();
  const visibleLines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('MEDIA:')) {
      addMediaPath(media, line.slice('MEDIA:'.length));
      continue;
    }

    if (/^\[media attached/i.test(line)) {
      addMediaPath(media, extractAttachmentEnvelopePath(line));
      continue;
    }

    visibleLines.push(rawLine);
  }

  return {
    text: visibleLines.join('\n').trim(),
    media: Array.from(media.values()),
  } satisfies ExtractedVisiblePayload;
}

function collectTextPayload(block: GatewayChatHistoryBlock) {
  if ((block.type === 'text' || block.type === 'output_text') && typeof block.text === 'string') {
    return block.text;
  }

  if (typeof block.text === 'string') {
    return block.text;
  }

  return '';
}

function extractVisiblePayload(content: unknown) {
  if (typeof content === 'string') {
    return parseMediaLines(content);
  }

  if (!Array.isArray(content)) {
    return { text: '', media: [] } satisfies ExtractedVisiblePayload;
  }

  const textParts: string[] = [];
  const media = new Map<string, MobileTranscriptMedia>();

  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }

    const record = block as GatewayChatHistoryBlock;
    const type = typeof record.type === 'string' ? record.type : '';
    if (type === 'thinking' || type === 'toolCall') {
      continue;
    }

    if (type === 'image') {
      addMediaPath(
        media,
        typeof record.path === 'string'
          ? record.path
          : typeof record.filePath === 'string'
            ? record.filePath
            : typeof record.url === 'string'
              ? record.url
              : null,
      );
    }

    const parsed = parseMediaLines(collectTextPayload(record));
    if (parsed.text) {
      textParts.push(parsed.text);
    }
    for (const item of parsed.media) {
      media.set(item.path, item);
    }
  }

  return {
    text: textParts.join('\n\n').trim(),
    media: Array.from(media.values()),
  } satisfies ExtractedVisiblePayload;
}

function isBareDeliveryMirrorEcho(text: string) {
  return /^[a-z0-9-]+\.(png|jpe?g|gif|webp|pdf)$/i.test(text.trim());
}

const transcriptCache = new Map<string, { entries: SessionTranscriptEntry[]; timestamp: number }>();
const transcriptInflight = new Map<string, Promise<SessionTranscriptEntry[]>>();
const TRANSCRIPT_CACHE_TTL = 5000; // 5 seconds

export async function getSessionTranscript(sessionKey: string, limit = 12, fresh = false) {
  if (!fresh) {
    const cached = transcriptCache.get(sessionKey);
    if (cached && Date.now() - cached.timestamp < TRANSCRIPT_CACHE_TTL) {
      return cached.entries.slice(-limit);
    }
  }

  // Deduplicate: if a request is already in-flight for this session, piggyback
  const existing = transcriptInflight.get(sessionKey);
  if (existing) {
    const entries = await existing;
    return entries.slice(-limit);
  }

  const promise = (async () => {
    try {
      const payload = await callGateway<GatewayChatHistoryResult>('chat.history', {
        sessionKey,
        limit: Math.min(Math.max(limit * 5, 24), 100),
      });

  // Track per-timestamp-role counts to generate stable IDs.
  // Using array index in IDs causes them to shift when the server
  // window slides (new messages arrive), breaking dedup in the
  // client merge logic and causing duplicate/out-of-order entries.
  const idCounts = new Map<string, number>();
  function stableId(timestamp: number | undefined, role: string, suffix?: string) {
    const base = `${sessionKey}:${timestamp ?? 0}:${role}${suffix ? `:${suffix}` : ''}`;
    const count = idCounts.get(base) ?? 0;
    idCounts.set(base, count + 1);
    return count === 0 ? base : `${base}:${count}`;
  }

  const entries = (payload.messages ?? [])
    .map((message) => {
      const sourceRole = normalizeRole(message.role);
      const { text, media } = extractVisiblePayload(message.content);
      const cleanedText = sanitizeVisibleText(text);

      if (sourceRole === 'tool') {
        if (!media.length) {
          return null;
        }

        if (cleanedText && !isAdministrativeEnvelope(cleanedText) && !isBareDeliveryMirrorEcho(cleanedText)) {
          return null;
        }

        return {
          id: stableId(message.timestamp, 'assistant', 'media'),
          role: 'assistant',
          text: '',
          media,
          timestamp: message.timestamp,
          timestampLabel: formatTimestampLabel(message.timestamp),
        } as SessionTranscriptEntry;
      }

      if (!cleanedText && !media.length) {
        return null;
      }

      if (!media.length && isBareDeliveryMirrorEcho(cleanedText)) {
        return null;
      }

      if (!media.length && isAdministrativeEnvelope(cleanedText)) {
        return null;
      }

      return {
        id: stableId(message.timestamp, sourceRole),
        role: sourceRole,
        text: cleanedText,
        media,
        timestamp: message.timestamp,
        timestampLabel: formatTimestampLabel(message.timestamp),
      } as SessionTranscriptEntry;
    })
    .filter(Boolean) as SessionTranscriptEntry[];

      transcriptCache.set(sessionKey, { entries, timestamp: Date.now() });
      return entries;
    } finally {
      transcriptInflight.delete(sessionKey);
    }
  })();

  transcriptInflight.set(sessionKey, promise);
  const entries = await promise;
  return entries.slice(-limit);
}

export async function steerOpenClawSession(
  sessionKey: string,
  message?: string,
  attachments?: Array<{
    type?: string;
    mimeType: string;
    fileName: string;
    content: string;
  }>,
) {
  const trimmed = message?.trim() ?? '';
  const normalizedAttachments = Array.isArray(attachments)
    ? attachments.filter((item) => item?.content && item?.mimeType && item?.fileName)
    : [];

  if (!trimmed && normalizedAttachments.length === 0) {
    throw new Error('Steer message or image attachment is required.');
  }

  return callGateway<GatewayChatSendResult>('chat.send', {
    sessionKey,
    message: trimmed,
    attachments: normalizedAttachments.length > 0 ? normalizedAttachments : undefined,
    idempotencyKey: randomUUID(),
  });
}

export async function abortOpenClawSession(sessionKey: string, runId?: string) {
  return callGateway<GatewayChatAbortResult>('chat.abort', {
    sessionKey,
    ...(runId ? { runId } : {}),
  });
}

// ── Observable agent activity extraction ──

const TOOL_HEADLINES: Record<string, (args: Record<string, unknown>) => string> = {
  Read: (a) => `Reading ${shortenFilePath(String(a.file_path ?? a.path ?? ''))}`,
  Edit: (a) => `Editing ${shortenFilePath(String(a.file_path ?? a.path ?? ''))}`,
  Write: (a) => `Writing ${shortenFilePath(String(a.file_path ?? a.path ?? ''))}`,
  exec: (a) => {
    const cmd = String(a.command ?? '');
    if (cmd.includes('npm run')) return `Running ${cmd.match(/npm run \S+/)?.[0] ?? 'npm'}`;
    if (cmd.includes('git ')) return `Running ${cmd.match(/git \S+/)?.[0] ?? 'git'}`;
    if (cmd.includes('curl')) return 'Fetching API data';
    if (cmd.includes('grep') || cmd.includes('rg ')) return 'Searching codebase';
    if (cmd.includes('kill') || cmd.includes('lsof')) return 'Managing processes';
    return `Running ${truncate(cmd.split('&&')[0].split('|')[0].trim(), 32)}`;
  },
  process: (a) => {
    const action = String(a.action ?? '');
    if (action === 'poll') return 'Watching process output';
    if (action === 'log') return 'Reading process log';
    if (action === 'kill') return 'Stopping process';
    if (action === 'list') return 'Checking running processes';
    return 'Managing process';
  },
  web_search: (a) => `Searching "${truncate(String(a.query ?? ''), 36)}"`,
  web_fetch: (a) => `Fetching ${truncate(String(a.url ?? ''), 40)}`,
  browser: (a) => {
    const action = String(a.action ?? '');
    if (action === 'snapshot' || action === 'screenshot') return 'Capturing page';
    if (action === 'navigate') return 'Navigating browser';
    return 'Using browser';
  },
  image: () => 'Analyzing image',
  message: (a) => {
    const action = String(a.action ?? '');
    if (action === 'send') return 'Sending message';
    if (action === 'react') return 'Adding reaction';
    return 'Managing messages';
  },
  memory_search: (a) => `Searching memory for "${truncate(String(a.query ?? ''), 28)}"`,
  memory_get: () => 'Reading memory',
  cortex_search: (a) => `Searching Cortex for "${truncate(String(a.query ?? ''), 28)}"`,
  cortex_store: () => 'Saving to memory',
  sessions_spawn: () => 'Spawning sub-agent',
  sessions_list: () => 'Checking agent sessions',
  session_status: () => 'Checking session status',
  subagents: () => 'Managing sub-agents',
  tts: () => 'Generating speech',
  cron: (a) => {
    const action = String(a.action ?? '');
    if (action === 'add') return 'Creating scheduled job';
    if (action === 'list') return 'Checking schedules';
    return 'Managing schedules';
  },
  gateway: (a) => {
    const action = String(a.action ?? '');
    if (action === 'config.patch' || action === 'config.apply') return 'Updating config';
    if (action === 'restart') return 'Restarting gateway';
    return 'Managing gateway';
  },
  diffs: () => 'Generating diff view',
  pdf: () => 'Analyzing PDF',
  nodes: () => 'Checking paired devices',
};

function shortenFilePath(filePath: string): string {
  if (!filePath) return 'file';
  const parts = filePath.split('/');
  if (parts.length <= 2) return filePath;
  return `…/${parts.slice(-2).join('/')}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function extractToolCallsFromContent(content: unknown): Array<{ name: string; args: Record<string, unknown> }> {
  if (!content) return [];

  if (Array.isArray(content)) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      // OpenClaw format: type=toolCall, name, arguments (as string or object)
      if (b.type === 'toolCall' && typeof b.name === 'string') {
        const parsedArgs = typeof b.arguments === 'string' ? safeJsonParse(b.arguments) : (b.arguments ?? {});
        calls.push({ name: b.name, args: parsedArgs as Record<string, unknown> });
      }
      // Anthropic format: type=tool_use, name, input
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        calls.push({ name: b.name, args: (b.input ?? {}) as Record<string, unknown> });
      }
      // OpenAI format: type=function_call, name, arguments
      if (b.type === 'function_call' && typeof b.name === 'string') {
        const parsedArgs = typeof b.arguments === 'string' ? safeJsonParse(b.arguments) : (b.arguments ?? {});
        calls.push({ name: b.name, args: parsedArgs as Record<string, unknown> });
      }
    }
    return calls;
  }

  return [];
}

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return {}; }
}

function deriveActivityFromMessages(messages: GatewayChatHistoryMessage[]): AgentActivity | undefined {
  // Walk backward from the last message to find the latest meaningful activity
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    // Skip tool results — we want the tool *call*, not the result
    if (msg.role === 'tool' || msg.role === 'toolResult') continue;

    // Check for tool calls in assistant messages
    if (msg.role === 'assistant') {
      const toolCalls = extractToolCallsFromContent(msg.content);
      if (toolCalls.length > 0) {
        const lastCall = toolCalls[toolCalls.length - 1];
        const headlineFn = TOOL_HEADLINES[lastCall.name];
        const headline = headlineFn
          ? headlineFn(lastCall.args)
          : `Using ${lastCall.name}`;
        const filePath = String(lastCall.args.file_path ?? lastCall.args.path ?? '');
        return {
          headline,
          toolName: lastCall.name,
          filePath: filePath || undefined,
          timestamp: msg.timestamp,
        };
      }

      // Assistant text without tool calls — agent is composing a response
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text.length > 10) {
        return {
          headline: `Responded · ${truncate(text.replace(/\n/g, ' '), 38)}`,
          timestamp: msg.timestamp,
        };
      }
    }
  }

  return undefined;
}

const activityCache = new Map<string, { activity: AgentActivity | undefined; timestamp: number }>();
const ACTIVITY_CACHE_TTL = 8000;

/** Fetch the latest observable activity for an agent session */
export async function getSessionActivity(sessionKey: string): Promise<AgentActivity | undefined> {
  const cached = activityCache.get(sessionKey);
  if (cached && Date.now() - cached.timestamp < ACTIVITY_CACHE_TTL) {
    return cached.activity;
  }

  try {
    const payload = await callGateway<GatewayChatHistoryResult>('chat.history', {
      sessionKey,
      limit: 8,
    });

    const activity = deriveActivityFromMessages(payload.messages ?? []);
    activityCache.set(sessionKey, { activity, timestamp: Date.now() });
    return activity;
  } catch {
    return undefined;
  }
}
