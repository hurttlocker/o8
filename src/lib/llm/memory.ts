/**
 * Cortex Memory Recall for LLM Chat
 *
 * Phase A: Pre-flight injection — search Cortex for relevant facts
 * based on user's message, format them for system prompt injection.
 *
 * Token budget: ~800 tokens max to avoid bloating context.
 */

import { getCortexClient } from '@/lib/cortex/client';

const MAX_RECALL_TOKENS = 800; // ~3200 chars at 4 chars/token
const MAX_RECALL_RESULTS = 7;
const MIN_CONFIDENCE = 0.3;

interface RecallResult {
  text: string;       // Formatted memory block for system prompt
  factCount: number;  // How many facts were recalled
  queryMs: number;    // How long the search took
}

/**
 * Search Cortex for memories relevant to the user's message.
 * Returns a formatted text block ready for system prompt injection.
 *
 * Returns null if Cortex is unavailable or no relevant facts found.
 */
export async function recallMemories(userMessage: string): Promise<RecallResult | null> {
  const start = Date.now();

  try {
    const client = getCortexClient();

    // Search with the user's message as query
    const results = await client.search(userMessage, MAX_RECALL_RESULTS);

    if (!results || results.length === 0) return null;

    // Filter by minimum confidence and deduplicate by content
    const seen = new Set<string>();
    const filtered = results.filter(r => {
      if (r.score < MIN_CONFIDENCE) return false;
      // Deduplicate by first 100 chars of content
      const key = r.content.slice(0, 100);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (filtered.length === 0) return null;

    // Format as concise memory block — use snippet (shorter) or first ~300 chars of content
    const lines: string[] = [];
    let charCount = 0;

    for (const fact of filtered) {
      // Prefer snippet (shorter, more relevant extract), fall back to content
      let text = (fact.snippet || fact.content || '').trim();

      // Strip HTML tags, source metadata, confidence markers
      text = text
        .replace(/<[^>]+>/g, ' ')         // strip HTML tags
        .replace(/&[a-z]+;/gi, ' ')       // strip HTML entities
        .replace(/\[source:.*?\]/gi, '')
        .replace(/\(confidence:.*?\)/gi, '')
        .replace(/\s+/g, ' ')             // normalize whitespace
        .trim();

      // Truncate individual facts to 300 chars
      if (text.length > 300) text = text.slice(0, 300) + '…';

      if (!text || text.length < 10) continue;

      // Respect token budget (~4 chars per token)
      if (charCount + text.length > MAX_RECALL_TOKENS * 4) break;

      lines.push(`- ${text}`);
      charCount += text.length + 4; // +4 for "- " and newline
    }

    if (lines.length === 0) return null;

    const text = `## Memory (from Cortex)
The following facts were recalled from persistent memory. Use them as context — do not repeat them verbatim unless asked.

${lines.join('\n')}`;

    return {
      text,
      factCount: lines.length,
      queryMs: Date.now() - start,
    };
  } catch (err) {
    console.error('[memory-recall] Cortex search failed:', err);
    return null;
  }
}
