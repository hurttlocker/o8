/*
 * Targeting Machine tool for the operator MCP server — lets an external Claude
 * session ask "where should I point my agents?" in chat. A thin call to
 * /api/panel/targets (one code path, one gate). Read-only triage: it ranks +
 * explains, it does NOT dispatch (dispatch stays an explicit operator action on
 * the panel / the gated dispatch route).
 *
 * Flat inputSchema (OpenAI strict-mode safe).
 */

import {
  apiFetch,
  errorText,
  jsonResult,
  optionalString,
  requiredString,
  type McpTool,
  type McpToolResult,
} from '@/lib/mcp/operator-handlers/shared';

export const TARGETING_TOOLS: McpTool[] = [
  {
    name: 'o8_targets',
    description:
      "Where should I point my agents? Triages a repo and returns its files ranked by impact × opportunity "
      + "(blast-radius from inbound importers, plus size + recent churn), each with a one-line rationale and a "
      + "dispatch tier — 'triage' (cheap, small/bounded work) or 'action' (premium, a real agent). Read-only: this "
      + "ranks + explains; it does not dispatch. Cheap + offline (deterministic heuristic; the top rationales are "
      + "upgraded by the cheap triage model when reachable).",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoPath: { type: 'string', description: 'Absolute path to the repo to triage.' },
        limit: { type: 'number', description: 'Max files to return (default 25, cap 200).' },
        rationales: {
          type: 'string',
          description: "'llm' (default) upgrades the top files' rationales with the cheap triage model; 'heuristic' is instant + deterministic.",
        },
      },
      required: ['repoPath'],
    },
  },
];

export async function handleTargets(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repoPath = requiredString(args, 'repoPath');
    const qs = new URLSearchParams({ repoPath });
    if (typeof args.limit === 'number' && args.limit > 0) qs.set('limit', String(Math.floor(args.limit)));
    if (optionalString(args, 'rationales') === 'heuristic') qs.set('rationales', 'heuristic');
    return jsonResult(await apiFetch(`/api/panel/targets?${qs.toString()}`));
  } catch (error) {
    return jsonResult({ ok: false, error: errorText(error) });
  }
}
