export interface TerminalHiddenBufferAppendResult {
  droppedBytes: number;
  reportOverflow: boolean;
  retainedBytes: number;
}

/**
 * Byte-preserving bounded queue for one hidden terminal client. Buffering bytes
 * instead of strings keeps split UTF-8 and escape sequences ordered exactly as
 * the PTY produced them. Overflow keeps the newest bytes and requires resync.
 */
export class TerminalHiddenBuffer {
  private chunks: Buffer[] = [];
  private retainedBytes = 0;
  private overflowReported = false;

  constructor(readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error('terminal hidden buffer maxBytes must be a positive integer');
    }
  }

  get byteLength(): number {
    return this.retainedBytes;
  }

  beginHiddenPeriod(): void {
    this.overflowReported = false;
  }

  append(data: string | Buffer): TerminalHiddenBufferAppendResult {
    const chunk = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, 'utf8');
    if (chunk.byteLength === 0) {
      return { droppedBytes: 0, reportOverflow: false, retainedBytes: this.retainedBytes };
    }
    this.chunks.push(chunk);
    this.retainedBytes += chunk.byteLength;

    let droppedBytes = 0;
    while (this.retainedBytes > this.maxBytes && this.chunks.length > 0) {
      const excess = this.retainedBytes - this.maxBytes;
      const first = this.chunks[0];
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.retainedBytes -= first.byteLength;
        droppedBytes += first.byteLength;
        continue;
      }
      this.chunks[0] = first.subarray(excess);
      this.retainedBytes -= excess;
      droppedBytes += excess;
    }
    const reportOverflow = droppedBytes > 0 && !this.overflowReported;
    if (reportOverflow) this.overflowReported = true;
    return { droppedBytes, reportOverflow, retainedBytes: this.retainedBytes };
  }

  drain(): Buffer {
    if (this.retainedBytes === 0) return Buffer.alloc(0);
    const output = Buffer.concat(this.chunks, this.retainedBytes);
    this.clear();
    return output;
  }

  clear(): void {
    this.chunks = [];
    this.retainedBytes = 0;
  }
}
