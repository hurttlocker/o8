/**
 * Minimal MCP-stdio JSON-RPC client for one-shot tool calls.
 *
 * Spawns a fresh codebase-memory-mcp child process, runs initialize +
 * tools/call, then closes stdin so the child exits. We don't keep the
 * child alive across calls — the boot indexer runs each repo serially
 * (modulo the concurrency cap) and the binary's index step is the
 * expensive part, not the spawn.
 *
 * Wire format mirrors src/lib/mcp/test-connection.ts. Both build on the
 * MCP 2024-11-05 protocol with newline-delimited JSON-RPC frames.
 */

import 'server-only';

import { spawn } from 'node:child_process';

const INIT_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 5 * 60_000; // 5 min — large repos take time to index

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolCallInput {
  binPath: string;
  cwd: string;
  toolName: string;
  args?: Record<string, unknown>;
  /** Override timeout (ms) for the tools/call response. */
  timeoutMs?: number;
}

export interface McpToolCallSuccess {
  ok: true;
  result: unknown;
  durationMs: number;
}

export interface McpToolCallFailure {
  ok: false;
  error: string;
  stderr?: string;
  durationMs: number;
}

export type McpToolCallResult = McpToolCallSuccess | McpToolCallFailure;

export async function callCodebaseMemoryTool(
  input: McpToolCallInput,
): Promise<McpToolCallResult> {
  const started = Date.now();
  const callTimeoutMs = input.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  let stderrBuf = '';

  return new Promise<McpToolCallResult>((resolve) => {
    let resolved = false;
    let killed = false;
    let child: ReturnType<typeof spawn> | null = null;

    try {
      child = spawn(input.binPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: input.cwd,
        env: { ...process.env },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({
        ok: false,
        error: `Spawn failed — ${message}`,
        durationMs: Date.now() - started,
      });
      return;
    }

    const finish = (result: McpToolCallResult) => {
      if (resolved) return;
      resolved = true;
      if (child && !killed) {
        killed = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          if (child && !child.killed) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }
        }, 500);
      }
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({
        ok: false,
        error: `Timed out after ${callTimeoutMs}ms`,
        stderr: stderrBuf || undefined,
        durationMs: Date.now() - started,
      });
    }, callTimeoutMs);

    child.on('error', (err) => {
      clearTimeout(timeout);
      finish({
        ok: false,
        error: `Process error — ${err.message}`,
        stderr: stderrBuf || undefined,
        durationMs: Date.now() - started,
      });
    });

    child.on('exit', (code, signal) => {
      if (resolved) return;
      clearTimeout(timeout);
      const hint = signal ? `signal ${signal}` : `exit code ${code ?? '?'}`;
      finish({
        ok: false,
        error: `Process exited before tool call completed (${hint})`,
        stderr: stderrBuf || undefined,
        durationMs: Date.now() - started,
      });
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
      // Cap stderr buffer to avoid runaway memory.
      if (stderrBuf.length > 8000) {
        stderrBuf = stderrBuf.slice(-8000);
      }
    });

    let stdoutBuf = '';
    const pending = new Map<number, (resp: JsonRpcResponse) => void>();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8');
      let nl = stdoutBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        nl = stdoutBuf.indexOf('\n');
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === 'number' && pending.has(msg.id)) {
            const handler = pending.get(msg.id)!;
            pending.delete(msg.id);
            handler(msg);
          }
        } catch {
          // Notification or malformed — ignore.
        }
      }
    });

    const writeRequest = (req: JsonRpcRequest): boolean => {
      if (!child?.stdin || child.stdin.destroyed) {
        finish({
          ok: false,
          error: 'Child stdin closed before request was sent',
          stderr: stderrBuf || undefined,
          durationMs: Date.now() - started,
        });
        return false;
      }
      try {
        child.stdin.write(`${JSON.stringify(req)}\n`);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finish({
          ok: false,
          error: `Failed to write request — ${message}`,
          stderr: stderrBuf || undefined,
          durationMs: Date.now() - started,
        });
        return false;
      }
    };

    const awaitResponse = (id: number, perRequestTimeoutMs?: number): Promise<JsonRpcResponse> =>
      new Promise<JsonRpcResponse>((respResolve, respReject) => {
        if (perRequestTimeoutMs) {
          const t = setTimeout(() => {
            pending.delete(id);
            respReject(new Error(`Request id ${id} timed out`));
          }, perRequestTimeoutMs);
          pending.set(id, (resp) => {
            clearTimeout(t);
            respResolve(resp);
          });
        } else {
          pending.set(id, respResolve);
        }
      });

    // 1) initialize
    if (
      !writeRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'o8-codebase-memory-indexer', version: '1.0.0' },
        },
      })
    )
      return;

    void awaitResponse(1, INIT_TIMEOUT_MS)
      .then((initResp) => {
        if (initResp.error) {
          finish({
            ok: false,
            error: `initialize failed — ${initResp.error.message}`,
            stderr: stderrBuf || undefined,
            durationMs: Date.now() - started,
          });
          return;
        }

        // Per spec: notify initialized.
        writeRequest({ jsonrpc: '2.0', id: 2, method: 'notifications/initialized' });

        // 2) tools/call
        if (
          !writeRequest({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: input.toolName,
              arguments: input.args ?? {},
            },
          })
        )
          return;

        void awaitResponse(3)
          .then((callResp) => {
            if (callResp.error) {
              finish({
                ok: false,
                error: `${input.toolName} failed — ${callResp.error.message}`,
                stderr: stderrBuf || undefined,
                durationMs: Date.now() - started,
              });
              return;
            }
            // #852: MCP tools/call can return a JSON-RPC success whose result
            // payload has `isError: true`. Without this check we treated tool-
            // level failures (e.g. "repo_path is required") as success and
            // marked repos indexed when nothing was written.
            const toolResult = callResp.result as
              | { isError?: boolean; content?: Array<{ type?: string; text?: string }> }
              | undefined;
            if (toolResult && toolResult.isError === true) {
              const text = toolResult.content
                ?.map((c) => c?.text ?? '')
                .filter(Boolean)
                .join(' ')
                .trim();
              clearTimeout(timeout);
              finish({
                ok: false,
                error: `${input.toolName} reported isError${text ? ` — ${text}` : ''}`,
                stderr: stderrBuf || undefined,
                durationMs: Date.now() - started,
              });
              return;
            }
            clearTimeout(timeout);
            finish({
              ok: true,
              result: callResp.result,
              durationMs: Date.now() - started,
            });
          })
          .catch((err: Error) => {
            finish({
              ok: false,
              error: err.message,
              stderr: stderrBuf || undefined,
              durationMs: Date.now() - started,
            });
          });
      })
      .catch((err: Error) => {
        finish({
          ok: false,
          error: err.message,
          stderr: stderrBuf || undefined,
          durationMs: Date.now() - started,
        });
      });
  });
}
