/**
 * Cortex Memory for LLM Chat
 *
 * Phase A: Pre-flight injection — search Cortex for relevant facts
 * based on user's message, format them for system prompt injection.
 *
 * Phase B: Post-flight extraction — after each exchange, extract
 * durable facts and store them in Cortex for future recall.
 *
 * Token budget: ~800 tokens max to avoid bloating context.
 */

import { getCortexClient } from '@/lib/cortex/client';
import { execSync } from 'node:child_process';

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


// ── Phase B: Post-flight fact extraction ──

const EXTRACTION_PROMPT = `You are a fact extraction engine. Analyze this conversation exchange and extract durable facts worth remembering.

Extract ONLY if the exchange contains:
- A user preference or opinion ("I prefer X", "don't use Y", "I like Z")
- A technical decision ("we're using X for Y", "switched from A to B")
- A project fact ("the repo is at X", "deployment is on Y")
- A person/identity fact ("SB is the co-founder", "Q's email is X")
- A bug fix or solution ("the issue was X, fixed by Y")
- A configuration detail ("API key is stored in X", "port 3001")

Do NOT extract:
- Greetings, thanks, or small talk
- Questions without answers
- Temporary states ("I'm working on X right now")
- Anything with "current time" or timestamps

Output format — one fact per line, no bullets, no numbering, no prefixes. Just the plain fact.
If there are no durable facts, output exactly: NONE

Example output:
Q prefers green for additions and blue for deletions in code diffs
Cortex IDE uses Next.js 16 with React 19 App Router
The JWT secret is stored at ~/.cortex-ide/.jwt-secret with mode 0600`;

/**
 * Pick the cheapest available model for extraction.
 * Priority: Gemini Flash Lite → Gemini Flash → Haiku → whatever is available
 */
function pickExtractionModel(): { model: string; provider: string; apiKey: string } | null {
  const candidates: { model: string; provider: string; envKey: string }[] = [
    { model: 'gemini-2.5-flash-lite', provider: 'google', envKey: 'GOOGLE_AI_API_KEY' },
    { model: 'gemini-2.5-flash', provider: 'google', envKey: 'GOOGLE_AI_API_KEY' },
    { model: 'gemini-3-flash-preview', provider: 'google', envKey: 'GOOGLE_AI_API_KEY' },
    { model: 'claude-haiku-4-5', provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
    { model: 'gpt-4o-mini', provider: 'openai', envKey: 'OPENAI_API_KEY' },
  ];

  for (const c of candidates) {
    const key = process.env[c.envKey];
    if (key && key.length > 5) {
      return { model: c.model, provider: c.provider, apiKey: key };
    }
  }
  return null;
}

/**
 * Check if a fact already exists in Cortex (dedup guard).
 * Returns true if a similar fact exists with confidence > 0.8.
 */
async function factAlreadyExists(factText: string): Promise<boolean> {
  try {
    const client = getCortexClient();
    const results = await client.search(factText, 3);
    if (!results || results.length === 0) return false;

    // Check if any result is very similar (high score = likely duplicate)
    return results.some(r => r.score > 0.8);
  } catch {
    return false;
  }
}

interface ExtractionResult {
  factsExtracted: number;
  factsStored: number;
  factsSkipped: number;  // dedup
  durationMs: number;
}

/**
 * Phase B: Extract facts from a user/assistant exchange and store in Cortex.
 *
 * Runs in the background after each chat response completes.
 * Uses the cheapest available model for extraction.
 * Deduplicates against existing Cortex facts before storing.
 */
export async function extractAndStoreFacts(
  userMessage: string,
  assistantResponse: string,
  tabId?: string,
): Promise<ExtractionResult | null> {
  const start = Date.now();

  // Skip trivially short exchanges
  if (userMessage.length < 20 && assistantResponse.length < 50) {
    return null;
  }

  // Skip if the message is just a greeting or thanks
  const trivialPatterns = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it|nice|cool|great|perfect)\s*[.!?]*$/i;
  if (trivialPatterns.test(userMessage.trim())) {
    return null;
  }

  const extractionModel = pickExtractionModel();
  if (!extractionModel) {
    console.log('[memory-extract] No extraction model available (no API keys configured)');
    return null;
  }

  try {
    // Call LLM to extract facts — use direct API call (not proxy route, to avoid recursion)
    const exchange = `User: ${userMessage.slice(0, 2000)}\n\nAssistant: ${assistantResponse.slice(0, 3000)}`;

    let extractedText: string;

    if (extractionModel.provider === 'google') {
      // Direct Google AI API call
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${extractionModel.model}:generateContent?key=${extractionModel.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${EXTRACTION_PROMPT}\n\n---\n\n${exchange}` }] }],
            generationConfig: { maxOutputTokens: 512, temperature: 0.1 },
          }),
        }
      );
      if (!res.ok) throw new Error(`Google API ${res.status}`);
      const data = await res.json();
      extractedText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'NONE';
    } else if (extractionModel.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': extractionModel.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: extractionModel.model,
          max_tokens: 512,
          messages: [{ role: 'user', content: `${EXTRACTION_PROMPT}\n\n---\n\n${exchange}` }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
      const data = await res.json();
      extractedText = data.content?.[0]?.text || 'NONE';
    } else {
      // OpenAI
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${extractionModel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: extractionModel.model,
          max_tokens: 512,
          messages: [
            { role: 'system', content: EXTRACTION_PROMPT },
            { role: 'user', content: exchange },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI API ${res.status}`);
      const data = await res.json();
      extractedText = data.choices?.[0]?.message?.content || 'NONE';
    }

    // Parse extracted facts
    const rawFacts = extractedText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 10 && line !== 'NONE' && !line.startsWith('#'));

    if (rawFacts.length === 0) {
      console.log('[memory-extract] No facts extracted from exchange');
      return { factsExtracted: 0, factsStored: 0, factsSkipped: 0, durationMs: Date.now() - start };
    }

    // Store facts in Cortex (with dedup)
    const client = getCortexClient();
    let stored = 0;
    let skipped = 0;

    for (const fact of rawFacts) {
      // Dedup check
      const exists = await factAlreadyExists(fact);
      if (exists) {
        skipped++;
        console.log(`[memory-extract] Skipped (duplicate): ${fact.slice(0, 60)}...`);
        continue;
      }

      // Store with source provenance
      const source = tabId ? `chat:${tabId}` : 'chat:unknown';
      await client.store(fact, source);
      stored++;
      console.log(`[memory-extract] Stored: ${fact.slice(0, 60)}...`);
    }

    const result: ExtractionResult = {
      factsExtracted: rawFacts.length,
      factsStored: stored,
      factsSkipped: skipped,
      durationMs: Date.now() - start,
    };

    console.log(`[memory-extract] ${stored} stored, ${skipped} skipped, ${rawFacts.length} extracted in ${result.durationMs}ms`);
    return result;
  } catch (err) {
    console.error('[memory-extract] Extraction failed:', err);
    return null;
  }
}
