//! Canvas render tool (#1270) — lets the orchestrator paint on the operator's
//! screen. Symon (the voice conductor) delegates deep work to the orchestrator;
//! when the answer is something to SHOW rather than say, the orchestrator calls
//! `o8_render` → the `render` canvas intent → a markdown card blooms on the
//! canvas. Thin HTTP wrapper over the gated /api/canvas/intent bus (the same bus
//! Symon's voice `o8_canvas` verbs ride); auth + retries handled by apiFetch.

import { apiFetch, errorText, jsonResult, requiredString, textResult, type McpTool, type McpToolResult } from './shared';

export const CANVAS_TOOLS: McpTool[] = [
  {
    name: 'o8_render',
    description:
      'Render a markdown explainer onto the operator\'s canvas as a card — use when the answer is something to SHOW, not say (e.g. "explain the Pythagorean theorem on my screen", formatted notes, a step-by-step breakdown). Opens the canvas if it is not already up. Markdown supports # / ## / ### headings, - bullets, 1. numbered lists, > quotes, ``` fenced code, and inline **bold** / `code`. Each call blooms a fresh card, so you can render several.',
    inputSchema: {
      type: 'object',
      properties: {
        markdown: {
          type: 'string',
          description: 'The markdown body to render on the card.',
        },
        title: {
          type: 'string',
          description: 'Short card title shown in the card header (e.g. "Pythagorean Theorem"). Optional.',
        },
      },
      required: ['markdown'],
    },
  },
];

export async function handleRender(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const markdown = requiredString(args, 'markdown');
    const title = typeof args.title === 'string' ? args.title : '';
    const result = (await apiFetch('/api/canvas/intent', {
      method: 'POST',
      body: JSON.stringify({ verb: 'render', args: { title, markdown }, ensure: true }),
    })) as { ok?: boolean; error?: string; note?: string };
    if (!result?.ok) {
      return textResult(
        `o8_render failed: ${result?.error ?? 'the canvas did not accept the render (is the o8 app window open?)'}`,
        true,
      );
    }
    return jsonResult({ rendered: true, note: result.note ?? (title ? `rendered "${title}"` : 'rendered note') });
  } catch (error) {
    return textResult(`o8_render failed: ${errorText(error)}`, true);
  }
}
