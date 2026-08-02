export interface Partition<T> {
  partition: number;
  records: T[];
}

export function allRecords<T>(records: T[]): Partition<T> {
  return { partition: 0, records: [...records] };
}
