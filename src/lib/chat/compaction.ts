/**
 * Chat compaction — compress older messages into a dense context summary.
 * Uses the cheapest available model via our own proxy route.
 *
 * Architecture: fires when messages exceed threshold, replaces oldest N
 * with a single compaction node. Also stores the summary in Cortex for
 * cross-session persistence.
 */

export interface LLMMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
  isError?: boolean;
  isCompaction?: boolean;
  compactedCount?: number;
}

export interface CompactionResult {
  newMessages: LLMMessage[];
  summary: string;
  compactedCount: number;
}

const COMPACTION_THRESHOLD = 40; // Trigger when messages exceed this
const KEEP_RECENT = 8; // Keep last N messages raw
const MAX_TRANSCRIPT_CHARS = 12_000; // Cap transcript size for cheap model

const COMPACTION_PROMPT = `You are compressing a developer's chat history to save context window space.
Drop pleasantries, conversational filler, and redundant back-and-forth.

STRICTLY PRESERVE:
1. Exact file paths (e.g., src/lib/chat.ts)
2. Code decisions, variable names, architecture choices
3. Unresolved tasks or bugs
4. User preferences explicitly stated
5. Tool results and their outcomes
6. Error messages and fixes applied

Output a dense, bulleted list of facts, decisions, and context.
No intro or outro. Just the facts.`;

/**
 * Check if compaction should trigger.
 */
export function shouldCompact(messageCount: number): boolean {
  return messageCount > COMPACTION_THRESHOLD;
}

/**
 * Run compaction via our proxy route (uses cheapest available model).
 */
export async function compactConversation(
  messages: LLMMessage[],
  tabId: string,
): Promise<CompactionResult> {
  if (messages.length <= KEEP_RECENT) {
    return { newMessages: messages, summary: '', compactedCount: 0 };
  }

  const messagesToCompact = messages.slice(0, messages.length - KEEP_RECENT);
  const recentMessages = messages.slice(messages.length - KEEP_RECENT);

  // Build transcript from older messages
  let transcript = messagesToCompact
    .filter(m => !m.isError && m.content.trim())
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  // Cap transcript length
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);
  }

  // Call our proxy with a cheap model for summarization
  const res = await fetch('/api/v2/proxy/llm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tab-id': tabId,
    },
    body: JSON.stringify({
      model: 'gemini-2.5-flash-lite',
      provider: 'google',
      messages: [
        { role: 'user', content: `${COMPACTION_PROMPT}\n\n---\n\nCompress this conversation:\n\n${transcript}` },
      ],
    }),
  });

  if (!res.ok || !res.body) {
    console.error('[compaction] Proxy call failed:', res.status);
    return { newMessages: messages, summary: '', compactedCount: 0 };
  }

  // Parse SSE stream for content
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let summary = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content' && parsed.text) {
          summary += parsed.text;
        }
      } catch { /* skip */ }
    }
  }

  if (!summary) {
    console.error('[compaction] No summary generated');
    return { newMessages: messages, summary: '', compactedCount: 0 };
  }

  // Create compaction message
  const compactionMessage: LLMMessage = {
    id: `compaction-${Date.now()}`,
    role: 'system',
    content: `<compacted_context>\n${summary}\n</compacted_context>`,
    timestamp: Date.now(),
    isCompaction: true,
    compactedCount: messagesToCompact.length,
  };

  // Store summary in Cortex for cross-session persistence
  try {
    await fetch('/api/v2/cortex/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'import',
        args: `Chat compaction summary (${messagesToCompact.length} messages):\n\n${summary}`,
      }),
    });
  } catch {
    // Non-critical — compaction still works without Cortex storage
  }

  console.log(`[compaction] Compressed ${messagesToCompact.length} messages into ${summary.length} char summary`);

  return {
    newMessages: [compactionMessage, ...recentMessages],
    summary,
    compactedCount: messagesToCompact.length,
  };
}
