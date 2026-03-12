import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MobileTranscriptMedia } from '@/lib/mobile/types';

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
  try {
    const { stdout } = await execFileAsync(
      'openclaw',
      ['gateway', 'call', method, '--json', '--params', JSON.stringify(params)],
      {
        cwd: WORKSPACE_ROOT,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    return JSON.parse(extractJsonPayload(stdout)) as T;
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

export async function getSessionTranscript(sessionKey: string, limit = 12) {
  const payload = await callGateway<GatewayChatHistoryResult>('chat.history', {
    sessionKey,
    limit: Math.min(Math.max(limit * 5, 24), 100),
  });

  const entries = (payload.messages ?? [])
    .map((message, index) => {
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
          id: `${sessionKey}:${message.timestamp ?? index}:${index}:media`,
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
        id: `${sessionKey}:${message.timestamp ?? index}:${index}`,
        role: sourceRole,
        text: cleanedText,
        media,
        timestamp: message.timestamp,
        timestampLabel: formatTimestampLabel(message.timestamp),
      } as SessionTranscriptEntry;
    })
    .filter(Boolean) as SessionTranscriptEntry[];

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
