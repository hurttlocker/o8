import 'server-only';

import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';

const DEFAULT_TIMEOUT_MS = 10_000;
const UNSUPPORTED_MESSAGE = 'The o8 license server does not support machine registry yet.';

export interface MachineDevice {
  machineId: string;
  installId: string;
  name: string;
  platform: string;
  appVersion: string;
  createdAt?: string;
  lastSeenAt?: string;
}

export interface RegisterMachineInput {
  installId: string;
  name: string;
  platform: string;
  appVersion: string;
}

export interface RegisterMachineResponse {
  machineId: string;
  deviceCap: number;
  devices: MachineDevice[];
}

export interface MachineRelayTicket {
  ticket: string;
  expiresAt: string;
}

export type MachineRegistryErrorCode =
  | 'auth_required'
  | 'device_cap'
  | 'not_registered'
  | 'unsupported'
  | 'invalid_response'
  | 'network_error'
  | 'server_error';

export interface MachineRegistryError {
  code: MachineRegistryErrorCode;
  status: number;
  message: string;
  deviceCap?: number;
  devices?: MachineDevice[];
}

export type MachineRegistryResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: MachineRegistryError };

export interface MachineRegistryClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isMachineDevice(value: unknown): value is MachineDevice {
  const record = asRecord(value);
  return record !== null
    && typeof record.machineId === 'string'
    && typeof record.installId === 'string'
    && typeof record.name === 'string'
    && typeof record.platform === 'string'
    && typeof record.appVersion === 'string';
}

function readDevices(value: unknown): MachineDevice[] | null {
  return Array.isArray(value) && value.every(isMachineDevice)
    ? value
    : null;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  const record = asRecord(payload);
  if (!record) return fallback;
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  if (typeof record.error === 'string' && record.error.trim()) return record.error.trim();
  const error = asRecord(record.error);
  return typeof error?.message === 'string' && error.message.trim()
    ? error.message.trim()
    : fallback;
}

async function request(
  path: string,
  init: RequestInit,
  options: MachineRegistryClientOptions,
  behavior: { unsupportedOnNotFound?: boolean } = {},
): Promise<{ response: Response; payload: unknown } | MachineRegistryResult<never>> {
  const token = options.token.trim();
  if (!token) {
    return {
      ok: false,
      error: {
        code: 'auth_required',
        status: 401,
        message: 'Sign in to o8 before connecting this machine.',
      },
    };
  }

  const baseUrl = (options.baseUrl ?? proxyBaseUrl()).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await readJson(response);
    if (
      response.status === 501
      || (response.status === 404 && behavior.unsupportedOnNotFound !== false)
    ) {
      return {
        ok: false,
        error: {
          code: 'unsupported',
          status: response.status,
          message: UNSUPPORTED_MESSAGE,
        },
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error: {
          code: 'auth_required',
          status: response.status,
          message: 'The machine registry rejected the current o8 account credential.',
        },
      };
    }
    return { response, payload };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'network_error',
        status: 0,
        message: `Could not reach the o8 machine registry: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

function genericFailure(response: Response, payload: unknown): MachineRegistryResult<never> {
  return {
    ok: false,
    error: {
      code: 'server_error',
      status: response.status,
      message: errorMessage(payload, `The machine registry returned HTTP ${response.status}.`),
    },
  };
}

export async function registerMachine(
  input: RegisterMachineInput,
  options: MachineRegistryClientOptions,
): Promise<MachineRegistryResult<RegisterMachineResponse>> {
  const result = await request('/machines/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }, options);
  if ('ok' in result) return result;

  const { response, payload } = result;
  const record = asRecord(payload);
  if (response.status === 409 && record?.reason === 'device_cap') {
    const devices = readDevices(record.devices) ?? [];
    const deviceCap = typeof record.deviceCap === 'number' && Number.isInteger(record.deviceCap)
      ? record.deviceCap
      : 3;
    return {
      ok: false,
      error: {
        code: 'device_cap',
        status: response.status,
        message: `Free accounts can connect up to ${deviceCap} devices.`,
        deviceCap,
        devices,
      },
    };
  }
  if (!response.ok) return genericFailure(response, payload);

  const devices = readDevices(record?.devices);
  if (
    !record
    || typeof record.machineId !== 'string'
    || typeof record.deviceCap !== 'number'
    || !devices
  ) {
    return {
      ok: false,
      error: {
        code: 'invalid_response',
        status: response.status,
        message: 'The machine registry returned an invalid registration response.',
      },
    };
  }
  return {
    ok: true,
    data: {
      machineId: record.machineId,
      deviceCap: record.deviceCap,
      devices,
    },
  };
}

export async function listMachines(
  options: MachineRegistryClientOptions,
): Promise<MachineRegistryResult<MachineDevice[]>> {
  const result = await request('/machines', { method: 'GET' }, options);
  if ('ok' in result) return result;
  if (!result.response.ok) return genericFailure(result.response, result.payload);

  const devices = readDevices(result.payload);
  if (!devices) {
    return {
      ok: false,
      error: {
        code: 'invalid_response',
        status: result.response.status,
        message: 'The machine registry returned an invalid device list.',
      },
    };
  }
  return { ok: true, data: devices };
}

export async function deleteMachine(
  machineId: string,
  options: MachineRegistryClientOptions,
): Promise<MachineRegistryResult<null>> {
  const result = await request(
    `/machines/${encodeURIComponent(machineId)}`,
    { method: 'DELETE' },
    options,
  );
  if ('ok' in result) return result;
  if (!result.response.ok) return genericFailure(result.response, result.payload);
  return { ok: true, data: null };
}

export async function issueMachineRelayTicket(
  machineId: string,
  options: MachineRegistryClientOptions,
): Promise<MachineRegistryResult<MachineRelayTicket>> {
  const result = await request(
    `/machines/${encodeURIComponent(machineId)}/relay-ticket`,
    { method: 'POST' },
    options,
    { unsupportedOnNotFound: false },
  );
  if ('ok' in result) return result;
  if (result.response.status === 404) {
    return {
      ok: false,
      error: {
        code: 'not_registered',
        status: 404,
        message: 'This o8 installation is not registered as a connected machine.',
      },
    };
  }
  if (!result.response.ok) return genericFailure(result.response, result.payload);

  const record = asRecord(result.payload);
  if (
    !record
    || typeof record.ticket !== 'string'
    || !record.ticket.trim()
    || typeof record.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(record.expiresAt))
  ) {
    return {
      ok: false,
      error: {
        code: 'invalid_response',
        status: result.response.status,
        message: 'The machine registry returned an invalid relay ticket response.',
      },
    };
  }
  return {
    ok: true,
    data: {
      ticket: record.ticket,
      expiresAt: record.expiresAt,
    },
  };
}
