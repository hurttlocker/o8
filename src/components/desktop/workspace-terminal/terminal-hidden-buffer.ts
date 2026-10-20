export interface ClientTerminalBufferAppendResult {
  droppedBytes: number;
  retainedBytes: number;
}

/** Browser-side byte ring used only while an xterm panel is hidden. */
export class ClientTerminalHiddenBuffer {
  private chunks: Array<{ data: Uint8Array; historical: boolean }> = [];
  private retainedBytes = 0;

  constructor(readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error('client terminal hidden buffer maxBytes must be a positive integer');
    }
  }

  get byteLength(): number {
    return this.retainedBytes;
  }

  append(data: Uint8Array, historical = false): ClientTerminalBufferAppendResult {
    if (data.byteLength === 0) {
      return { droppedBytes: 0, retainedBytes: this.retainedBytes };
    }
    const chunk = data.slice();
    this.chunks.push({ data: chunk, historical });
    this.retainedBytes += chunk.byteLength;

    let droppedBytes = 0;
    while (this.retainedBytes > this.maxBytes && this.chunks.length > 0) {
      const excess = this.retainedBytes - this.maxBytes;
      const first = this.chunks[0].data;
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.retainedBytes -= first.byteLength;
        droppedBytes += first.byteLength;
        continue;
      }
      this.chunks[0] = { ...this.chunks[0], data: first.slice(excess) };
      this.retainedBytes -= excess;
      droppedBytes += excess;
    }
    return { droppedBytes, retainedBytes: this.retainedBytes };
  }

  drainChunks(): Array<{ data: Uint8Array; historical: boolean }> {
    const runs: Array<{ parts: Uint8Array[]; size: number; historical: boolean }> = [];
    for (const chunk of this.chunks) {
      const previous = runs.at(-1);
      if (previous?.historical === chunk.historical) {
        previous.parts.push(chunk.data); previous.size += chunk.data.byteLength;
      } else runs.push({ parts: [chunk.data], size: chunk.data.byteLength, historical: chunk.historical });
    }
    this.clear();
    return runs.map((run) => {
      const data = new Uint8Array(run.size);
      let offset = 0;
      for (const part of run.parts) { data.set(part, offset); offset += part.byteLength; }
      return { data, historical: run.historical };
    });
  }

  drain(): Uint8Array {
    const output = new Uint8Array(this.retainedBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk.data, offset);
      offset += chunk.data.byteLength;
    }
    this.clear();
    return output;
  }

  clear(): void {
    this.chunks = [];
    this.retainedBytes = 0;
  }
}
