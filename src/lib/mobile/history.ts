import { getOwnedCodexRuntimeTail } from '@/lib/codex/owned';
import { getCodexRuntimeTail } from '@/lib/codex/sessions';
import { loadMobileLlmChatHistory } from '@/lib/llm/mobile-llm-chat';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import '@/lib/runtimes';
import { getRuntime } from '@/lib/runtimes/registry';

function runtimeTailRole(label: string): MobileTranscriptEntry['role'] {
  const normalized = label.toLowerCase();
  if (normalized.includes('assistant')) return 'assistant';
  if (normalized.includes('user')) return 'user';
  if (normalized.includes('tool')) return 'tool';
  return 'system';
}

function parseToolArgs(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { input: parsed };
  } catch {
    return { input: trimmed };
  }
}

function toolCallFromEntry(name: string, text: string): MobileTranscriptToolCall {
  return {
    name: name || 'tool',
    args: parseToolArgs(text),
    status: 'done',
  };
}

export async function getMobileSessionTranscript(
  sessionKey: string,
  limit = 50,
  _fresh = false,
): Promise<MobileTranscriptEntry[]> {
  void _fresh;

  if (sessionKey.startsWith('llm-chat:')) {
    return loadMobileLlmChatHistory(sessionKey, limit).transcript;
  }

  if (sessionKey.startsWith('codex-owned:')) {
    const tail = await getOwnedCodexRuntimeTail(sessionKey);
    const chatTranscript: MobileTranscriptEntry[] = [];
    const groups = tail.groups ?? [];

    for (const group of groups) {
      const pendingToolCalls: MobileTranscriptToolCall[] = [];
      const promptText = group.prompt?.trim();
      if (promptText) {
        chatTranscript.push({
          id: `${group.id}-prompt`,
          role: 'user',
          text: promptText,
          timestampLabel: group.startedAtLabel,
        });
      }

      for (const entry of group.entries) {
        const text = entry.text.trim();
        if (!text) continue;
        if (promptText && text === promptText) continue;
        if (text.startsWith('Usage •') || text.includes('Owned Codex session') || text.includes('Codex run launched')) continue;

        const role = runtimeTailRole(entry.label);
        if (role === 'assistant') {
          chatTranscript.push({
            id: entry.id,
            role: 'assistant',
            text,
            toolCalls: pendingToolCalls.length > 0 ? [...pendingToolCalls] : undefined,
            timestampLabel: entry.timestampLabel,
          });
          pendingToolCalls.length = 0;
        } else if (entry.kind === 'tool') {
          pendingToolCalls.push(toolCallFromEntry(entry.label || 'exec_command', entry.text));
        }
      }

      if (pendingToolCalls.length > 0) {
        chatTranscript.push({
          id: `${group.id}-tool-batch`,
          role: 'assistant',
          text: '',
          toolCalls: [...pendingToolCalls],
          timestampLabel: group.finishedAtLabel ?? group.startedAtLabel,
        });
      }
    }

    return chatTranscript;
  }

  if (sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-discovered:')) {
    const tail = await getCodexRuntimeTail(sessionKey);
    const transcript: MobileTranscriptEntry[] = [];
    for (const entry of tail.entries ?? []) {
      if (entry.kind === 'event' && entry.label === 'Agent update') {
        transcript.push({ id: entry.id, role: 'assistant', text: entry.text, timestampLabel: entry.timestampLabel });
        continue;
      }
      if (entry.kind === 'tool') {
        transcript.push({
          id: entry.id,
          role: 'assistant',
          text: '',
          toolCalls: [toolCallFromEntry(entry.label || 'tool', entry.text)],
          timestampLabel: entry.timestampLabel,
        });
        continue;
      }
      if (entry.kind === 'message') {
        const role = runtimeTailRole(entry.label);
        if (role === 'system' || role === 'user') {
          const lowerText = entry.text.toLowerCase();
          if (lowerText.includes('<permissions') || lowerText.includes('collaboration_mode') || lowerText.includes('# agents.md') || lowerText.includes('sandbox_mode')) continue;
        }
        transcript.push({ id: entry.id, role, text: entry.text, timestampLabel: entry.timestampLabel });
      }
    }

    const seen = new Set<string>();
    const deduped: MobileTranscriptEntry[] = [];
    for (const entry of transcript) {
      const toolKey = (entry.toolCalls ?? [])
        .map((tool) => `${tool.name}:${JSON.stringify(tool.args ?? {})}`)
        .join('|');
      const key = `${entry.role}:${entry.text.trim().slice(0, 200)}:${toolKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(entry);
    }
    return deduped;
  }

  if (sessionKey.startsWith('claude-code:')) {
    const runtime = getRuntime('claude-code');
    if (!runtime?.readTranscript) return [];
    const entries = await runtime.readTranscript(sessionKey, undefined, limit);
    return entries.map((entry) => ({
      id: entry.id,
      role: entry.role === 'tool' ? 'tool' : entry.role === 'assistant' ? 'assistant' : entry.role === 'user' ? 'user' : 'system',
      text: entry.text,
      timestamp: entry.timestamp.getTime(),
      timestampLabel: entry.timestamp
        ? entry.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : '',
    }));
  }

  return [];
}
