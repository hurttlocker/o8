import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface StdioJsonRpcLaunch {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface StdioJsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface StdioJsonRpcInboundRequest extends StdioJsonRpcNotification {
  id: string | number;
}

interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
  method?: unknown;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const STDERR_LIMIT = 32_000;

export class StdioJsonRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'StdioJsonRpcError';
  }
}

/**
 * Reusable newline-delimited JSON-RPC 2.0 process owner.
 *
 * Runtime adapters supply protocol meaning; this class owns framing, request
 * correlation, diagnostics, bounded timeouts, and a cooperative-to-forced
 * shutdown ladder. Stdout is strict protocol space: malformed lines fail every
 * waiter instead of being silently reinterpreted as runtime output.
 */
export class StdioJsonRpcPeer extends EventEmitter {
  private child: ChildProcess | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private nextId = 1;
  private closing = false;
  private fatalError: Error | null = null;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly launch: StdioJsonRpcLaunch,
    private readonly defaultTimeoutMs = 30_000,
  ) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get stderrTail(): string {
    return this.stderrBuffer.slice(-8_000);
  }

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null);
  }

  start(): void {
    if (this.child) return;
    const child = spawn(this.launch.command, this.launch.args ?? [], {
      windowsHide: true,
      cwd: this.launch.cwd,
      env: this.launch.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString('utf8');
      if (this.stderrBuffer.length > STDERR_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_LIMIT);
      }
      this.emit('stderr', chunk);
    });
    child.stdin?.on('error', (error: Error) => {
      if (!this.closing) this.fail(new Error(`JSON-RPC stdin failed: ${error.message}`));
    });
    child.on('error', (error) => {
      if (!this.closing) this.fail(new Error(`JSON-RPC process failed: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      if (!this.closing) this.fail(new Error(`JSON-RPC process exited (${detail})${this.diagnostics()}`));
      this.emit('exit', { code, signal });
    });
  }

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<T> {
    this.start();
    if (this.fatalError) throw this.fatalError;
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) {
      throw new Error(`JSON-RPC process is unavailable${this.diagnostics()}`);
    }
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms${this.diagnostics()}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
    });
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      })}\n`);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timeout);
      this.pending.delete(id);
      throw error;
    }
    return response;
  }

  respond(id: string | number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: string | number, code: number, message: string, data?: unknown): void {
    this.write({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  async close(options: {
    shutdownMethod?: string;
    gracefulMs?: number;
    terminateMs?: number;
  } = {}): Promise<void> {
    const child = this.child;
    if (!child) return;
    const shutdownMethod = options.shutdownMethod ?? 'shutdown';
    const gracefulMs = options.gracefulMs ?? 1_000;
    const terminateMs = options.terminateMs ?? 750;
    this.closing = true;
    try {
      await this.request(shutdownMethod, undefined, gracefulMs);
    } catch {
      // The process still receives EOF and the signal ladder below.
    }
    child.stdin?.end();
    if (await this.waitForExit(gracefulMs)) return;
    child.kill('SIGTERM');
    if (await this.waitForExit(terminateMs)) return;
    child.kill('SIGKILL');
    await this.waitForExit(terminateMs);
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8');
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      newline = this.stdoutBuffer.indexOf('\n');
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        this.fail(new Error(`JSON-RPC stdout contained a malformed frame: ${line.slice(0, 300)}`));
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
    if (message.jsonrpc !== '2.0') {
      this.fail(new Error('JSON-RPC peer emitted a frame without jsonrpc="2.0".'));
      return;
    }
    if ((typeof message.id === 'number' || typeof message.id === 'string')
      && typeof message.method === 'string') {
      this.emit('request', {
        id: message.id,
        method: message.method,
        params: message.params && typeof message.params === 'object' && !Array.isArray(message.params)
          ? message.params as Record<string, unknown>
          : {},
      } satisfies StdioJsonRpcInboundRequest);
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error && typeof message.error === 'object') {
        const error = message.error as { code?: unknown; message?: unknown; data?: unknown };
        pending.reject(new StdioJsonRpcError(
          typeof error.message === 'string' ? error.message : 'JSON-RPC request failed.',
          typeof error.code === 'number' ? error.code : undefined,
          error.data,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      this.emit('notification', {
        method: message.method,
        params: message.params && typeof message.params === 'object' && !Array.isArray(message.params)
          ? message.params as Record<string, unknown>
          : {},
      } satisfies StdioJsonRpcNotification);
    }
  }

  private fail(error: Error): void {
    if (!this.fatalError) this.fatalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.fatalError);
    }
    this.pending.clear();
    this.emit('fatal', this.fatalError);
  }

  private write(message: Record<string, unknown>): void {
    if (this.fatalError) throw this.fatalError;
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) {
      throw new Error(`JSON-RPC process is unavailable${this.diagnostics()}`);
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private diagnostics(): string {
    const stderr = this.stderrTail.trim();
    return stderr ? `\nstderr tail:\n${stderr}` : '';
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.removeListener('exit', exited);
        resolve(false);
      }, timeoutMs);
      const exited = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      child.once('exit', exited);
    });
  }
}
