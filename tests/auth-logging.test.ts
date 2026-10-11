// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ plugin: {} as Record<string, unknown> }));
vi.mock('tauri-plugin-clerk', () => ({
  initClerk: (...args: unknown[]) => (state.plugin.initClerk as (...args: unknown[]) => unknown)(...args),
  noopLogger: () => (state.plugin.noopLogger as () => unknown)(),
}));
vi.mock('@clerk/nextjs', () => ({ ClerkProvider: () => null }));

const marker = 'SYNTHETIC_AUTH_SECRET_NOT_VALID';
const secretError = () => Object.assign(new Error(marker), {
  cause: { authorization: marker }, response: { ticket: marker }, stack: marker,
});
const pluginSource = readFileSync('node_modules/tauri-plugin-clerk/dist-js/index.js', 'utf8')
  .replace(/^import .+;\s*$/gm, '')
  .replace(/^export \{ consoleLogger, initClerk, noopLogger \};\s*$/m,
    'globalThis.api = { initClerk, noopLogger };');
const hookSource = readFileSync('src-tauri/src/webview_latch.rs', 'utf8')
  .match(/const CONSOLE_ERROR_HOOK_JS: &str = r#"([\s\S]*?)"#;/)![1];

function fixture(fail = false) {
  const date = new Date(0);
  const user = { id: 'synthetic', emailAddresses: [], phoneNumbers: [], web3Wallets: [],
    externalAccounts: [], enterpriseAccounts: [], passkeys: [], organizationMemberships: [] };
  const session = { id: 'synthetic-session', status: 'active', expireAt: date, abandonAt: date,
    lastActiveAt: date, createdAt: date, updatedAt: date, user,
    lastActiveToken: { id: 'synthetic-token', getRawString: () => marker } };
  const client = { id: 'synthetic-client', sessions: [session], lastActiveSessionId: session.id };
  let update: (value: unknown) => void;
  let receive: (value: unknown) => void;
  let before: (value: { headers: Headers }) => Promise<void>;
  let after: (request: unknown, value: unknown) => Promise<void>;
  const emitted: unknown[] = [];
  const saved: unknown[] = [];
  const network = vi.fn(() => { throw new Error('Network forbidden'); });
  const context = vm.createContext({ console, window, URL, Request, Headers,
    fetch: network, getCurrentWindow: () => ({ label: 'main' }),
    invoke: async (name: string, args: unknown) => {
      if (name.endsWith('initialize')) {
        if (fail) throw secretError();
        return { client, environment: {}, publishableKey: 'synthetic-key' };
      }
      if (name.endsWith('get_client_authorization_header')) return marker;
      saved.push(args);
    },
    listen: async (_name: string, handler: typeof receive) => { receive = handler; },
    emit: async (_name: string, payload: unknown) => { emitted.push(payload); },
    loadClerkUIScript: async () => { throw secretError(); },
    Clerk: class {
      client = client;
      addListener(handler: typeof update) { update = handler; }
      __internal_onBeforeRequest(handler: typeof before) { before = handler; }
      __internal_onAfterResponse(handler: typeof after) { after = handler; }
      async load() { update({ client, session, user }); }
    },
  });
  vm.runInContext(pluginSource, context);
  state.plugin = context.api;
  return {
    emitted, saved, network,
    refresh: () => update({ client, session, user }),
    signOut: () => update({ client: { ...client, sessions: [] }, session: null, user: null }),
    receive: () => receive({ payload: { source: 'other-window', payload: { client: {
      id: 'other', sessions: [], last_active_session_id: null, secret: marker,
    } } } }),
    roundTrip: async () => {
      const request = { headers: new Headers() };
      await before(request);
      expect(request.headers.get('authorization')).toBe(marker);
      await after(null, { headers: new Headers({ authorization: marker }) });
    },
  };
}

describe('auth diagnostics through the provider and native error latch', () => {
  let root: Root;
  let records: unknown[];
  let logs: unknown[];
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'synthetic-key');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    records = []; logs = [];
    for (const level of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args); });
    }
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (_name: string, payload: unknown) => { records.push(payload); } } });
    delete (window as unknown as Record<string, unknown>).__o8ConsoleErrorHookInstalled;
    new Function('window', 'console', hookSource)(window, console);
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });
  async function mount() {
    const { O8AuthProvider } = await import('@/components/auth/O8AuthProvider');
    await act(async () => { root.render(createElement(O8AuthProvider, null, null)); });
  }
  it('suppresses session/refresh/receive/sign-out diagnostics while preserving native transport', async () => {
    const f = fixture();
    await mount();
    f.refresh(); f.receive(); await f.roundTrip(); f.signOut();
    expect(f.emitted).toHaveLength(3);
    expect(JSON.stringify(f.emitted)).toContain(marker);
    expect(JSON.stringify(f.saved)).toContain(marker);
    expect(JSON.stringify(logs)).not.toContain(marker);
    expect(JSON.stringify(records)).not.toContain(marker);
    expect(f.network).not.toHaveBeenCalled();
  });
  it('emits only a fixed initialization diagnostic to console and native capture', async () => {
    fixture(true);
    await mount();
    expect(logs).toContainEqual(['[auth] native Clerk init failed; using cookie mode']);
    expect(JSON.stringify(records)).toContain('native Clerk init failed');
    expect(JSON.stringify(logs)).not.toContain(marker);
    expect(JSON.stringify(records)).not.toContain(marker);
  });
});
