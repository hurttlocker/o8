import { describe, expect, it } from 'vitest';
import { placeTranscriptVisualizations, toolVisualizationReferences } from '@/lib/visualizations/transcript';
import type { VisualizationReference } from '@/lib/visualizations/types';

const ref: VisualizationReference = { kind: 'o8-visualization', id: 'vis-12345678-1234-1234-1234-123456789abc', title: 'Flow', height: 240, createdAt: new Date(1000).toISOString() };
describe('transcript placement across providers', () => {
  it('recognizes direct, MCP-wrapped and managed command references without accepting unrelated tool JSON', () => {
    expect(toolVisualizationReferences([{ name: 'mcp__operator__o8_html_render', result: JSON.stringify({ visualization: ref }) }])).toEqual([ref]);
    expect(toolVisualizationReferences([{ name: 'o8_run', args: { name: 'o8_html_render' }, result: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ visualization: ref }) }] }) }])).toEqual([ref]);
    expect(toolVisualizationReferences([{ name: 'read_file', result: JSON.stringify({ visualization: ref }) }])).toEqual([]);
    expect(toolVisualizationReferences([{ name: 'o8_html_render', status: 'error', result: JSON.stringify({ visualization: ref }) }])).toEqual([]);
  });
  it('places metadata inside the same turn reply and never duplicates a tool-embedded visual', () => {
    const messages = [{ id: 'u1', role: 'user' as const, text: 'Visualize', timestamp: 500 }, { id: 'a1', role: 'assistant' as const, text: 'Explore', timestamp: 1500 }];
    expect(placeTranscriptVisualizations([ref], messages).get(1)).toEqual([ref]);
    expect(placeTranscriptVisualizations([ref], [messages[0], { ...messages[0], id: 'u2', timestamp: 1200 }, messages[1]]).get(0)).toEqual([ref]);
    expect(placeTranscriptVisualizations([ref], [{ ...messages[0], toolCalls: [{ name: 'o8_html_render', result: JSON.stringify({ visualization: ref }) }] }]).size).toBe(0);
    expect(placeTranscriptVisualizations([ref], []).get(-1)).toEqual([ref]);
  });
});
