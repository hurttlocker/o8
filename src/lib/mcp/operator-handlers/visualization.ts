import { apiFetch, errorText, textResult, type McpTool, type McpToolResult } from './shared';
import { isVisualizationReference } from '@/lib/visualizations/types';
import { VISUALIZATION_DESIGN_GUIDE } from '@/lib/visualizations/design';

const GUIDE = 'Build self-contained interactive HTML for this reply: charts, diagrams, tables, UI alternatives or explorable explanations. '
  + 'Inline CSS and classic JavaScript; bind controls with addEventListener, not onclick attributes or module scripts. Use inline SVG/canvas and data or workspace <img src> images. External scripts, fonts, fetch, links and other network access are blocked. '
  + 'Live theme variables: --background (transparent), --foreground, --muted-foreground, --card, --popover, --border, --accent, --chart-1 through --chart-6, --font-sans and --font-mono. '
  + 'Start at the reply left edge with no outer padding, title banner, border or card. Use fluid width and natural content height; avoid body min-height:100vh and viewport-height charts. '
  + `${VISUALIZATION_DESIGN_GUIDE} Preview first, inspect the screenshot and diagnostics, revise, then render before your final reply. `
  + 'Explain only what the visual does not already communicate. The current thread/workspace is supplied by o8 when available; otherwise provide threadId+repoPath, or packetId. HTML max 512 KiB.';
const TARGET = {
  threadId: { type: 'string', description: 'Orchestrator thread (thoughts-…). Defaults to the current thread.' },
  repoPath: { type: 'string', description: 'Registered workspace. Defaults to the current workspace.' },
  packetId: { type: 'string', description: 'Worker packet instead of a thread.' },
};
export const VISUALIZATION_TOOLS: McpTool[] = [
  {
    name: 'o8_html_preview', description: `Preview a transcript visualization as a screenshot without publishing. ${GUIDE}`,
    inputSchema: { type: 'object', properties: { html: { type: 'string' }, width: { type: 'integer', minimum: 320, maximum: 1600 },
      appearance: { type: 'string', enum: ['light', 'dark'] }, ...TARGET }, required: ['html'], additionalProperties: false } },
  {
    name: 'o8_html_render', description: `Save an interactive visualization in the workspace transcript. ${GUIDE}`,
    inputSchema: { type: 'object', properties: { html: { type: 'string' }, title: { type: 'string', maxLength: 120 },
      height: { type: 'integer', minimum: 80, maximum: 1800, description: 'Initial height; content then sizes automatically.' }, ...TARGET },
    required: ['html', 'title'], additionalProperties: false } },
];

export async function handleHtmlRender(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const response = await apiFetch('/api/visualizations', { method: 'POST', body: JSON.stringify(args) }) as {
      ok?: boolean; result?: { visualization?: unknown; warnings?: string[] }; error?: { message?: string };
    };
    if (!response.ok || !isVisualizationReference(response.result?.visualization)) return textResult(response.error?.message ?? 'The visualization could not be saved.', true);
    return textResult(JSON.stringify({ visualization: response.result.visualization, warnings: response.result.warnings ?? [],
      instruction: 'The page is displayed in the transcript. Do not repeat its HTML or reference JSON in your reply.' }));
  } catch (error) { return textResult(`Visualization render failed: ${errorText(error)}`, true); }
}

export async function handleHtmlPreview(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const response = await apiFetch('/api/visualizations/preview', { method: 'POST', body: JSON.stringify(args), timeoutMs: 30_000 }) as {
      ok?: boolean; result?: { image?: string; mimeType?: string; width?: number; height?: number; contentHeight?: number; diagnostics?: string[]; warnings?: string[] };
      error?: { message?: string };
    };
    const result = response.result;
    if (!response.ok || !result?.image || result.mimeType !== 'image/png') return textResult(response.error?.message ?? 'The preview could not be captured.', true);
    const { image, mimeType, ...details } = result;
    return { content: [{ type: 'image', data: image, mimeType }, { type: 'text', text: JSON.stringify(details) }] };
  } catch (error) { return textResult(`Visualization preview failed: ${errorText(error)}`, true); }
}
