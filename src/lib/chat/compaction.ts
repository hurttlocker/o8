/**
 * Cortex-aware chat compaction — recursive multi-pass compression.
 *
 * Pass 1: Extract facts → store in Cortex (don't repeat known facts)
 * Pass 2: Query Cortex for what's already known about the conversation topics
 * Pass 3: Summarize only what's NEW — open threads, decisions, current state
 *
 * The result is a dense, high-signal summary that doesn't waste tokens
 * re-stating things Cortex already knows.
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

const COMPACTION_THRESHOLD = 40;
const KEEP_RECENT = 8;
const MAX_TRANSCRIPT_CHARS = 12_000;

export function shouldCompact(messageCount: number): boolean {
  return messageCount > COMPACTION_THRESHOLD;
}

/**
 * Cortex-aware recursive compaction.
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

  // Build transcript
  let transcript = messagesToCompact
    .filter(m => !m.isError && m.content.trim())
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);
  }

  // ── Pass 1: Query Cortex for what it already knows ──
  // Extract key topics from the conversation to search against
  let knownFacts = '';
  try {
    const topicRes = await fetch('/api/v2/proxy/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tab-id': tabId },
      body: JSON.stringify({
        model: 'gemini-2.5-flash-lite',
        provider: 'google',
        messages: [{
          role: 'user',
          content: `Extract 3-5 key topic keywords from this conversation. Return ONLY comma-separated keywords, nothing else.\n\n${transcript.slice(0, 3000)}`,
        }],
      }),
    });

    if (topicRes.ok && topicRes.body) {
      const topics = await parseSSEContent(topicRes.body);
      if (topics) {
        // Search Cortex for each topic
        const topicList = topics.split(',').map(t => t.trim()).filter(Boolean).slice(0, 5);
        const cortexResults: string[] = [];

        for (const topic of topicList) {
          try {
            const searchRes = await fetch(`/api/v2/cortex/search?q=${encodeURIComponent(topic)}&limit=3`);
            if (searchRes.ok) {
              const data = await searchRes.json();
              if (data.results) {
                for (const r of data.results) {
                  if (r.snippet) cortexResults.push(r.snippet.slice(0, 150));
                }
              }
            }
          } catch { /* continue */ }
        }

        if (cortexResults.length > 0) {
          knownFacts = cortexResults.slice(0, 10).join('\n');
        }
      }
    }
  } catch (err) {
    console.error('[compaction] Pass 1 (topic extraction) failed:', err);
  }

  // ── Pass 2: Smart compression — knows what Cortex already has ──
  // Optionally include skeleton map so the compressor knows real codebase structure.
  // Fetched via API (not direct import) because this module is bundled for the client
  // and skeleton depends on better-sqlite3 which is Node-only.
  let skeletonContext = '';
  try {
    const skeletonRes = await fetch('/api/panel/skeleton');
    if (skeletonRes.ok) {
      const skeletonData = await skeletonRes.json();
      if (skeletonData.rendered?.text) {
        skeletonContext = `\n## CODEBASE STRUCTURE (for reference — use to validate file paths and symbol names)\n${skeletonData.rendered.text}\n`;
      }
    }
  } catch {
    // Skeleton not available — continue without it
  }

  const compactionPrompt = `You are compressing a developer's chat history for a coding IDE.

## CRITICAL RULES
1. Preserve the NARRATIVE ARC — what was the user trying to do? What decisions were made? What's still open?
2. Structure as: GOAL → DECISIONS → CURRENT STATE → OPEN ITEMS
3. Preserve exact file paths, function names, commit hashes, issue numbers
4. Drop: greetings, "sounds good", "let me check", thinking-out-loud, tool execution details
5. Keep: architecture decisions, user preferences, error descriptions, what worked vs didn't
6. If a fact is already known to the system, reference it briefly — don't restate the full detail

## FORMAT
Write a dense narrative summary in this structure:

**Session Goal:** [one line]

**Key Decisions:**
- [decision with reasoning]

**Work Completed:**
- [what was built/fixed, with file paths and commits]

**Current State:**
- [what's working, what's broken, what's in progress]

**Open Items:**
- [unresolved questions, next steps the user mentioned]

${knownFacts ? `\n## ALREADY KNOWN (Cortex has these — reference briefly, don't restate)\n${knownFacts}\n` : ''}${skeletonContext}`;

  // Call proxy for the actual compression
  const res = await fetch('/api/v2/proxy/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tab-id': tabId },
    body: JSON.stringify({
      model: 'gemini-2.5-flash-lite',
      provider: 'google',
      messages: [{
        role: 'user',
        content: `${compactionPrompt}\n\n---\n\nCompress this conversation:\n\n${transcript}`,
      }],
    }),
  });

  if (!res.ok || !res.body) {
    console.error('[compaction] Pass 2 (compression) failed:', res.status);
    return { newMessages: messages, summary: '', compactedCount: 0 };
  }

  const summary = await parseSSEContent(res.body);

  if (!summary) {
    console.error('[compaction] No summary generated');
    return { newMessages: messages, summary: '', compactedCount: 0 };
  }

  // ── Pass 3: Store the summary in Cortex for cross-session recall ──
  try {
    // Write to temp file and import
    const storeRes = await fetch('/api/v2/cortex/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'import',
        args: `Chat session compaction (${messagesToCompact.length} messages, tab: ${tabId}):\n\n${summary}`,
      }),
    });
    if (storeRes.ok) {
      console.log('[compaction] Summary stored in Cortex');
    }
  } catch {
    // Non-critical
  }

  // Build compaction message
  const compactionMessage: LLMMessage = {
    id: `compaction-${Date.now()}`,
    role: 'system',
    content: `<compacted_context>\n${summary}\n</compacted_context>`,
    timestamp: Date.now(),
    isCompaction: true,
    compactedCount: messagesToCompact.length,
  };

  console.log(`[compaction] Compressed ${messagesToCompact.length} messages → ${summary.length} chars (${knownFacts ? 'Cortex-aware' : 'standalone'})`);

  return {
    newMessages: [compactionMessage, ...recentMessages],
    summary,
    compactedCount: messagesToCompact.length,
  };
}

/**
 * Parse SSE stream and extract accumulated content text.
 */
async function parseSSEContent(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';

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
          content += parsed.text;
        }
      } catch { /* skip */ }
    }
  }

  return content;
}
