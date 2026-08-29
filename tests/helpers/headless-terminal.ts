import { Terminal } from '@xterm/headless';

export async function renderTerminalBytes(
  chunks: string[],
  options: { cols: number; rows: number; scrollback?: number; trimTrailingBlankLines?: boolean },
): Promise<string[]> {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols: options.cols,
    convertEol: false,
    rows: options.rows,
    scrollback: options.scrollback ?? 20_000,
  });
  try {
    for (const chunk of chunks) {
      await new Promise<void>((resolve) => terminal.write(chunk, resolve));
    }
    const lines: string[] = [];
    for (let index = 0; index < terminal.buffer.active.length; index += 1) {
      lines.push(terminal.buffer.active.getLine(index)?.translateToString(true) ?? '');
    }
    if (options.trimTrailingBlankLines !== false) {
      while (lines.at(-1) === '') lines.pop();
    }
    return lines;
  } finally {
    terminal.dispose();
  }
}
