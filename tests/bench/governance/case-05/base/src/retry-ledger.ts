export interface RetryEvent {
  repositoryId: string;
  eventId: string;
  payload: string;
}

export interface RetryEntry extends RetryEvent {
  recordedAt: number;
}

export class RetryLedger {
  private readonly entries: RetryEntry[] = [];

  record(event: RetryEvent): RetryEntry {
    const existing = this.entries.find((entry) =>
      entry.repositoryId === event.repositoryId
      && entry.eventId === event.eventId,
    );
    if (existing) return existing;

    const entry = { ...event, recordedAt: Date.now() };
    this.entries.push(entry);
    return entry;
  }
}
