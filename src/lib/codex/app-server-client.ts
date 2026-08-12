import 'server-only';

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

type JsonRpcId = number | string;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexAppServerRequestError extends Error {
  constructor(
    readonly method: string,
    readonly sideEffect: 'none' | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'CodexAppServerRequestError';
  }
}

export interface CodexAppServerNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexAppServerClientOptions {
  binaryPath: string;
  codexHome: string;
  onNotification?: (notification: CodexAppServerNotification) => void;
  onExit?: (detail: string) => void;
  requestTimeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Shared NDJSON JSON-RPC client for the local Codex app-server. */
export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly onNotification: NonNullable<CodexAppServerClientOptions['onNotification']>;
  private readonly onExit: NonNullable<CodexAppServerClientOptions['onExit']>;
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private stdout = '';
  private closed = false;
  private stderrTail: string[] = [];

  constructor(options: CodexAppServerClientOptions) {
    this.onNotification = options.onNotification ?? (() => {});
    this.onExit = options.onExit ?? (() => {});
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const launch = cliInvocation(options.binaryPath, ['app-server', '--stdio']);
    this.child = spawn(launch.command, launch.args, {
      windowsHide: true,
      env: {
        ...process.env,
        CODEX_HOME: options.codexHome,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf-8');
    this.child.stderr.setEncoding('utf-8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail.push(...chunk.split(/\r?\n/).filter(Boolean));
      this.stderrTail = this.stderrTail.slice(-20);
    });
    this.child.once('error', (error) => this.failAll(error));
    this.child.once('exit', (code, signal) => {
      const detail = `Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      this.closed = true;
      this.failAll(new Error(detail));
      this.onExit(detail);
    });
  }

  private onStdout(chunk: string): void {
    this.stdout += chunk;
    const lines = this.stdout.split(/\r?\n/);
    this.stdout = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: Record<string, unknown> | null = null;
      try {
        message = record(JSON.parse(line));
      } catch {
        continue;
      }
      if (!message) continue;

      if (message.id !== undefined && ('result' in message || 'error' in message)) {
        const key = String(message.id);
        const pending = this.pending.get(key);
        if (!pending) continue;
        this.pending.delete(key);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new CodexAppServerRequestError(
            pending.method,
            'none',
            `Codex app-server ${pending.method}: ${JSON.stringify(message.error)}`,
          ));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }

      if (message.id !== undefined && typeof message.method === 'string') {
        this.write({
          id: message.id as JsonRpcId,
          error: { code: -32601, message: `Unsupported server request: ${message.method}` },
        });
        continue;
      }

      if (typeof message.method === 'string') {
        this.onNotification({
          method: message.method,
          params: record(message.params) ?? {},
        });
      }
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin.writable) {
      throw new Error('Codex app-server stdin is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        const stderr = this.stderrTail.length > 0 ? `: ${this.stderrTail.join(' | ')}` : '';
        reject(new CodexAppServerRequestError(
          method,
          'unknown',
          `${method} timed out after ${timeoutMs}ms${stderr}`,
        ));
      }, timeoutMs);
      this.pending.set(String(id), { method, resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(new CodexAppServerRequestError(
          method,
          'none',
          error instanceof Error ? error.message : String(error),
        ));
      }
    });
  }

  notify(method: string): void {
    this.write({ method });
  }

  async initialize(clientName = 'o8-connected-voice', clientVersion = '1'): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: clientName, version: clientVersion },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('Codex app-server session closed'));
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
    }
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 1_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
