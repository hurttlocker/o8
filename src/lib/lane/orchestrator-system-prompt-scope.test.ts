import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CORTEX_READONLY_TOOLS } from '@/lib/mcp/cortex-readonly-tools';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import { buildCodexOrchestratorPrompt } from './codex-orchestrator-session';
import {
  buildOrchestratorSystemPrompt,
  orchestratorPromptSurface,
  type OrchestratorPromptSurface,
} from './orchestrator-system-prompt';

const MCP_DIR = new URL('../mcp/', import.meta.url);

function registeredToolNames(files: URL[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/^\s+name: '([a-z0-9]+(?:_[a-z0-9]+)+)',/gm)) {
      names.add(match[1]!);
    }
  }
  return names;
}

const CORTEX_TOOLS = registeredToolNames([new URL('cortex-mcp-server.ts', MCP_DIR)]);
const OPERATOR_TOOLS = registeredToolNames(
  readdirSync(new URL('operator-handlers/', MCP_DIR))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => new URL(`operator-handlers/${name}`, MCP_DIR)),
);
const ALL_TOOLS = new Set([...CORTEX_TOOLS, ...OPERATOR_TOOLS]);

/** Every registered tool the text names, plus any `cortex_*` name that is not registered at all. */
function namedTools(prompt: string): string[] {
  const named = new Set<string>();
  for (const match of prompt.matchAll(/\b([a-z0-9]+(?:_[a-z0-9]+)+)\b/g)) {
    const name = match[1]!;
    if (ALL_TOOLS.has(name) || name.startsWith('cortex_')) named.add(name);
  }
  return [...named].sort();
}

function toolsFor(surface: OrchestratorPromptSurface): Set<string> {
  if (surface.dispatch) return ALL_TOOLS;
  return surface.cortexReads ? new Set(CORTEX_READONLY_TOOLS) : new Set();
}

const PROFILES: ToolProfile[] = ['full', 'propose', 'solo', 'fable', 'fable-solo'];

describe('orchestrator prompt tool scope (#2898)', () => {
  it('finds the registered tool catalogs it guards', () => {
    expect(CORTEX_TOOLS).toContain('cortex_launch_agent');
    expect(OPERATOR_TOOLS).toContain('create_mission');
    expect(OPERATOR_TOOLS).toContain('o8_render');
    for (const name of CORTEX_READONLY_TOOLS) expect(CORTEX_TOOLS, name).toContain(name);
  });

  for (const toolProfile of PROFILES) {
    for (const mcpServers of [true, false]) {
      it(`names only tools a ${toolProfile} turn has${mcpServers ? '' : ' with no MCP servers'}`, () => {
        const prompt = buildOrchestratorSystemPrompt('/tmp/example-repo', {
          firstRunClarify: false,
          toolProfile,
          mcpServers,
        });
        const available = toolsFor(orchestratorPromptSurface({ toolProfile, mcpServers }));
        expect(namedTools(prompt).filter((name) => !available.has(name))).toEqual([]);
        expect(prompt).not.toMatch(/<!-- o8:/);
      });
    }
  }

  it('keeps the fleet doctrine on a full turn and drops it on a Solo turn', () => {
    const full = buildOrchestratorSystemPrompt('/tmp/example-repo', { firstRunClarify: false });
    const solo = buildOrchestratorSystemPrompt('/tmp/example-repo', { firstRunClarify: false, toolProfile: 'solo' });

    for (const heading of ['## FINAL-MESSAGE FORMAT FOR DISPATCH', '## ORCHESTRATOR PROTOCOL', '## Huddle mode']) {
      expect(full, heading).toContain(heading);
      expect(solo, heading).not.toContain(heading);
    }
    for (const kept of ['### Outcome ownership', '### Adversarial review protocol', 'Outcome, Evidence, Residual, and Decision']) {
      expect(solo, kept).toContain(kept);
    }
    expect(solo).toContain('cortex_list_issues');
  });

  it('lets the orchestrator use gh where the cortex GitHub tools stop (#2901)', () => {
    const full = buildOrchestratorSystemPrompt('/tmp/example-repo', { firstRunClarify: false });
    const cortexServer = readFileSync(new URL('cortex-mcp-server.ts', MCP_DIR), 'utf8');

    // cortex_list_issues returns no body and points at gh; nothing in cortex or operator writes issues.
    expect(cortexServer).toContain('Use `gh issue view` for full text.');
    expect(full).not.toMatch(/never use the gh CLI/i);
    for (const command of ['gh issue view', 'gh issue create', 'gh issue comment']) {
      expect(full, command).toContain(command);
    }
    expect(full).toContain('cortex_list_issues');
  });

  it('names no MCP tool in a single-mode Codex prompt, which launches without MCP servers', () => {
    const single = buildCodexOrchestratorPrompt('/tmp/example-repo', 'work directly', {
      toolProfile: 'solo',
      orchestrationMode: 'single',
    });
    const fleet = buildCodexOrchestratorPrompt('/tmp/example-repo', 'fan this out');

    expect(namedTools(single)).toEqual([]);
    expect(single).toContain('`o8 ask`');
    expect(fleet).toContain('cortex_launch_agent');
    expect(fleet).toContain('`cortex_ask` MCP tool');
  });
});
