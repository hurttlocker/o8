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
  localStorage.clear();
  document.body.replaceChildren();
  delete nativeWindow.__TAURI_INTERNALS__;
});

type ToolReply = { correlationId: string; ok: boolean; data: unknown; error: string | null };

async function generatedResult(file: string, payload: Record<string, unknown>, target: Record<string, unknown>) {
  const source = readFileSync(path.join(process.cwd(), 'tauri-plugin-mcp/src/tools', file), 'utf8');
  const generated = /let js_template = r#"([\s\S]*?)"#;/.exec(source)?.[1];
  if (!generated) throw new Error(`Native tool template missing: ${file}`);
  const replies: ToolReply[] = [];
  target.__TAURI_INTERNALS__ = {
    invoke: async (command: unknown, reply: ToolReply) => {
      if (command !== 'mcp_result') throw new Error(`Unknown host command: ${String(command)}`);
      expect(reply.correlationId).toBe('tool-callback-fixture');
      replies.push(reply);
    },
  };
  const script = generated.replaceAll('{{correlationId}}', JSON.stringify('tool-callback-fixture'))
    .replaceAll('{{payload}}', JSON.stringify(payload));
  await new Function('window', 'localStorage', `return ${script.trim()}`)(target, localStorage);
  return replies;
}

describe('remaining native tool result callbacks', () => {
  it('delivers zoom data through the registered result command', async () => {
    const replies = await generatedResult('zoom.rs', {}, { devicePixelRatio: 2, visualViewport: { scale: 1.5 } });
    expect(replies).toEqual([{
      correlationId: 'tool-callback-fixture', ok: true,
      data: { devicePixelRatio: 2, visualViewportScale: 1.5 }, error: null,
    }]);
  });

  it('delivers zoom inspection errors instead of losing the callback', async () => {
    const target = Object.defineProperty({}, 'visualViewport', { get: () => { throw new Error('Fixture viewport unavailable'); } });
    expect(await generatedResult('zoom.rs', {}, target)).toEqual([{
      correlationId: 'tool-callback-fixture', ok: false, data: null, error: 'Fixture viewport unavailable',
    }]);
  });

  it.each(['back', 'forward'])('delivers %s navigation completion after the history operation', async (action) => {
    const history = { back: vi.fn(), forward: vi.fn() };
    const replies = await generatedResult('navigate_webview.rs', { action }, { history });
    expect(history[action as keyof typeof history]).toHaveBeenCalledOnce();
    expect(replies).toEqual([{ correlationId: 'tool-callback-fixture', ok: true, data: { action }, error: null }]);
  });

  it('delivers navigation errors instead of losing the callback', async () => {
    const history = { back: () => { throw new Error('Fixture history unavailable'); } };
    expect(await generatedResult('navigate_webview.rs', { action: 'back' }, { history })).toEqual([{
      correlationId: 'tool-callback-fixture', ok: false, data: null, error: 'Fixture history unavailable',
    }]);
  });

  it('delivers local-storage read results', async () => {
    localStorage.setItem('fixture-key', 'fixture-value');
    expect(await generatedResult('local_storage.rs', { action: 'get', key: 'fixture-key' }, {})).toEqual([{
      correlationId: 'tool-callback-fixture', ok: true, data: 'fixture-value', error: null,
    }]);
  });

  it('delivers local-storage write completion after the value is stored', async () => {
    expect(await generatedResult('local_storage.rs', { action: 'set', key: 'fixture-key', value: 'fixture-value' }, {})).toEqual([{
      correlationId: 'tool-callback-fixture', ok: true, data: null, error: null,
    }]);
    expect(localStorage.getItem('fixture-key')).toBe('fixture-value');
  });

  it('delivers local-storage operation errors instead of losing the callback', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Fixture storage unavailable'); });
    expect(await generatedResult('local_storage.rs', { action: 'get', key: 'fixture-key' }, {})).toEqual([{
      correlationId: 'tool-callback-fixture', ok: false, data: null, error: 'Fixture storage unavailable',
    }]);
  });
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
