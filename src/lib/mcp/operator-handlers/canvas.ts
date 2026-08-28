//! Canvas render tool (#1270) — lets the orchestrator paint on the operator's
//! screen. Symon (the voice conductor) delegates deep work to the orchestrator;
//! when the answer is something to SHOW rather than say, the orchestrator calls
//! `o8_render` → the `render` canvas intent → a markdown card blooms on the
//! canvas. Thin HTTP wrapper over the gated /api/canvas/intent bus (the same bus
//! Symon's voice `o8_canvas` verbs ride); auth + retries handled by apiFetch.

import { apiFetch, errorText, jsonResult, requiredString, textResult, type McpTool, type McpToolResult } from './shared';

export const CANVAS_TOOLS: McpTool[] = [
  {
    name: 'o8_canvas',
    description:
      "Drive the operator's canvas surface the way a human can — see every card, then place, size, raise, or dismiss it. Opens the canvas if it is not already up. Pass a `verb` and its `args`.\n" +
      'SIGHT: `list` (args: none) → returns { cards:[{kind,id,x,y,w,h,z,title}], count, zoom, grid, dock, activeRepo, viewport:{x,y,w,h,zoom} }. Call this first to learn card ids — every card verb addresses a card by its (kind, id).\n' +
      'CAMERA + READ: `center-on-card` {kind,id,zoom?} · `pan` {dx,dy} or {x,y} (screen-px canvas translate) · `read-card` {kind,id,lines?} (4KB cap; returns unsupported-kind/content-unavailable honestly).\n' +
      'CARD LIFECYCLE: `move-card` {kind,id,x,y} · `resize-card` {kind,id,w,h} (image/video stay aspect-locked) · `focus-card` {kind,id} (raise to front) · `close-card` {kind,id} (full teardown). kind ∈ term|file|tree|image|video|browser|chat|diff|spec|brain|markdown|agent.\n' +
      'SPAWN: `spawn-terminal` {} · `ask-brain` {question} · `open-spec` {} · `open-browser` {url} · `spawn-agents` {task,count?,repo?}. (To paint a markdown explainer card use the o8_render tool.)\n' +
      'CONTENT: `add-file` {path} (an absolute file path → editor card) · `add-tree` {repo?,x?,y?} (browse a repository) · `open-diff` {repo?} (the repo working-tree diff) · `open-chat` {threadId} (reopen a past orchestrator thread) · `add-video` {src,name?,x?,y?} (place a video from a URL/served path).\n' +
      'IMAGES: `add-image` {src,name?,x?,y?} (place a photo from a URL/served path) · `stack` {ids:[…]} or {id,ontoId} (group into a deck) · `flip` {id,dir?} (next/prev photo) · `separate` {id} (un-stack a deck).\n' +
      'VIEW + ORCHESTRATOR: `zoom` {level|direction:in|out} · `grid` {on?} (tile all cards) · `dock` {open?} · `search` {query?} · `send-prompt` {text} (to the scoped orchestrator) · `enter` {} (just open the canvas).',
    inputSchema: {
      type: 'object',
      properties: {
        verb: {
          type: 'string',
          description: 'The canvas verb (e.g. list, center-on-card, pan, read-card, move-card, resize-card, focus-card, close-card, spawn-terminal, ask-brain, zoom, grid, dock, send-prompt, enter).',
        },
        args: {
          type: 'object',
          description: 'Verb arguments, e.g. { kind, id, x, y } for move-card or { question } for ask-brain. Omit for verbs that take none (list, enter, spawn-terminal).',
          additionalProperties: true,
        },
      },
      required: ['verb'],
    },
  },
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

export async function handleCanvas(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const verb = requiredString(args, 'verb');
    const verbArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
      ? (args.args as Record<string, unknown>)
      : {};
    const result = (await apiFetch('/api/canvas/intent', {
      method: 'POST',
      body: JSON.stringify({ verb, args: verbArgs, ensure: true }),
    })) as { ok?: boolean; error?: string; note?: string; data?: unknown };
    if (!result?.ok) {
      return textResult(
        `o8_canvas ${verb} failed: ${result?.error ?? 'the canvas did not accept the verb (is the o8 app window open + Canvas mode enabled?)'}`,
        true,
      );
    }
    return jsonResult({
      ok: true,
      verb,
      ...(result.note ? { note: result.note } : {}),
      ...(result.data !== undefined ? { data: result.data } : {}),
    });
  } catch (error) {
    return textResult(`o8_canvas failed: ${errorText(error)}`, true);
  }
}

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
