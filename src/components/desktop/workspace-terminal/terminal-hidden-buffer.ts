export interface ClientTerminalBufferAppendResult {
  droppedBytes: number;
  retainedBytes: number;
}

/** Browser-side byte ring used only while an xterm panel is hidden. */
export class ClientTerminalHiddenBuffer {
  private chunks: Uint8Array[] = [];
  private retainedBytes = 0;

  constructor(readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error('client terminal hidden buffer maxBytes must be a positive integer');
    }
  }

  get byteLength(): number {
    return this.retainedBytes;
  }

  append(data: Uint8Array): ClientTerminalBufferAppendResult {
    if (data.byteLength === 0) {
      return { droppedBytes: 0, retainedBytes: this.retainedBytes };
    }
    const chunk = data.slice();
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
      this.chunks[0] = first.slice(excess);
      this.retainedBytes -= excess;
      droppedBytes += excess;
    }
    return { droppedBytes, retainedBytes: this.retainedBytes };
  }

  drain(): Uint8Array {
    const output = new Uint8Array(this.retainedBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.clear();
    return output;
  }

  clear(): void {
    this.chunks = [];
    this.retainedBytes = 0;
  }
}
