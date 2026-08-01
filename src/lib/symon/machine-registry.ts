export interface SymonMachineIdentity {
  id: 'local' | 'macbook';
  displayName: string;
}

export const DEFAULT_SYMON_MACHINE: SymonMachineIdentity = {
  id: 'local',
  displayName: 'This Mac',
};

export const SYMON_MACHINES: readonly SymonMachineIdentity[] = [
  DEFAULT_SYMON_MACHINE,
  { id: 'macbook', displayName: 'MacBook' },
];

export function parseSymonMachineIdentity(value: unknown): SymonMachineIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return SYMON_MACHINES.find(
    (machine) => machine.id === record.id && machine.displayName === record.displayName,
  ) ?? null;
}
