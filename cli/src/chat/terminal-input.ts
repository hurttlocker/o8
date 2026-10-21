import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const START = '\x1b[200~';
const END = '\x1b[201~';
const MAX_PASTE = 1_048_576;

/** Keep bracketed paste separate from keys, even when a PTY splits the markers. */
export function terminalInput(source: NodeJS.ReadStream) {
  const stream = new PassThrough();
  const paste = new EventEmitter();
  const decoder = new StringDecoder('utf8');
  Object.assign(stream, {
    isTTY: source.isTTY,
    setRawMode: (enabled: boolean) => source.setRawMode(enabled),
    ref: () => source.ref(),
    unref: () => source.unref(),
  });
  let buffer = '';
  let pasted: string | null = null;
  let tooLarge = false;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let keyBuffer = '';
  let mouseTimer: ReturnType<typeof setTimeout> | undefined;
  // Ink labels both DEL and the forward-delete escape as delete. Normalize
  // only key bytes so Backspace and forward Delete remain different actions.
  const keys = (text: string) => {
    clearTimeout(mouseTimer);
    keyBuffer += text;
    keyBuffer = keyBuffer.replace(/\x1b\[<(\d+);\d+;\d+([Mm])/g, (_, button: string, action: string) => {
      const code = Number(button);
      if ((code & 64) && action === 'M') paste.emit('scroll', (code & 1) ? 3 : -3);
      return '';
    });
    const partial = /\x1b(?:\[(?:<[\d;]*)?)?$/.exec(keyBuffer);
    const end = partial?.index ?? keyBuffer.length;
    if (end) stream.write(keyBuffer.slice(0, end).replace(/\x7f/g, '\x08'));
    keyBuffer = keyBuffer.slice(end);
    if (keyBuffer) mouseTimer = setTimeout(() => { stream.write(keyBuffer); keyBuffer = ''; }, 25);
  };
  const consume = (chunk: Buffer | string) => {
    clearTimeout(escapeTimer);
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    while (buffer) {
      const marker = pasted === null ? START : END;
      const at = buffer.indexOf(marker);
      if (at >= 0) {
        const content = buffer.slice(0, at);
        if (pasted === null) {
          if (content) keys(content);
          pasted = '';
        } else {
          pasted += content;
          if (tooLarge || pasted.length > MAX_PASTE) paste.emit('overflow');
          else paste.emit('paste', pasted);
          pasted = null;
          tooLarge = false;
        }
        buffer = buffer.slice(at + marker.length);
        continue;
      }
      // Hold a possible split marker, but never swallow ordinary Escape keys.
      let hold = 0;
      for (let length = Math.min(buffer.length, marker.length - 1); length > 0; length -= 1) {
        if (buffer.endsWith(marker.slice(0, length))) { hold = length; break; }
      }
      const content = buffer.slice(0, buffer.length - hold);
      buffer = hold ? buffer.slice(-hold) : '';
      if (pasted === null) { if (content) keys(content); }
      else if (!tooLarge) {
        pasted += content;
        if (pasted.length > MAX_PASTE) { pasted = ''; tooLarge = true; }
      }
      if (buffer && pasted === null) {
        escapeTimer = setTimeout(() => {
          keys(buffer);
          buffer = '';
        }, 25);
      }
      break;
    }
  };
  source.on('data', consume);
  return {
    stream: stream as unknown as NodeJS.ReadStream,
    paste,
    close() { clearTimeout(escapeTimer); clearTimeout(mouseTimer); source.off('data', consume); stream.destroy(); paste.removeAllListeners(); },
  };
}
