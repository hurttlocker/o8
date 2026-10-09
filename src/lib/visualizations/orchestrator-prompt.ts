/** ACP and gateway leads do not load orchestrator.md; teach the same display tools there. */
export function withVisualizationInstructions(message: string, repoPath: string, threadId?: string | null): string {
  if (!threadId?.startsWith('thoughts-')) return message;
  return [
    '[Interactive transcript visualizations]',
    'When a visual clarifies the request (for example "show me a visualization", "I want to see how this works", or /visualization), build an interactive, self-contained chart, diagram, or illustration directly in the reply.',
    'Use the advertised MCP tools o8_html_preview and o8_html_render, including their client namespace when required. Read their shared design guide, inspect the preview screenshot and diagnostics, refine for narrow layouts and both appearances, then render before your final text.',
    `Current visualization target: ${JSON.stringify({ repoPath, threadId })}. Supply these arguments when the tool requires them.`,
    'These are display tools, not permission to dispatch workers or change the workspace. Do not claim a visual was saved unless the render tool succeeds. If the connected runtime does not expose these tools, say so.',
    '', message,
  ].join('\n');
}
