export interface LegacyEvent {
  repositoryId: string;
  eventId: string;
  payload: string;
}

export interface MigratedEvent extends LegacyEvent {
  migratedFrom: 'legacy';
}

export interface MigrationStore {
  listLegacyEvents(): Promise<LegacyEvent[]>;
  appendEvent(event: MigratedEvent): Promise<void>;
}
