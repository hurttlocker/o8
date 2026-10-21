export interface SymonMachineIdentity {
  id: 'local' | 'macbook';
  displayName: string;
}

export const DEFAULT_SYMON_MACHINE: SymonMachineIdentity = {
  id: 'local',
  displayName: 'This computer',
};

export const SYMON_MACHINES: readonly SymonMachineIdentity[] = [
  DEFAULT_SYMON_MACHINE,
  { id: 'macbook', displayName: 'MacBook' },
];

export function parseSymonMachineIdentity(value: unknown): SymonMachineIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // Older native bridges and saved sessions still use the previous local label.
  if (record.id === 'local' && record.displayName === 'This Mac') return DEFAULT_SYMON_MACHINE;
  return SYMON_MACHINES.find(
    (machine) => machine.id === record.id && machine.displayName === record.displayName,
  ) ?? null;
}
