export interface CompletionEvent {
  repositoryId: string;
  eventId: string;
  attempt: number;
  payload: string;
}

export interface LedgerEntry extends CompletionEvent {
  recordedAt: number;
}

export class CompletionLedger {
  private readonly entries: LedgerEntry[] = [];

  record(event: CompletionEvent): LedgerEntry {
    const existing = this.entries.find((entry) =>
      entry.repositoryId === event.repositoryId
      && entry.eventId === event.eventId,
    );
    if (existing) return existing;

    const entry = { ...event, recordedAt: Date.now() };
    this.entries.push(entry);
    return entry;
  }

  list(repositoryId: string): LedgerEntry[] {
    return this.entries.filter((entry) => entry.repositoryId === repositoryId);
  }
}
