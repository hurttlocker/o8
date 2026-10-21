export type DeviceTool = 'hub' | 'agent';
export type DevicePhase = 'idle' | 'installing' | 'starting' | 'running' | 'error';

export interface DeviceState {
  phase: DevicePhase;
  error?: string;
  stage?: string;
  tools: Record<DeviceTool, { installed: boolean; version: string | null; requiredVersion: string }>;
  platforms: Record<'ios' | 'android', { available: boolean; detail: string }>;
  embedUrl?: string;
  agentCommand?: string[];
  devices?: Array<{ id: string; name: string; platform: 'ios' | 'android'; state: string; version?: string }>;
}

export class DeviceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 500) { super(message); }
}
