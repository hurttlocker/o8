const ESC = '\x1b';
const BEL = '\x07';

function isProbeReply(sequence: string): boolean {
  if (sequence.startsWith(`${ESC}[`)) {
    return /^\x1b\[\?[\d;]+c$/.test(sequence)
      || /^\x1b\[>[\d;]+c$/.test(sequence)
      || /^\x1b\[(?:4|8);[\d;]+t$/.test(sequence)
      || /^\x1b\[\d+;\d+R$/.test(sequence)
      || /^\x1b\[\?[\d;]+n$/.test(sequence)
      || sequence === `${ESC}[0n`;
  }
  return /^\x1b\](?:10|11|12);/.test(sequence);
}

/** Keep xterm's replies to attach-time probes out of a remote shell's input. */
export class TerminalProbeReplyFilter {
  private pending = '';

  push(text: string): string {
    let source = this.pending + text;
    this.pending = '';
    let output = '';
    while (source) {
      const escapeAt = source.indexOf(ESC);
      if (escapeAt < 0) return output + source;
      output += source.slice(0, escapeAt);
      source = source.slice(escapeAt);
      if (source.length === 1) break;
      if (source[1] === '[') {
        let end = 2;
        while (end < source.length && (source.charCodeAt(end) < 0x40 || source.charCodeAt(end) > 0x7e)) end++;
        if (end === source.length) break;
        const sequence = source.slice(0, end + 1);
        if (!isProbeReply(sequence)) output += sequence;
        source = source.slice(end + 1);
        continue;
      }
      if (source[1] === ']') {
        const st = source.indexOf(`${ESC}\\`, 2);
        const bel = source.indexOf(BEL, 2);
        const end = st < 0 ? bel : bel < 0 ? st : Math.min(st, bel);
        if (end < 0) break;
        const sequence = source.slice(0, end + (end === st ? 2 : 1));
        if (!isProbeReply(sequence)) output += sequence;
        source = source.slice(sequence.length);
        continue;
      }
      output += source.slice(0, 2);
      source = source.slice(2);
    }
    this.pending = source;
    if (this.pending.length > 512) {
      output += this.pending;
      this.pending = '';
    }
    return output;
  }

  get pendingDelayMs(): number {
    return this.pending === ESC ? 20 : 100;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  flush(): string {
    const pending = this.pending;
    this.pending = '';
    // A partial, identified probe must not turn into literal shell input if
    // its remaining bytes never arrive. A lone Escape remains a real key.
    if (/^\x1b\[(?:[?>][\d;]*|(?:4|8);[\d;]*)$/.test(pending)
      || /^\x1b\](?:10|11|12);/.test(pending)) return '';
    return pending;
  }
}
