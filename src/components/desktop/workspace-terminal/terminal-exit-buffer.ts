import type { Terminal } from '@xterm/xterm';
import { TERMINAL_SCROLLBACK_LINES } from '@/lib/terminal/client-retention';

type BufferReader = Pick<Terminal, 'buffer' | 'parser'>;

function readBuffer(term: BufferReader): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let index = Math.max(0, buffer.length - TERMINAL_SCROLLBACK_LINES); index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  return lines.join('\n').replace(/\s+$/g, '');
}

/** tmux leaves its alternate screen before replacing it with its exit marker. */
export function retainTerminalExitBuffer(term: BufferReader) {
  let alternate = '';
  let normalBeforeAlternate = '';
  const remember = () => { const text = readBuffer(term); if (text.trim()) alternate = text; };
  const enterListener = term.parser?.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (term.buffer.active.type === 'normal' && params.some((mode) => mode === 47 || mode === 1047 || mode === 1049)) normalBeforeAlternate = readBuffer(term);
    return false;
  });
  const clearListener = term.parser?.registerCsiHandler({ final: 'J' }, () => {
    if (term.buffer.active.type === 'alternate') remember();
    return false;
  });
  const listener = term.parser?.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (term.buffer.active.type === 'alternate' && params.some((mode) => mode === 47 || mode === 1047 || mode === 1049)) remember();
    return false;
  });
  return {
    read: () => {
      const current = readBuffer(term);
      // A history snapshot may precede tmux's alternate screen. Its restored
      // normal buffer plus only the exit marker is still stale history.
      const restoredNormal = current.replace(/\[exited\]\s*$/u, '').trimEnd();
      return current.endsWith('[exited]') && restoredNormal === normalBeforeAlternate && alternate ? alternate : current;
    },
    dispose: () => { listener?.dispose(); clearListener?.dispose(); enterListener?.dispose(); },
  };
}
