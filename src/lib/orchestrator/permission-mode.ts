/** A turn's explicit operator choice. Omission always keeps workspace-scoped Full access. */
export type OrchestratorPermissionMode = 'full' | 'plan' | 'outside-workspace';

export function isOrchestratorPermissionMode(value: unknown): value is OrchestratorPermissionMode {
  return value === 'full' || value === 'plan' || value === 'outside-workspace';
}

export function supportsOutsideWorkspace(backend: string): boolean {
  return backend === 'pi' || backend === 'o8';
}

export function resolveOrchestratorPermissionMode(value: unknown): OrchestratorPermissionMode {
  if (value === undefined) return 'full';
  if (!isOrchestratorPermissionMode(value)) throw new Error('Choose a valid permission mode.');
  return value;
}

export function assertOrchestratorPermissionMode(backend: string, value: unknown, toolProfile?: string): void {
  const mode = resolveOrchestratorPermissionMode(value);
  if (mode === 'outside-workspace' && (!supportsOutsideWorkspace(backend) || toolProfile === 'propose')) {
    throw new Error('Outside workspace commands require the built-in lead and an editable turn. Choose Full access or Plan only for this runtime.');
  }
}

/** A saved broad grant cannot outlive a later, more restrictive turn. */
export function permissionModeRank(mode: unknown): number {
  return mode === 'outside-workspace' ? 2 : mode === 'full' ? 1 : 0;
}
