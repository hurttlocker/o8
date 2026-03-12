import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WORKSPACE_ROOT = process.env.CORTEX_IDE_WORKSPACE_ROOT || '/Users/marquisehurtt/clawd';

export interface SessionTranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  timestamp?: number;
  timestampLabel?: string;
}

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

function extractVisibleText(content: unknown) {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts = content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') {
        return [] as string[];
      }

      const record = block as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type : '';

      if (type === 'thinking') {
        return [] as string[];
      }

      if ((type === 'text' || type === 'output_text') && typeof record.text === 'string') {
        const value = record.text.trim();
        return value ? [value] : [];
      }

      if (typeof record.text === 'string') {
        const value = record.text.trim();
        return value ? [value] : [];
      }

      return [] as string[];
    })
    .filter((value) => value.trim().length > 0);

  return parts.join('\n\n').trim();
}

export async function getSessionTranscript(sessionKey: string, limit = 12) {
  const payload = await callGateway<GatewayChatHistoryResult>('chat.history', {
    sessionKey,
    limit: Math.min(Math.max(limit * 4, 20), 80),
  });

  return (payload.messages ?? [])
    .map((message, index) => {
      const role = normalizeRole(message.role);
      if (role === 'tool') return null;

      const text = extractVisibleText(message.content);
      if (!text) return null;

      return {
        id: `${sessionKey}:${message.timestamp ?? index}:${index}`,
        role,
        text,
        timestamp: message.timestamp,
        timestampLabel: formatTimestampLabel(message.timestamp),
      } as SessionTranscriptEntry;
    })
    .filter(Boolean)
    .slice(-limit) as SessionTranscriptEntry[];
}

export async function steerOpenClawSession(sessionKey: string, message: string) {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error('Steer message is required.');
  }

  return callGateway<GatewayChatSendResult>('chat.send', {
    sessionKey,
    message: trimmed,
    idempotencyKey: randomUUID(),
  });
}

export async function abortOpenClawSession(sessionKey: string, runId?: string) {
  return callGateway<GatewayChatAbortResult>('chat.abort', {
    sessionKey,
    ...(runId ? { runId } : {}),
  });
}
