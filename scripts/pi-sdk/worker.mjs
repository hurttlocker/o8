// App-owned SDK worker. No CLI discovery, user extensions or provider credentials.
import { StringDecoder } from 'node:string_decoder';
import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

let session;
let sequence = 0;
let active = false;
const pending = new Map();
const streams = new Map();
// The shared host peer currently decodes each chunk separately. ASCII wire output
// preserves Unicode even if a pipe chunk splits a multibyte character.
function send(frame) {
  const json = JSON.stringify({ jsonrpc: '2.0', ...frame }).replace(/[\u007f-\uffff]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  process.stdout.write(`${json}\n`);
}
function hostRequest(method, params, stream) {
  const id = `worker-${++sequence}`;
  if (stream) streams.set(id, stream);
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  send({ id, method, params });
  return promise.finally(() => streams.delete(id));
}
function failedMessage(model, reason, message) {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider,
    model: model.id, timestamp: Date.now(), stopReason: reason, errorMessage: message,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function initialize(params) {
  if (session) throw new Error('Worker already initialized');
  const { cwd, stateDir, sessionFile, model, tools } = params;
  const runtime = await ModelRuntime.create({ authPath: `${stateDir}/auth.json`, modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider('o8-managed', {
    api: 'openai-completions', baseUrl: 'https://o8-host.invalid',
    apiKey: 'host-transport-only', models: [{ ...model, api: 'openai-completions' }],
    streamSimple(model, context, options = {}) {
      const stream = createAssistantMessageEventStream();
      const abort = () => stream.push({ type: 'error', reason: 'aborted',
        error: failedMessage(model, 'aborted', 'Stopped') });
      if (options.signal?.aborted) { abort(); return stream; }
      options.signal?.addEventListener('abort', abort, { once: true });
      void hostRequest('model', { context }, stream).catch(() => {
        stream.push({ type: 'error', reason: 'error',
          error: failedMessage(model, 'error', 'Managed inference unavailable') });
      }).finally(() => options.signal?.removeEventListener('abort', abort));
      return stream;
    },
  });
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'Help with files in the selected workspace. Use only the declared tools. Do not claim success after denied or failed actions.',
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  const sessionManager = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(cwd, `${stateDir}/sessions`);
  if (sessionManager.getCwd() !== cwd) throw new Error('Session workspace mismatch');
  ({ session } = await createAgentSession({ cwd, agentDir: stateDir, modelRuntime: runtime,
    model: runtime.getModel('o8-managed', model.id), resourceLoader,
    tools: tools.map(tool => tool.name),
    customTools: tools.map(tool => ({ ...tool, label: tool.name,
      execute: async (_id, args, signal) => {
        if (signal?.aborted) throw new Error('Stopped');
        return hostRequest('tool', { name: tool.name, args });
      } })),
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }),
  }));
  session.subscribe(event => send({ method: 'event', params: { event } }));
  return { sessionFile: session.sessionManager.getSessionFile(), sessionId: session.sessionManager.getSessionId(),
    tools: session.getActiveToolNames(), messageCount: session.messages.length };
}
async function command(method, params = {}) {
  if (method === 'initialize') return initialize(params);
  if (method === 'model_event') { streams.get(params.id)?.push(params.event); return {}; }
  if (method === 'shutdown') { if (session) { await session.abort(); session.dispose(); } return {}; }
  if (!session) throw new Error('Worker is not initialized');
  if (method === 'abort') { await session.abort(); return {}; }
  if (method === 'prompt') {
    if (active) throw new Error('A run is already active');
    active = true;
    const messageOffset = session.messages.length;
    try {
      // An idle or restored session starts with prompt, never queue-only followUp.
      await session.prompt(params.message);
      await session.waitForIdle();
      const last = session.messages.slice(messageOffset).reverse().find(message => message.role === 'assistant');
      return { text: last?.content.filter(part => part.type === 'text').map(part => part.text).join('') ?? '', stopReason: last?.stopReason,
        ...(last?.errorMessage ? { errorMessage: last.errorMessage } : {}), messageCount: session.messages.length };
    } finally { active = false; }
  }
  throw new Error('Unsupported worker command');
}
const decoder = new StringDecoder('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += decoder.write(chunk);
  if (buffer.length > 4 * 1024 * 1024) { process.exitCode = 1; process.stdin.destroy(); return; }
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    let frame;
    try { frame = JSON.parse(line); } catch { process.exitCode = 1; process.stdin.destroy(); return; }
    if (frame.jsonrpc !== '2.0') continue;
    if (frame.method) {
      void command(frame.method, frame.params).then(result => send({ id: frame.id, result }),
        () => send({ id: frame.id, error: { code: -32000, message: 'Worker command failed' } }));
    } else {
      const waiter = pending.get(frame.id); pending.delete(frame.id);
      if (frame.error) waiter?.reject(new Error('Host operation failed'));
      else waiter?.resolve(frame.result);
    }
  }
});
process.stdin.on('end', async () => {
  for (const waiter of pending.values()) waiter.reject(new Error('Host disconnected'));
  pending.clear();
  if (session) { await session.abort(); session.dispose(); }
});
