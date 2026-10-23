import { isDeepStrictEqual } from 'node:util';
import { WebSocket } from 'ws';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Entry = { kind: string; [key: string]: Json };
export type SessionAction =
  | { op: 'connect'; client: string; credential?: 'valid' | 'invalid' | 'missing' }
  | { op: 'send'; client: string; frame?: Json; raw?: string }
  | { op: 'ping'; client: string; data: string }
  | { op: 'receive'; client: string; entries: Entry[] }
  | { op: 'close'; client: string; code: number; reason: string }
  | { op: 'http'; target?: 'server' | 'fixture'; path: string; body: Json; status: number }
  | { op: 'delay'; ms: number };
export interface RecordedSession { name: string; actions: SessionAction[] }
export interface SessionOptions {
  url: string;
  token: string;
  fixtureUrl?: string;
  timeoutMs?: number;
}

function mismatch(path: string): never {
  // A mismatch points at a field, never prints credentials or application payloads.
  throw new Error(`parity failed at ${path}`);
}

function match(expected: Json, actual: Json, bindings: Map<string, Json>, path: string): void {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (typeof expected.$capture === 'string') {
      if (!['string', 'number', 'boolean'].includes(String(expected.type))) mismatch(`${path}/capture-type`);
      if (typeof actual !== expected.type || actual === null) mismatch(path);
      const previous = bindings.get(expected.$capture);
      if (bindings.has(expected.$capture) && !isDeepStrictEqual(previous, actual)) mismatch(path);
      bindings.set(expected.$capture, actual);
      return;
    }
    if (typeof expected.$ref === 'string') {
      if (!isDeepStrictEqual(resolve(expected, bindings), actual)) mismatch(path);
      return;
    }
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) mismatch(`${path}/length`);
    expected.forEach((value, index) => match(value, actual[index], bindings, `${path}/${index}`));
    return;
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) mismatch(path);
    const keys = Object.keys(expected).sort();
    if (!isDeepStrictEqual(keys, Object.keys(actual).sort())) mismatch(`${path}/keys`);
    // Bindings follow recording field order; wire object key order is immaterial.
    for (const key of Object.keys(expected)) match(expected[key], actual[key], bindings, `${path}/${key}`);
    return;
  }
  if (!isDeepStrictEqual(expected, actual)) mismatch(path);
}

function resolve(value: Json, bindings: Map<string, Json>): Json {
  if (Array.isArray(value)) return value.map((item) => resolve(item, bindings));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.$ref === 'string') {
    if (!bindings.has(value.$ref)) throw new Error('parity failed: unbound reference');
    const bound = bindings.get(value.$ref)!;
    if (value.add === undefined) return bound;
    if (typeof bound !== 'number' || typeof value.add !== 'number') {
      throw new Error('parity failed: invalid numeric reference');
    }
    return bound + value.add;
  }
  if ('$capture' in value) throw new Error('parity failed: capture used as input');
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child, bindings)]));
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Run a trusted fixture recording against an actual /ws URL; no channel filtering. */
export async function runRecordedSession(recording: RecordedSession, options: SessionOptions) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const clients = new Map<string, { ws: WebSocket; entries: Entry[]; closed: boolean }>();
  const bindings = new Map<string, Json>();
  const endpoint = new URL(options.url);
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error('parity failed: expected WS URL');
  const origin = new URL(endpoint);
  origin.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
  origin.pathname = '/';
  origin.search = '';
  let envelopes = 0;
  let closes = 0;
  const clientFor = (name: string) => {
    const client = clients.get(name);
    if (!client) throw new Error('parity failed: unknown client');
    return client;
  };
  try {
    for (const [index, action] of recording.actions.entries()) {
      const path = `actions/${index}`;
      switch (action.op) {
        case 'connect': {
          if (clients.has(action.client)) throw new Error('parity failed: duplicate client');
          const url = new URL(endpoint);
          url.searchParams.delete('token');
          if (action.credential !== 'missing') {
            url.searchParams.set('token', action.credential === 'invalid' ? 'invalid-fixture' : options.token);
          }
          const ws = new WebSocket(url);
          const state = { ws, entries: [] as Entry[], closed: false };
          clients.set(action.client, state);
          let rejected = false;
          ws.on('message', (raw) => {
            envelopes += 1;
            try { state.entries.push({ kind: 'message', frame: JSON.parse(String(raw)) }); }
            catch { state.entries.push({ kind: 'invalid-json' }); }
          });
          ws.on('ping', (raw) => state.entries.push({ kind: 'ping', data: raw.toString() }));
          ws.on('pong', (raw) => state.entries.push({ kind: 'pong', data: raw.toString() }));
          ws.on('close', (code, reason) => {
            state.closed = true;
            if (!rejected) {
              closes += 1;
              state.entries.push({ kind: 'close', code, reason: reason.toString() });
            }
          });
          await new Promise<void>((done, reject) => {
            const timer = setTimeout(() => reject(new Error(`parity failed: connect timeout at ${path}`)), timeoutMs);
            const finish = () => { clearTimeout(timer); done(); };
            ws.once('open', finish);
            ws.on('error', () => {
              if (!rejected) {
                clearTimeout(timer);
                reject(new Error(`parity failed: socket error at ${path}`));
                state.entries.push({ kind: 'socket-error' });
              }
            });
            ws.once('unexpected-response', (request, response) => {
              rejected = true;
              state.closed = true;
              state.entries.push({ kind: 'upgrade-rejected', status: response.statusCode ?? 0 });
              response.resume();
              request.destroy();
              ws.terminate();
              finish();
            });
          });
          break;
        }
        case 'send': {
          const client = clientFor(action.client);
          if (client.ws.readyState !== WebSocket.OPEN) mismatch(`${path}/open`);
          client.ws.send(action.raw ?? JSON.stringify(resolve(action.frame ?? null, bindings)));
          break;
        }
        case 'ping': clientFor(action.client).ws.ping(action.data); break;
        case 'close': clientFor(action.client).ws.close(action.code, action.reason); break;
        case 'receive': {
          const client = clientFor(action.client);
          for (const [entryIndex, expected] of action.entries.entries()) {
            const deadline = Date.now() + timeoutMs;
            while (client.entries.length === 0 && Date.now() < deadline) await delay(5);
            if (client.entries.length === 0) mismatch(`${path}/entries/${entryIndex}/timeout`);
            match(expected, client.entries.shift()!, bindings, `${path}/entries/${entryIndex}`);
          }
          break;
        }
        case 'http': {
          if (!action.path.startsWith('/') || action.path.startsWith('//')) mismatch(`${path}/path`);
          const target = action.target === 'fixture' ? options.fixtureUrl : origin.href;
          if (!target) throw new Error('parity failed: fixture URL required');
          const url = new URL(action.path, target);
          if (url.origin !== new URL(target).origin) mismatch(`${path}/origin`);
          const response = await fetch(url, { method: 'POST', headers: {
            'Content-Type': 'application/json',
            ...(action.target === 'fixture' ? {} : { Authorization: `Bearer ${options.token}` }),
          }, body: JSON.stringify(resolve(action.body, bindings)), signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error' });
          await response.arrayBuffer();
          if (response.status !== action.status) mismatch(`${path}/status`);
          break;
        }
        case 'delay': await delay(action.ms); break;
        default: throw new Error(`parity failed: unknown action at ${path}`);
      }
    }
    // Observe trailing frames as well as frames paired with explicit receives.
    await delay(100);
    for (const [name, client] of clients) {
      if (client.entries.length) mismatch(`clients/${name}/unconsumed`);
      if (!client.closed) mismatch(`clients/${name}/unclosed`);
    }
    return { envelopes, closes };
  } finally {
    for (const client of clients.values()) client.ws.terminate();
  }
}
