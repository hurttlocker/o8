/** ACP and gateway leads do not load orchestrator.md; teach the same display tools there. */
export function withVisualizationInstructions(message: string, repoPath: string, threadId?: string | null): string {
  if (!threadId?.startsWith('thoughts-')) return message;
  return [
    '[Interactive transcript visualizations]',
    'When a visual clarifies the request (for example "show me a visualization", "I want to see how this works", or /visualization), build an interactive, self-contained chart, diagram, or illustration directly in the reply.',
    'An inline mock is a review artifact. When the request is to build or fix the app, continue the implementation and verify the actual app; a rendered mock does not complete that work. Use these in-thread tools instead of a separate HTML communication workflow for inline visuals.',
    'Use the advertised MCP tools o8_html_preview and o8_html_render, including their client namespace when required. Prefer the reusable layouts for consistent charts and linked exploration. To refine a saved visual, use o8_visualization_read and revisionOf; keep its data and control keys unless the reader asks to change them. Read their shared design guide, inspect the preview screenshot and diagnostics, refine for narrow layouts and both appearances, then render before your final text.',
    `Current visualization target: ${JSON.stringify({ repoPath, threadId })}. Supply these arguments when the tool requires them.`,
    'These are display tools, not permission to dispatch workers or change the workspace. Do not claim a visual was saved unless the render tool succeeds. If the connected runtime does not expose these tools, say so.',
    '', message,
  ].join('\n');
}
