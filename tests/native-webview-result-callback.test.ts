// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rust = readFileSync(path.join(process.cwd(), 'tauri-plugin-mcp/src/tools/webview.rs'), 'utf8');
const template = /const GET_PAGE_MAP_JS: &str = r#"([\s\S]*?)"#;/.exec(rust)?.[1];
if (!template) throw new Error('Native page-map template was not found.');

type Reply = { correlationId: string; ok: boolean; data: { elements: Array<{ text: string }> } | null; error: string | null };
const nativeWindow = window as typeof window & { __TAURI_INTERNALS__?: { invoke: (command: string, reply: Reply) => Promise<void> } };

async function pageMap(payload: Record<string, unknown>) {
  const replies: Reply[] = [];
  nativeWindow.__TAURI_INTERNALS__ = {
    invoke: async (command, reply) => {
      // This matches the registered host command's flat camelCase argument contract.
      if (command !== 'mcp_result') throw new Error(`Unknown host command: ${String(command)}`);
      expect(reply.correlationId).toBe('page-map-fixture');
      replies.push(reply);
    },
  };
  const script = template!.replaceAll('{{correlationId}}', JSON.stringify('page-map-fixture')).replaceAll('{{payload}}', JSON.stringify(payload));
  await new Function(`return ${script.trim()}`)();
  return replies;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  delete nativeWindow.__TAURI_INTERNALS__;
});

describe('native page-map result callback', () => {
  it('returns the actual template result through the registered host command', async () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Review files');
    document.body.append(button);
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 10, width: 100, height: 30, top: 10, right: 110, bottom: 40, left: 10, toJSON: () => ({}) });
    const replies = await pageMap({ interactiveOnly: true, includeMetadata: false });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: true, error: null });
    expect(replies[0].data?.elements.some((element) => element.text === 'Review files')).toBe(true);
  });

  it('returns a DOM error instead of losing its correlated callback', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation(() => { throw new Error('Fixture DOM scope failed'); });
    const replies = await pageMap({ scopeSelector: '#fixture-scope' });
    expect(replies).toEqual([{ correlationId: 'page-map-fixture', ok: false, data: null, error: 'Fixture DOM scope failed' }]);
  });
});
