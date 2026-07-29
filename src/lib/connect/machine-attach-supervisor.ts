import 'server-only';

import { readConnectAttachSetting } from '@/lib/connect/attach-settings';
import {
  issueMachineRelayTicket,
  listMachines,
  type MachineDevice,
} from '@/lib/connect/machine-registry';
import { getOrCreateInstallId } from '@/lib/entitlement/bootstrap';
import { readCachedEntitlement } from '@/lib/entitlement/license';

import {
  MachineRelayConnector,
  type MachineRelayConnectorConfig,
} from './machine-attach';

const P = '[connect]';
const DEFAULT_RECONCILE_INTERVAL_MS = 2_000;

interface ConnectorHandle {
  start(): void;
  stop(reason?: string): void;
}

export interface MachineAttachSupervisorConfig {
  reconcileIntervalMs?: number;
  readEnabled?: () => boolean;
  readCredential?: () => string | null;
  readInstallId?: () => string;
  listRegisteredMachines?: (token: string) => Promise<MachineDevice[]>;
  createConnector?: (
    machine: MachineDevice,
    token: string,
  ) => ConnectorHandle;
}

/**
 * Reconciles local operator intent, sign-in state, and machine registration.
 * It runs even while OFF so a setting change can attach without restarting the
 * desktop server, but the default OFF state never opens a relay socket.
 */
export class MachineAttachSupervisor {
  private connector: ConnectorHandle | null = null;
  private connectorCredential: string | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;
  private stopped = true;
  private lastIdleReason: string | null = null;

  constructor(private readonly config: MachineAttachSupervisorConfig = {}) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.reconcile();
    const intervalMs = positiveInteger(
      this.config.reconcileIntervalMs,
      DEFAULT_RECONCILE_INTERVAL_MS,
    );
    this.interval = setInterval(() => void this.reconcile(), intervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.stopConnector('desktop-shutdown');
  }

  async reconcile(): Promise<void> {
    if (this.stopped || this.reconciling) return;
    this.reconciling = true;
    try {
      const enabled = this.config.readEnabled?.()
        ?? readConnectAttachSetting().enabled;
      if (!enabled) {
        this.stopConnector('operator-disabled');
        this.noteIdle('disabled');
        return;
      }

      const token = this.config.readCredential?.()
        ?? readCachedEntitlement()?.licenseKey?.trim()
        ?? null;
      if (!token) {
        this.stopConnector('signed-out');
        this.noteIdle('signed-out');
        return;
      }
      if (this.connector && this.connectorCredential === token) return;
      this.stopConnector('credential-changed');

      const machines = await (
        this.config.listRegisteredMachines?.(token)
        ?? listRegisteredMachines(token)
      );
      if (this.stopped) return;
      const installId = this.config.readInstallId?.() ?? getOrCreateInstallId();
      const machine = machines.find((entry) => entry.installId === installId);
      if (!machine) {
        this.noteIdle('not-registered');
        return;
      }

      const connector = this.config.createConnector?.(machine, token)
        ?? createMachineConnector(machine, token);
      this.connector = connector;
      this.connectorCredential = token;
      this.lastIdleReason = null;
      connector.start();
    } catch (error) {
      this.noteIdle(`reconcile-failed:${errorMessage(error)}`);
    } finally {
      this.reconciling = false;
    }
  }

  private stopConnector(reason: string): void {
    this.connector?.stop(reason);
    this.connector = null;
    this.connectorCredential = null;
  }

  private noteIdle(reason: string): void {
    if (this.lastIdleReason === reason) return;
    this.lastIdleReason = reason;
    console.log(`${P} attach idle reason=${reason}`);
  }
}

async function listRegisteredMachines(token: string): Promise<MachineDevice[]> {
  const result = await listMachines({ token });
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

function createMachineConnector(
  machine: MachineDevice,
  token: string,
  overrides: Partial<MachineRelayConnectorConfig> = {},
): MachineRelayConnector {
  return new MachineRelayConnector({
    machineId: machine.machineId,
    ticketProvider: async () => {
      const result = await issueMachineRelayTicket(machine.machineId, { token });
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    },
    ...overrides,
  });
}

let activeSupervisor: MachineAttachSupervisor | null = null;

export function startMachineAttachSupervisor(): MachineAttachSupervisor {
  if (activeSupervisor) return activeSupervisor;
  const supervisor = new MachineAttachSupervisor();
  supervisor.start();
  activeSupervisor = supervisor;
  return supervisor;
}

export function stopMachineAttachSupervisor(): void {
  activeSupervisor?.stop();
  activeSupervisor = null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
