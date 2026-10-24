import type { RealtimeEventEnvelope, RealtimeStreamKey } from '@/lib/realtime/types';

type ReplayMetadata = Pick<RealtimeEventEnvelope, 'seq' | 'stream' | 'audience'>;

/** Retain wire JSON in one reusable UTF-8 allocation, not snapshot object graphs. */
export class RealtimeReplayLog {
  private readonly entries: (ReplayMetadata & { offset: number; bytes: number })[] = [];
  private storage: Buffer | null = null;
  private offset = 0;

  constructor(private readonly maxEntries: number, private readonly maxBytes: number) {}

  record(envelope: RealtimeEventEnvelope): void {
    const raw = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(raw, 'utf8');
    // The oversized event still goes out live. Clearing its prefix makes the
    // existing replay-gap protocol choose an authoritative checkpoint.
    if (bytes > this.maxBytes || this.maxEntries <= 0) {
      this.entries.length = 0;
      this.offset = 0;
      return;
    }
    this.storage ??= Buffer.allocUnsafeSlow(this.maxBytes);
    if (this.offset + bytes > this.maxBytes) this.offset = 0;
    const end = this.offset + bytes;
    let evict = 0;
    for (const [index, entry] of this.entries.entries()) {
      if (this.offset < entry.offset + entry.bytes && entry.offset < end) evict = index + 1;
    }
    // A wrap can consume unused tail space. Evict the entire overlapping
    // prefix so retained events remain a contiguous chronological suffix.
    if (evict) this.entries.splice(0, evict);
    if (this.entries.length >= this.maxEntries) this.entries.shift();
    this.storage.write(raw, this.offset, bytes, 'utf8');
    this.entries.push({ seq: envelope.seq, stream: envelope.stream, audience: envelope.audience, offset: this.offset, bytes });
    this.offset = end;
  }

  earliestSeq(stream: RealtimeStreamKey): number | undefined {
    return this.entries.find((entry) => entry.stream === stream)?.seq;
  }

  since(seq: number, matches: (entry: ReplayMetadata) => boolean): RealtimeEventEnvelope[] {
    return this.entries.filter((entry) => entry.seq > seq && matches(entry)).map((entry) => (
      JSON.parse(this.storage!.toString('utf8', entry.offset, entry.offset + entry.bytes)) as RealtimeEventEnvelope
    ));
  }
}
