import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RequireApproval } from '../../src/lib/operator/defaults';

export const BACKEND_ABORT_REASON =
  'o8 backend unreachable; run aborted, results are not a product measurement';

export interface BenchmarkRunControlReceipt {
  status: 'running' | 'completed' | 'infrastructure-aborted';
  completedArms: number;
  abortReason: string | null;
  backendDetail: string | null;
}

export interface BackendProbeResult {
  reachable: boolean;
  detail: string | null;
}

type FetchImplementation = typeof fetch;

interface BackendRequestOptions {
  dataDir?: string;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
}

interface OperatorDefaultsPayload {
  values?: {
    requireApproval?: unknown;
  };
}

function dataDir(override?: string): string {
  return override
    ?? process.env.CORTEX_IDE_DATA_DIR
    ?? path.join(os.homedir(), '.o8');
}

function backendConnection(override?: string): { baseUrl: string; token: string } {
  const root = dataDir(override);
  let rawPort: string;
  let token: string;
  try {
    rawPort = fs.readFileSync(path.join(root, 'api-port'), 'utf8').trim();
  } catch {
    throw new Error('api-port could not be read');
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`api-port did not contain a valid TCP port: ${JSON.stringify(rawPort)}`);
  }
  try {
    token = fs.readFileSync(path.join(root, 'ws-token'), 'utf8').trim();
  } catch {
    throw new Error('ws-token could not be read');
  }
  if (!token) throw new Error('ws-token was empty');
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

async function backendRequest(
  pathname: string,
  init: RequestInit,
  options: BackendRequestOptions = {},
): Promise<Response> {
  const { baseUrl, token } = backendConnection(options.dataDir);
  const timeoutMs = options.timeoutMs ?? 5_000;
  return (options.fetchImpl ?? fetch)(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function isRequireApproval(value: unknown): value is RequireApproval {
  return value === 'high-risk' || value === 'surface' || value === 'always' || value === 'never';
}

async function readRequireApprovalFromApi(options: BackendRequestOptions = {}): Promise<RequireApproval> {
  const response = await backendRequest('/api/panel/operator-defaults', { method: 'GET' }, options);
  if (!response.ok) throw new Error(`operator-defaults GET returned HTTP ${response.status}`);
  const payload = await response.json() as OperatorDefaultsPayload;
  const value = payload.values?.requireApproval;
  if (!isRequireApproval(value)) throw new Error('operator-defaults GET omitted requireApproval');
  return value;
}

async function setRequireApprovalViaApi(
  value: RequireApproval,
  options: BackendRequestOptions = {},
): Promise<void> {
  const response = await backendRequest('/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requireApproval: value }),
  }, options);
  if (!response.ok) throw new Error(`operator-defaults POST returned HTTP ${response.status}`);
  const payload = await response.json() as OperatorDefaultsPayload;
  if (payload.values?.requireApproval !== value) {
    throw new Error(`operator-defaults POST did not return requireApproval=${value}`);
  }
}

export async function probeO8Backend(options: BackendRequestOptions = {}): Promise<BackendProbeResult> {
  try {
    const response = await backendRequest('/api/panel/status', { method: 'GET' }, options);
    if (!response.ok) return { reachable: false, detail: `status probe returned HTTP ${response.status}` };
    const payload = await response.json() as { product?: unknown };
    if (payload.product !== 'o8') {
      return { reachable: false, detail: 'status probe did not identify the o8 backend' };
    }
    return { reachable: true, detail: null };
  } catch (error) {
    return {
      reachable: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export class O8BackendAbortError extends Error {
  readonly completedArms: number;
  readonly backendDetail: string | null;

  constructor(completedArms: number, backendDetail: string | null) {
    super(`${BACKEND_ABORT_REASON}; arms completed before abort=${completedArms}`);
    this.name = 'O8BackendAbortError';
    this.completedArms = completedArms;
    this.backendDetail = backendDetail;
  }
}

export function runningRunControl(completedArms = 0): BenchmarkRunControlReceipt {
  return {
    status: 'running',
    completedArms,
    abortReason: null,
    backendDetail: null,
  };
}

export function abortedRunControl(error: O8BackendAbortError): BenchmarkRunControlReceipt {
  return {
    status: 'infrastructure-aborted',
    completedArms: error.completedArms,
    abortReason: BACKEND_ABORT_REASON,
    backendDetail: error.backendDetail,
  };
}

export async function runBackendGuardedCollection<TInput, TArm>(input: {
  arms: TInput[];
  initialCompletedArms?: number;
  probe?: () => Promise<BackendProbeResult>;
  runArm: (arm: TInput) => Promise<TArm> | TArm;
  commitArm: (arm: TArm) => void;
  onRunControl: (receipt: BenchmarkRunControlReceipt) => void;
}): Promise<number> {
  let completedArms = input.initialCompletedArms ?? 0;
  const probe = input.probe ?? (() => probeO8Backend());
  input.onRunControl(runningRunControl(completedArms));

  const assertBackendLive = async (): Promise<void> => {
    const result = await probe();
    if (result.reachable) return;
    const error = new O8BackendAbortError(completedArms, result.detail);
    input.onRunControl(abortedRunControl(error));
    console.error(`[coding] ${error.message}`);
    throw error;
  };

  await assertBackendLive();
  for (const pendingArm of input.arms) {
    let arm: TArm;
    try {
      arm = await input.runArm(pendingArm);
    } catch (error) {
      await assertBackendLive();
      throw error;
    }
    // The arm owns terminal classification and durable reconciliation. Persist
    // that result before the boundary probe so a dead API cannot erase work that
    // the lane database and packet worktree prove completed.
    input.commitArm(arm);
    completedArms += 1;
    input.onRunControl(runningRunControl(completedArms));
    await assertBackendLive();
  }

  input.onRunControl({
    status: 'completed',
    completedArms,
    abortReason: null,
    backendDetail: null,
  });
  return completedArms;
}

function readDefaultsFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('operator-defaults.json did not contain an object');
  }
  return parsed as Record<string, unknown>;
}

function writeRequireApprovalDirect(value: RequireApproval, override?: string): void {
  const root = dataDir(override);
  const filePath = path.join(root, 'operator-defaults.json');
  const current = readDefaultsFile(filePath);
  fs.mkdirSync(root, { recursive: true });
  const temporaryPath = path.join(root, `.operator-defaults.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ ...current, requireApproval: value }, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

function verifyDirectRestore(value: RequireApproval, override?: string): boolean {
  try {
    const filePath = path.join(dataDir(override), 'operator-defaults.json');
    return readDefaultsFile(filePath).requireApproval === value;
  } catch {
    return false;
  }
}

function printRestoreInstruction(value: RequireApproval): void {
  console.error(
    `[coding] RESTORE FAILED: requireApproval must be returned to ${JSON.stringify(value)} immediately. ` +
    `Set requireApproval=${JSON.stringify(value)} in o8 Settings before continuing.`,
  );
}

export async function restoreRequireApproval(
  value: RequireApproval,
  options: BackendRequestOptions = {},
): Promise<{ restored: boolean; method: 'api' | 'file' | 'failed' }> {
  try {
    await setRequireApprovalViaApi(value, options);
    if (await readRequireApprovalFromApi(options) === value) {
      return { restored: true, method: 'api' };
    }
  } catch {
    // The running app persists its in-memory defaults on quit and can overwrite
    // a direct file write, so the API is preferred whenever the backend exists.
  }

  try {
    writeRequireApprovalDirect(value, options.dataDir);
    if (verifyDirectRestore(value, options.dataDir)) {
      return { restored: true, method: 'file' };
    }
  } catch {
    // The explicit operator instruction below is the final recovery path.
  }

  printRestoreInstruction(value);
  return { restored: false, method: 'failed' };
}

export async function withTemporaryRequireApproval<T>(
  work: () => Promise<T>,
  options: BackendRequestOptions = {},
): Promise<T> {
  const initialProbe = await probeO8Backend(options);
  if (!initialProbe.reachable) throw new O8BackendAbortError(0, initialProbe.detail);
  let original: RequireApproval;
  try {
    original = await readRequireApprovalFromApi(options);
  } catch (error) {
    const probe = await probeO8Backend(options);
    if (!probe.reachable) throw new O8BackendAbortError(0, probe.detail);
    throw error;
  }
  if (original === 'always') return work();

  let operationError: unknown;
  try {
    await setRequireApprovalViaApi('always', options);
    if (await readRequireApprovalFromApi(options) !== 'always') {
      throw new Error('benchmark could not verify requireApproval="always" before collection');
    }
    return await work();
  } catch (error) {
    operationError = error;
    const probe = await probeO8Backend(options);
    if (!probe.reachable && !(error instanceof O8BackendAbortError)) {
      operationError = new O8BackendAbortError(0, probe.detail);
      throw operationError;
    }
    throw error;
  } finally {
    const restore = await restoreRequireApproval(original, options);
    if (!restore.restored && operationError === undefined) {
      throw new Error(`benchmark could not restore requireApproval=${JSON.stringify(original)}`);
    }
  }
}
