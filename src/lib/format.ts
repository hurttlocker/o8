/**
 * Shared formatting utilities for Cortex IDE.
 */

export function formatModelLabel(model: string): string {
  return model
    // Vendor-prefixed (from openclaw config)
    .replace('openai-codex/gpt-5.4', 'Codex 5.4')
    .replace('openai-codex/gpt-5.3-codex', 'Codex 5.3')
    .replace('anthropic/claude-opus-4-6', 'Opus 4.6')
    .replace('anthropic/claude-sonnet-4-5-20250929', 'Sonnet 4.5')
    .replace('anthropic/claude-sonnet-4-20250514', 'Sonnet 4')
    .replace('anthropic/claude-haiku-4-5-20251001', 'Haiku 4.5')
    .replace('google/gemini-3-flash-preview', 'Gemini 3 Flash')
    // Bare forms (from live sessions)
    .replace('gpt-5.4', 'GPT-5.4')
    .replace('gpt-5.3-codex', 'Codex 5.3')
    .replace('claude-opus-4-6', 'Opus 4.6')
    .replace('claude-sonnet-4-20250514', 'Sonnet 4')
    .replace('claude-haiku-4-5-20251001', 'Haiku 4.5')
    .replace('gemini-3-flash-preview', 'Gemini 3 Flash')
    .replace('gemini-3.1-pro-preview', 'Gemini 3.1 Pro')
    .replace('gemini-3-pro-preview', 'Gemini 3 Pro')
    .replace('gemini-2.5-pro', 'Gemini 2.5 Pro')
    .replace('gemini-2.5-flash', 'Gemini 2.5 Flash')
    .replace('gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite')
    .replace('codex owned', 'Codex')
    .replace(/^openai-codex\//, '')
    .replace(/^anthropic\//, '')
    .replace(/^google\//, '');
}
