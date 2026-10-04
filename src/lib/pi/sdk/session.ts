import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context, Model } from '@earendil-works/pi-ai';
import { StdioJsonRpcPeer, type StdioJsonRpcInboundRequest } from '@/lib/runtimes/shared/stdio-json-rpc';
import { createPiApproval } from './approval';
import { executePiTool, PI_SDK_TOOLS, type PiApproval } from './tools';
import { createManagedPiTransport, type PiModelTransport } from './transport';

export interface PiSdkSessionOptions {
  workspace: string;
  stateDir: string;
  model: Model<'openai-completions'>;
  sessionFile?: string;
  /** Trusted host adapters only. Never populate these from model or request arguments. */
  transport?: PiModelTransport;
  approve?: PiApproval;
  onEvent?: (event: Record<string, unknown>) => void;
  maxModelCalls?: number;
  maxToolCalls?: number;
  runTimeoutMs?: number;
}
export interface PiRunResult { text?: string; stopReason?: string; messageCount: number }

export function requirePiNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!Number.isFinite(major) || major < 22 || (major === 22 && minor < 19)) {
    throw new Error('The Pi prototype needs Node 22.19 or newer. Install a supported runtime before starting; o8 will not install it automatically.');
  }
}

/** Opt-in host API, not registered as a default runtime or exposed as an HTTP route. */
export async function createPiSdkSession(options: PiSdkSessionOptions) {
  requirePiNode();
  const root = await realpath(options.workspace);
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(options.stateDir);
  const stateRelative = relative(root, stateDir);
  if (stateRelative === '' || (!(stateRelative === '..' || stateRelative.startsWith(`..${sep}`)) && !isAbsolute(stateRelative))) {
    throw new Error('SDK state must be outside the tool workspace');
  }
  let sessionFile: string | undefined;
  if (options.sessionFile) {
    sessionFile = await realpath(options.sessionFile);
    const rel = relative(resolve(stateDir, 'sessions'), sessionFile);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Session is outside owned storage');
  }
  let surfaceId = '';
  const approve: PiApproval = options.approve ?? ((call, signal) => createPiApproval(surfaceId, root)(call, signal));
  const transport = options.transport ?? createManagedPiTransport({ model: options.model });
  const workerPath = fileURLToPath(new URL('../../../../scripts/pi-sdk/worker.mjs', import.meta.url));
  const peer = new StdioJsonRpcPeer({ command: process.execPath, args: [workerPath], cwd: stateDir,
    // No inherited provider keys, NODE_OPTIONS, user extension paths or proxy variables.
    env: { NODE_ENV: 'production', HOME: stateDir, USERPROFILE: stateDir, PI_OFFLINE: '1', NO_COLOR: '1' } });
  let run: AbortController | undefined;
  let closed = false;
  let modelCalls = 0;
  let toolCalls = 0;
  let settled = false;
  peer.on('notification', ({ method, params }) => {
    if (method !== 'event' || !params.event) return;
    if (params.event.type === 'agent_settled') settled = true;
    try { options.onEvent?.(params.event); } catch { /* Observer failure cannot change worker authority. */ }
  });
  peer.on('fatal', () => run?.abort());
  peer.on('exit', () => run?.abort());
  async function handleRequest(request: StdioJsonRpcInboundRequest) {
    const signal = run?.signal;
    if (!signal || signal.aborted) throw new Error('No active authorized run');
    if (request.method === 'tool') {
      if (++toolCalls > (options.maxToolCalls ?? 16)) throw new Error('Tool-call budget exhausted');
      const name = request.params.name;
      const args = request.params.args;
      if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('Invalid tool request');
      }
      return executePiTool(root, { name, args: args as Record<string, unknown> }, approve, signal);
    }
    if (request.method === 'model') {
      if (++modelCalls > (options.maxModelCalls ?? 8)) throw new Error('Model-call budget exhausted');
      const context = request.params.context as Context;
      if (!context || !Array.isArray(context.messages)) throw new Error('Invalid model context');
      for await (const event of transport(context, signal)) {
        signal.throwIfAborted();
        await peer.request('model_event', { id: request.id, event });
      }
      return {};
    }
    throw new Error('Unsupported worker request');
  }
  peer.on('request', (request: StdioJsonRpcInboundRequest) => {
    void handleRequest(request).then(result => {
      if (peer.running) peer.respond(request.id, result);
    }, () => {
      // Do not send host paths, credentials, raw provider bodies or stack traces to the worker.
      if (peer.running) peer.respondError(request.id, -32001, 'Host operation denied or unavailable');
    }).catch(() => { run?.abort(); });
  });
  let ready: { sessionFile: string; sessionId: string; tools: string[]; messageCount: number };
  try {
    ready = await peer.request('initialize', { cwd: root, stateDir, sessionFile,
      model: { id: options.model.id, name: options.model.name, reasoning: false, input: ['text'],
        contextWindow: options.model.contextWindow, maxTokens: options.model.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, tools: PI_SDK_TOOLS });
  } catch (error) { await peer.close(); throw error; }
  surfaceId = `pi-sdk:${ready.sessionId}`;
  return {
    ...ready,
    surfaceId,
    get pid() { return peer.pid; },
    get running() { return peer.running; },
    async prompt(message: string): Promise<PiRunResult> {
      if (closed || run) throw new Error('Session is closed or busy');
      if (!message.trim() || Buffer.byteLength(message) > 50_000) throw new Error('Invalid prompt');
      run = new AbortController(); modelCalls = 0; toolCalls = 0; settled = false;
      const timeoutMs = options.runTimeoutMs ?? 120_000;
      const timeout = setTimeout(() => {
        run?.abort();
        void peer.request('abort').catch(() => peer.close());
      }, timeoutMs);
      try {
        const result = await peer.request<PiRunResult>('prompt', { message }, timeoutMs + 5_000);
        if (!settled) throw new Error('Worker returned before settled completion');
        return result;
      } catch (error) {
        run.abort();
        await peer.close();
        closed = true;
        throw error;
      } finally { clearTimeout(timeout); run = undefined; }
    },
    async abort() {
      run?.abort();
      await peer.request('abort').catch(async () => { await peer.close(); closed = true; });
    },
    async close() {
      closed = true;
      run?.abort();
      await peer.close();
    },
  };
}
