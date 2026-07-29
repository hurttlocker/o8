import { apiFetch, CliError, EXIT, type ExitCode } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';

interface MachineDevice {
  machineId: string;
  installId: string;
  name: string;
  platform: string;
  appVersion: string;
  createdAt?: string;
  lastSeenAt?: string;
}

interface ConnectApiError {
  code?: string;
  status?: number;
  message?: string;
  deviceCap?: number;
  devices?: MachineDevice[];
}

interface ConnectApiResponse {
  ok?: boolean;
  machineId?: string | null;
  deviceCap?: number;
  disconnected?: boolean;
  currentMachineId?: string | null;
  devices?: MachineDevice[];
  error?: ConnectApiError;
  hint?: string | null;
}

type ConnectAction = 'connect' | 'status' | 'disconnect';

function schemaFor(action: ConnectAction): string {
  if (action === 'status') return 'o8/cli/connect-status/v1';
  return `o8/cli/${action}/v1`;
}

function exitFor(code: string): ExitCode {
  if (code === 'auth_required') return EXIT.UNAUTHORIZED;
  if (code === 'unsupported') return EXIT.NOT_FOUND;
  if (code === 'device_cap') return EXIT.CONFLICT;
  if (code === 'network_error') return EXIT.CONNECTION_REFUSED;
  return EXIT.INVALID_ARGS;
}

function deviceLine(device: MachineDevice, currentMachineId?: string | null): string {
  const current = device.machineId === currentMachineId ? ' (this machine)' : '';
  return `  ${device.name} — ${device.platform} — ${device.machineId}${current}\n`;
}

function printFailure(
  mode: OutputMode,
  action: ConnectAction,
  data: ConnectApiResponse,
): ExitCode {
  const code = data.error?.code ?? 'connect_failed';
  const message = data.error?.message ?? 'The o8 machine connection request failed.';
  const hint = data.hint ?? null;
  const payload = {
    schema: schemaFor(action),
    ok: false,
    error: {
      code,
      status: data.error?.status ?? null,
      message,
      deviceCap: data.error?.deviceCap ?? null,
      devices: data.error?.devices ?? [],
    },
    hint,
  };

  if (mode.human) {
    process.stderr.write(`error: ${code}\n`);
    process.stderr.write(`  ${message}\n`);
    if ((data.error?.devices?.length ?? 0) > 0) {
      process.stderr.write('  connected devices:\n');
      for (const device of data.error?.devices ?? []) {
        process.stderr.write(deviceLine(device));
      }
    }
    if (hint) process.stderr.write(`  hint: ${hint}\n`);
  } else {
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
  return exitFor(code);
}

function printDevices(devices: MachineDevice[], currentMachineId?: string | null): void {
  if (devices.length === 0) {
    process.stdout.write('  no connected machines\n');
    return;
  }
  for (const device of devices) process.stdout.write(deviceLine(device, currentMachineId));
}

function validateArgs(action: ConnectAction, rest: string[]): void {
  const allowed = action === 'connect' ? new Set(['--status']) : new Set<string>();
  const unknown = rest.find((argument) => !allowed.has(argument));
  if (unknown) {
    throw new CliError(
      'invalid_args',
      `Unknown ${action} flag: ${unknown}`,
      EXIT.INVALID_ARGS,
      action === 'connect'
        ? 'Run `o8 connect` or `o8 connect --status`.'
        : 'Run `o8 disconnect` without arguments.',
    );
  }
}

export async function runConnect(
  mode: OutputMode,
  command: 'connect' | 'disconnect',
  rest: string[],
): Promise<number> {
  const action: ConnectAction = command === 'connect' && rest.includes('--status')
    ? 'status'
    : command;
  validateArgs(command, rest);

  const method = action === 'status'
    ? 'GET'
    : action === 'disconnect' ? 'DELETE' : 'POST';
  const response = await apiFetch<ConnectApiResponse>(
    resolveConfig(),
    '/api/panel/connect',
    { method },
  );
  const data = response.data;
  if (!data) {
    throw new CliError(
      'invalid_response',
      'The o8 app returned an empty machine connection response.',
      EXIT.INVALID_ARGS,
    );
  }
  if (data.ok !== true) return printFailure(mode, action, data);

  const devices = data.devices ?? [];
  const payload = {
    schema: schemaFor(action),
    ok: true,
    machineId: data.machineId ?? null,
    currentMachineId: data.currentMachineId ?? null,
    disconnected: data.disconnected ?? null,
    deviceCap: data.deviceCap ?? null,
    devices,
  };
  if (mode.human) {
    if (action === 'connect') {
      printHumanHeading('o8 connect');
      printHumanKv([
        ['status', 'connected'],
        ['machine', data.machineId ?? 'unknown'],
        ['device cap', data.deviceCap == null ? 'unknown' : String(data.deviceCap)],
      ]);
      printDevices(devices, data.machineId);
    } else if (action === 'status') {
      printHumanHeading('o8 connect status');
      printHumanKv([
        ['this machine', data.currentMachineId ?? 'not connected'],
        ['connected', String(devices.length)],
      ]);
      printDevices(devices, data.currentMachineId);
    } else {
      printHumanHeading('o8 disconnect');
      printHumanKv([
        ['status', data.disconnected === true ? 'disconnected' : 'not connected'],
        ['machine', data.machineId ?? 'none'],
      ]);
    }
  } else {
    printJson(payload);
  }
  return EXIT.OK;
}
