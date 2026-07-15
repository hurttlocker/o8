/**
 * spec-image-captions — caption markdown images during spec ingest so the
 * Engineering Brain has searchable text for visual references (#1131).
 *
 * Today image links land in the substrate as raw URLs. BM25 retrieval can't
 * match "what does the empty-state of the orchestrator look like?" against
 * `![](o8-assets/screenshot.png)`. We resolve each image, caption it with
 * Gemini Flash, cache by mtime+path, and inline `**[image: <caption>]**`
 * after the markdown link so the caption rides along through chunking.
 *
 * Cache: ~/.o8/spec-image-captions.json keyed by `${absolutePath}:${mtimeMs}`.
 * Per-image errors are isolated — log + skip, never blow up the ingest.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

// `gemini-flash-lite-latest` is the cheapest Gemini tier that supports vision
// and has its own free-tier quota bucket (separate from gemini-2.0-flash which
// the rest of the repo already pressures). Resolves to gemini-3.1-flash-lite
// as of 2026-05. Switching to a different provider would mean a new SDK + key.
const GEMINI_MODEL = 'gemini-flash-lite-latest';
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const CAPTION_PROMPT =
  'Describe this image in 2-3 sentences, focusing on UI structure, text content, and visual hierarchy. Max 400 characters.';

const MAX_CAPTION_CHARS = 400;
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;

// Subset of MIME types we trust to ship to Gemini. Anything else gets skipped.
const SUPPORTED_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

interface CacheEntry {
  caption: string;
  cachedAt: string;
}

type CaptionCache = Record<string, CacheEntry>;

function getCachePath(): string {
  return join(getDataDir(), 'spec-image-captions.json');
}

function loadCache(): CaptionCache {
  const path = getCachePath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as CaptionCache;
  } catch (err) {
    console.warn('[spec-image-captions] failed to load cache, starting fresh:', err);
  }
  return {};
}

function saveCache(cache: CaptionCache): void {
  const path = getCachePath();
  try {
    writeFileSync(path, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[spec-image-captions] failed to persist cache:', err);
  }
}

function resolveImagePath(specFilePath: string, rawSrc: string): string | null {
  // Drop optional title: `![](path "title")` — only the path matters.
  const src = rawSrc.trim().split(/\s+/)[0];
  if (!src) return null;
  // Skip remote URLs — Gemini accepts URLs but the cache key would have to
  // bypass mtime, and we'd need network in cases we don't expect. Stay local.
  if (/^https?:\/\//i.test(src) || /^data:/i.test(src)) return null;
  const abs = isAbsolute(src) ? src : resolve(dirname(specFilePath), src);
  if (!existsSync(abs)) return null;
  try {
    if (!statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

function mimeTypeFor(absPath: string): string | null {
  const ext = absPath.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  return SUPPORTED_MIME_BY_EXT[ext] ?? null;
}

function truncate(caption: string): string {
  const collapsed = caption.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_CAPTION_CHARS) return collapsed;
  return collapsed.slice(0, MAX_CAPTION_CHARS - 1).trimEnd() + '…';
}

async function captionViaGemini(absPath: string, apiKey: string): Promise<string | null> {
  const mimeType = mimeTypeFor(absPath);
  if (!mimeType) return null;

  let base64: string;
  try {
    base64 = readFileSync(absPath).toString('base64');
  } catch (err) {
    console.warn(`[spec-image-captions] read failed for ${absPath}:`, err);
    return null;
  }

  let res: Response;
  try {
    res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: CAPTION_PROMPT },
              { inline_data: { mime_type: mimeType, data: base64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 200,
        },
      }),
    });
  } catch (err) {
    console.warn(`[spec-image-captions] network error captioning ${absPath}:`, err);
    return null;
  }

  if (!res.ok) {
    console.warn(`[spec-image-captions] Gemini ${res.status} for ${absPath}`);
    return null;
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    console.warn(`[spec-image-captions] bad JSON from Gemini for ${absPath}:`, err);
    return null;
  }

  // Defensive extraction — Gemini's response shape is stable but we don't
  // want a missing field to crash ingest.
  const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
    ?.candidates;
  const text = candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join(' ');
  if (!text) return null;
  return truncate(text);
}

/**
 * Scan markdown content for image refs, caption each (cached by mtime+path),
 * and return content with `**[image: <caption>]**` inlined after each link.
 *
 * Always returns the (possibly unchanged) markdown — never throws.
 */
export async function captionImagesInSpec(specFilePath: string, content: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
    ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY
    ?? process.env.GOOGLE_AI_API_KEY;

  // Collect matches up-front so we don't replace + re-scan in one pass.
  const matches = Array.from(content.matchAll(MARKDOWN_IMAGE_REGEX));
  if (matches.length === 0) return content;

  const cache = loadCache();
  let cacheDirty = false;
  const replacements: Array<{ index: number; original: string; replacement: string }> = [];

  for (const match of matches) {
    const original = match[0];
    const rawSrc = match[2] ?? '';
    const absPath = resolveImagePath(specFilePath, rawSrc);
    if (!absPath) {
      console.warn(`[spec-image-captions] unresolved image ref in ${specFilePath}: ${rawSrc}`);
      continue;
    }

    let mtimeMs: number;
    try {
      mtimeMs = statSync(absPath).mtimeMs;
    } catch {
      continue;
    }

    const cacheKey = `${absPath}:${mtimeMs}`;
    let caption = cache[cacheKey]?.caption;

    if (!caption) {
      if (!apiKey) {
        // No key → cannot caption. Log once per spec is enough; bail this spec
        // but don't error.
        console.warn('[spec-image-captions] no Gemini API key set; skipping captioning');
        return content;
      }
      try {
        const fresh = await captionViaGemini(absPath, apiKey);
        if (!fresh) continue;
        caption = fresh;
        cache[cacheKey] = { caption, cachedAt: new Date().toISOString() };
        cacheDirty = true;
        // Persist after every caption so a crash mid-spec doesn't lose work.
        saveCache(cache);
      } catch (err) {
        console.warn(`[spec-image-captions] caption failed for ${absPath}:`, err);
        continue;
      }
    }

    replacements.push({
      index: match.index ?? 0,
      original,
      replacement: `${original}\n**[image: ${truncate(caption)}]**`,
    });
  }

  if (cacheDirty) saveCache(cache);
  if (replacements.length === 0) return content;

  // Apply replacements right-to-left so earlier indices stay valid.
  let updated = content;
  replacements.sort((a, b) => b.index - a.index);
  for (const { index, original, replacement } of replacements) {
    updated = updated.slice(0, index) + replacement + updated.slice(index + original.length);
  }
  return updated;
}
