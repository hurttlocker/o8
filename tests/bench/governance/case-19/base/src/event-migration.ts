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
  hasCompletedMigration(name: string): Promise<boolean>;
  upsertEvent(event: MigratedEvent): Promise<void>;
  markMigrationComplete(name: string): Promise<void>;
}
