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
const MAX_RECALL_RESULTS = 10;
const MAX_FACTS = 10; // Hard cap on facts injected
const MIN_CONFIDENCE = 0.3;
const MIN_SCORE = 0.4; // Below this, results are too noisy to include

// Cortex binary path for fact queries
const CORTEX_BIN = process.env.CORTEX_BINARY || `${process.env.HOME || require('os').homedir()}/bin/cortex`;

interface RecallResult {
  text: string;       // Formatted memory block for system prompt
  factCount: number;  // How many facts were recalled
  queryMs: number;    // How long the search took
}

interface CortexFact {
  ID: number;
  Subject: string;
  Predicate: string;
  Object: string;
  FactType: string;
  Confidence: number;
  State: string;
}

/**
 * Fetch structured facts by IDs from Cortex.
 * Returns clean Subject/Predicate/Object triples.
 */
async function fetchFacts(factIds: number[]): Promise<CortexFact[]> {
  if (factIds.length === 0) return [];

  try {
    // Batch query: "id=X OR id=Y OR id=Z"
    const where = factIds.slice(0, 20).map(id => `id=${id}`).join(' OR ');
    const raw = execSync(`${CORTEX_BIN} query --where "${where}" --json 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (!raw) return [];
    const results = JSON.parse(raw);
    return results
      .map((r: { fact: CortexFact }) => r.fact)
      .filter((f: CortexFact) => f.State === 'active' && f.Confidence >= MIN_CONFIDENCE);
  } catch {
    return [];
  }
}

/**
 * Format a fact triple into a clean, concise string for LLM consumption.
 * Avoids verbose prose — just the signal.
 */
function formatFact(f: CortexFact): string {
  const subj = f.Subject.trim();
  const pred = f.Predicate.trim();
  const obj = f.Object.trim();

  // Skip facts that are too vague
  if (obj.length < 5 || subj.length < 2) return '';

  // Clean up common noise patterns
  const cleanObj = obj
    .replace(/\s+/g, ' ')
    .replace(/^["']|["']$/g, '')  // strip quotes
    .trim();

  if (cleanObj.length > 200) return `${subj}: ${cleanObj.slice(0, 200)}…`;

  // Natural formatting based on predicate type
  switch (pred) {
    case 'is':
    case 'are':
      return `${subj} is ${cleanObj}`;
    case 'has':
    case 'have':
      return `${subj} has ${cleanObj}`;
    case 'uses':
    case 'used':
      return `${subj} uses ${cleanObj}`;
    case 'prefers':
      return `${subj} prefers ${cleanObj}`;
    case 'located_at':
    case 'location':
      return `${subj} is at ${cleanObj}`;
    case 'value':
    case 'status':
      return `${subj}: ${cleanObj}`;
    default:
      // For compound predicates, try natural phrasing
      if (pred.includes('_')) {
        return `${subj} ${pred.replace(/_/g, ' ')} ${cleanObj}`;
      }
      return `${subj} ${pred} ${cleanObj}`;
  }
}

/**
 * Search Cortex for memories relevant to the user's message.
 * Returns a clean, LLM-optimized context block.
 *
 * Strategy:
 * 1. Search memories by query (BM25/hybrid/semantic)
 * 2. Collect fact_ids from top results
 * 3. Fetch structured facts (Subject/Predicate/Object triples)
 * 4. Format as concise bullets, deduplicated, within token budget
 *
 * Falls back to snippet-based recall if no structured facts available.
 */
export async function recallMemories(userMessage: string): Promise<RecallResult | null> {
  const start = Date.now();

  try {
    const client = getCortexClient();

    // Search with the user's message as query
    const results = await client.search(userMessage, MAX_RECALL_RESULTS);

    if (!results || results.length === 0) return null;

    // Filter by minimum score and deduplicate
    const seen = new Set<string>();
    const filtered = results.filter(r => {
      if (r.score < MIN_SCORE) return false;
      const key = r.content.slice(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (filtered.length === 0) return null;

    // Collect all fact_ids from search results
    const allFactIds = filtered.flatMap(r => r.fact_ids || []);

    // Strategy: prefer structured facts, fall back to snippets
    const lines: string[] = [];
    let charCount = 0;
    const usedFacts = new Set<string>(); // dedup by content
    const factConfidences = new Map<string, number>(); // text → confidence

    // ── Primary: structured fact triples ──
    if (allFactIds.length > 0) {
      const facts = await fetchFacts(allFactIds);

      // Sort by confidence (highest first)
      facts.sort((a, b) => b.Confidence - a.Confidence);

      for (const fact of facts) {
        if (lines.length >= MAX_FACTS) break;

        const line = formatFact(fact);
        if (!line || line.length < 10) continue;

        // Dedup by normalized content
        const key = line.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
        if (usedFacts.has(key)) continue;
        usedFacts.add(key);

        // Token budget check
        if (charCount + line.length > MAX_RECALL_TOKENS * 4) break;

        lines.push(`- ${line}`);
        factConfidences.set(line, fact.Confidence);
        charCount += line.length + 4;
      }
    }

    // ── Fallback: clean snippets (if no structured facts or budget remains) ──
    if (lines.length < 3 && charCount < MAX_RECALL_TOKENS * 3) {
      for (const result of filtered) {
        let text = (result.snippet || '').trim();

        // Clean aggressively for LLM consumption
        text = text
          .replace(/<[^>]+>/g, ' ')
          .replace(/&[a-z]+;/gi, ' ')
          .replace(/\[source:.*?\]/gi, '')
          .replace(/\(confidence:.*?\)/gi, '')
          .replace(/^\.{3}/, '')           // strip leading ellipsis
          .replace(/\.{3}$/, '')           // strip trailing ellipsis
          .replace(/\s+/g, ' ')
          .trim();

        if (text.length > 200) text = text.slice(0, 200) + '…';
        if (!text || text.length < 15) continue;

        // Dedup against structured facts
        const key = text.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
        if (usedFacts.has(key)) continue;
        usedFacts.add(key);

        if (charCount + text.length > MAX_RECALL_TOKENS * 4) break;

        lines.push(`- ${text}`);
        // Use search score as proxy confidence for snippets (cap at 1.0)
        factConfidences.set(text, Math.min(result.score, 1.0));
        charCount += text.length + 4;
      }
    }

    if (lines.length === 0) return null;

    // Format as XML-structured block for clean LLM consumption
    const factTags = lines.map(l => l.slice(2)); // strip "- " prefix
    const text = '<cortex_memory>\n' +
      factTags.map(f => {
        // Find the confidence for this fact if we have it
        const conf = factConfidences.get(f);
        const attrs = conf !== undefined ? ` confidence="${conf.toFixed(2)}"` : '';
        return `<fact${attrs}>${f}</fact>`;
      }).join('\n') +
      '\n</cortex_memory>';

    return {
      text,
      factCount: factTags.length,
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
