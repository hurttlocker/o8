/** Read-only wait on a live dashboard shell. Attach before snapshot to close the read/stream race. */
import WebSocket from 'ws';
import { CliError, EXIT, resolveWsBase } from '../api.js';
import type { ResolvedConfig } from '../config.js';
import { printJson, type OutputMode } from '../output.js';

interface TerminalFrame {
  channel?: string;
  event?: string;
  data?: { sessionName?: string; data?: string; error?: string };
}

function plainTerminalText(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

function matchingLine(text: string, match: string): string | null {
  const position = text.indexOf(match);
  if (position < 0) return null;
  const start = text.lastIndexOf('\n', position - 1) + 1;
  const end = text.indexOf('\n', position);
  return text.slice(start, end < 0 ? undefined : end).trimEnd();
}

export function waitForTerminalOutput(
  cfg: ResolvedConfig,
  id: string,
  match: string,
  timeoutMs: number,
  mode: OutputMode,
): Promise<number> {
  const url = new URL('/ws', resolveWsBase(cfg));
  url.searchParams.set('token', cfg.token!);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const decoder = new TextDecoder();
    let settled = false;
    let textBuffer = '';
    const finish = (result: { source: 'snapshot' | 'stream'; line: string } | CliError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
      socket.close();
      if (result instanceof CliError) { reject(result); return; }
      const receipt = {
        schema: 'o8/cli/terminal.wait/v1',
        id,
        match,
        line: result.line,
        source: result.source,
        waitedMs: Date.now() - startedAt,
      };
      if (mode.human) process.stdout.write(`${result.line}\n`);
      else printJson(receipt);
      resolve(EXIT.OK);
    };
    const cancel = () => finish(new CliError('wait_cancelled', 'Terminal output wait was cancelled.', EXIT.CONFLICT));
    const timer = setTimeout(() => finish(new CliError(
      'wait_timeout',
      `No matching output appeared in terminal ${id} within ${timeoutMs} ms.`,
      EXIT.CONFLICT,
      'Inspect the terminal before retrying the command that produced output.',
    )), timeoutMs);
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    const inspect = (output: string, source: 'snapshot' | 'stream') => {
      const line = matchingLine(output, match);
      if (line !== null) finish({ source, line });
    };
    socket.on('open', () => socket.send(JSON.stringify({
      type: 'terminal-attach', sessionName: id, readOnly: true,
    })));
    socket.on('message', (raw) => {
      let frame: TerminalFrame;
      try { frame = JSON.parse(String(raw)) as TerminalFrame; } catch { return; }
      if (frame.channel !== 'terminal' || frame.data?.sessionName !== id) return;
      if (frame.event === 'error') {
        finish(new CliError('terminal_unavailable', frame.data.error ?? 'Terminal unavailable.', EXIT.NOT_FOUND));
        return;
      }
      if (frame.event === 'exited') {
        finish(new CliError('terminal_exited', 'Terminal exited before matching output appeared.', EXIT.NOT_FOUND));
        return;
      }
      if (frame.event === 'attached') {
        const snapshot = new URL('/terminal-snapshot', resolveWsBase(cfg));
        snapshot.protocol = 'http:';
        snapshot.searchParams.set('sessionName', id);
        snapshot.searchParams.set('lines', '1000');
        void fetch(snapshot, {
          headers: { Authorization: `Bearer ${cfg.token}` },
          signal: AbortSignal.timeout(8_000),
        }).then(async (response) => {
          if (settled) return;
          if (!response.ok) throw new Error(`Terminal snapshot returned ${response.status}.`);
          const payload = await response.json() as { text?: unknown };
          if (typeof payload.text !== 'string') throw new Error('Terminal snapshot was invalid.');
          inspect(payload.text, 'snapshot');
        }).catch(() => {
          // History is best effort. The read-only stream remains attached and can
          // still satisfy the requested wait until its own deadline.
        });
        return;
      }
      if (['data', 'resync'].includes(frame.event ?? '') && typeof frame.data.data === 'string') {
        textBuffer += plainTerminalText(decoder.decode(Buffer.from(frame.data.data, 'base64'), { stream: true }));
        if (textBuffer.length > 65_536) textBuffer = textBuffer.slice(-65_536);
        inspect(textBuffer, 'stream');
      }
    });
    socket.on('error', () => finish(new CliError(
      'connection_refused', 'Could not connect to the o8 terminal host.', EXIT.CONNECTION_REFUSED,
    )));
    socket.on('close', () => {
      if (!settled) finish(new CliError('terminal_disconnected', 'Terminal output stream disconnected.', EXIT.CONNECTION_REFUSED));
    });
  });
}
