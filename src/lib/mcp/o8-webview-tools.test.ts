import { describe, it, expect } from 'vitest';
import {
  buildPickMenuOptionScript,
  buildPickMenuTriggerScript,
  O8_WEBVIEW_COMPOSITE_TOOLS,
  SURFACE_STATE_SCRIPT,
} from './o8-webview-composites';
import { buildSemanticClickExpr, createO8WebviewToolHandlers, O8_WEBVIEW_TOOLS } from './o8-webview-tools';
import type { O8WebviewClient } from './o8-webview-client';

// #agent-surface-ergonomics — the semantic-locator click is generated as in-page
// code, so the risk is malformed/escaped output (the live DOM behavior is
// verified in-app). These lock the code-gen: valid JS, correctly-injected,
// JSON-escaped locator values.
describe('buildSemanticClickExpr', () => {
  it('emits a syntactically valid IIFE expression', () => {
    const code = buildSemanticClickExpr({ text: 'New session', role: '', name: '' });
    // new Function parses but does not execute — validates syntax without a DOM.
    expect(() => new Function(`return ${code};`)).not.toThrow();
  });

  it('injects the text locator JSON-escaped (no injection break on quotes)', () => {
    const code = buildSemanticClickExpr({ text: 'New "session"', role: '', name: '' });
    expect(code).toContain('const TEXT = "New \\"session\\""');
    expect(() => new Function(`return ${code};`)).not.toThrow();
  });

  it('injects role + name for aria targeting', () => {
    const code = buildSemanticClickExpr({ text: '', role: 'button', name: 'Restart' });
    expect(code).toContain('ROLE = "button"');
    expect(code).toContain('NAME = "Restart"');
  });

  it('preserves a real \\s regex (whitespace normalizer survives templating)', () => {
    const code = buildSemanticClickExpr({ text: 'x', role: '', name: '' });
    expect(code).toContain('replace(/\\s+/g');
  });
});

describe('o8 webview composite tools', () => {
  const names = [
    'o8_view_new_orchestrator_session',
    'o8_view_pick_menu_option',
    'o8_view_surface_state',
  ];

  it('registers the three composite tools and handlers', () => {
    expect(names.every((name) => O8_WEBVIEW_TOOLS.some((tool) => tool.name === name))).toBe(true);
    const handlers = createO8WebviewToolHandlers(() => {
      throw new Error('not used');
    });
    expect(names.every((name) => typeof handlers[name] === 'function')).toBe(true);
  });

  it('keeps composite schemas OpenAI strict-mode clean at the top level', () => {
    for (const tool of O8_WEBVIEW_COMPOSITE_TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema).toHaveProperty('properties');
      expect(tool.inputSchema).toHaveProperty('required');
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/oneOf|anyOf|allOf/);
    }
  });

  it('documents the primitive composition in descriptions', () => {
    const byName = new Map(O8_WEBVIEW_COMPOSITE_TOOLS.map((tool) => [tool.name, tool]));
    expect(byName.get('o8_view_new_orchestrator_session')?.description).toContain('New tab menu');
    expect(byName.get('o8_view_pick_menu_option')?.description).toContain('verifies the popover closed');
    expect(byName.get('o8_view_surface_state')?.description).toContain('one eval batch');
  });

  it('emits syntactically valid DOM eval scripts', () => {
    expect(() => new Function(`return ${SURFACE_STATE_SCRIPT};`)).not.toThrow();
    expect(() => new Function(`return ${buildPickMenuTriggerScript('New "tab"')};`)).not.toThrow();
    expect(() => new Function(`return ${buildPickMenuOptionScript('Orchestrator')};`)).not.toThrow();
  });
});

describe('o8 browser geometry tool', () => {
  it('registers a strict selector-to-rect schema and handler', () => {
    const tool = O8_WEBVIEW_TOOLS.find((candidate) => candidate.name === 'o8_browser_rect');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', required: ['selector'] });
    expect(tool?.inputSchema).toHaveProperty('properties');
    const handlers = createO8WebviewToolHandlers(() => {
      throw new Error('HTTP-backed handler does not use the webview client directly');
    });
    expect(typeof handlers.o8_browser_rect).toBe('function');
  });
});

describe('o8 active composer typing', () => {
  it('focuses the resolved active composer before invoking native typing', async () => {
    const calls: string[] = [];
    const client = {
      evalJs: async (code: string) => {
        calls.push(code.includes('data-o8-active-composer') ? 'prepare' : 'eval');
        return { result: JSON.stringify({ ok: true, target: 'active-composer' }) };
      },
      type: async (text: string) => {
        calls.push(`type:${text}`);
        return { ok: true };
      },
    } as unknown as O8WebviewClient;
    const handler = createO8WebviewToolHandlers(() => client).o8_view_type;

    const result = await handler({ text: 'visible tab message' });

    expect(result.isError).not.toBe(true);
    expect(calls).toEqual(['prepare', 'type:visible tab message']);
  });

  it('returns an immediate error when no focused editable or active composer exists', async () => {
    const client = {
      evalJs: async () => ({
        result: JSON.stringify({ ok: false, error: 'No visible active composer.' }),
      }),
      type: async () => {
        throw new Error('native typing must not run');
      },
    } as unknown as O8WebviewClient;
    const handler = createO8WebviewToolHandlers(() => client).o8_view_type;

    const result = await handler({ text: 'message' });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('No visible active composer.') });
  });
});
