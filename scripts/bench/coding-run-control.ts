import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RequireApproval } from '../../src/lib/operator/defaults';

export const BACKEND_ABORT_REASON =
  'o8 backend unreachable; run aborted, results are not a product measurement';
export const BACKEND_PROBE_MAX_ATTEMPTS = 5;
export const BACKEND_PROBE_TIMEOUT_MS = 15_000;
const BACKEND_PROBE_INITIAL_BACKOFF_MS = 1_000;

export type BackendProbeAttemptOutcome =
  | 'healthy'
  | 'connection-refused'
  | 'timeout'
  | 'io-error'
  | 'network-error'
  | 'http-error'
  | 'invalid-response';

export interface BackendProbeAttemptReceipt {
  attempt: number;
  outcome: BackendProbeAttemptOutcome;
  errorCode: string | null;
  detail: string | null;
  elapsedMs: number;
}

export interface BenchmarkRunControlReceipt {
  status: 'running' | 'completed' | 'infrastructure-aborted';
  completedArms: number;
  abortReason: string | null;
  backendDetail: string | null;
  backendProbe: BackendProbeResult | null;
}

export interface BackendProbeResult {
  reachable: boolean;
  detail: string | null;
  attemptsMade: number;
  finalErrorCode: string | null;
  totalElapsedMs: number;
  attempts: BackendProbeAttemptReceipt[];
}

type FetchImplementation = typeof fetch;

interface BackendRequestOptions {
  dataDir?: string;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
}

interface BackendProbeOptions extends BackendRequestOptions {
  maxAttempts?: number;
  initialBackoffMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

interface ErrorRecord {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
}

const TIMEOUT_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
]);

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
  } catch (error) {
    throw Object.assign(new Error('api-port could not be read'), { cause: error });
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`api-port did not contain a valid TCP port: ${JSON.stringify(rawPort)}`);
  }
  try {
    token = fs.readFileSync(path.join(root, 'ws-token'), 'utf8').trim();
  } catch (error) {
    throw Object.assign(new Error('ws-token could not be read'), { cause: error });
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

function asErrorRecord(value: unknown): ErrorRecord | null {
  return value && typeof value === 'object' ? value as ErrorRecord : null;
}

function boundedErrorText(value: unknown, maxLength = 300): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function probeTransportFailure(error: unknown): {
  outcome: Exclude<BackendProbeAttemptOutcome, 'healthy' | 'http-error' | 'invalid-response'>;
  errorCode: string | null;
  detail: string;
} {
  const record = asErrorRecord(error);
  const cause = asErrorRecord(record?.cause);
  const codeValue = cause?.code ?? record?.code;
  const code = typeof codeValue === 'string' ? codeValue : null;
  const name = typeof record?.name === 'string' ? record.name : '';
  const message = boundedErrorText(error);
  const causeMessage = cause ? boundedErrorText(cause) : '';
  const diagnosticMessage = message === 'fetch failed' && causeMessage && causeMessage !== message
    ? `${message}; cause=${causeMessage}`
    : message;
  let outcome: 'connection-refused' | 'timeout' | 'io-error' | 'network-error';
  if (code === 'ECONNREFUSED' || /\bECONNREFUSED\b/i.test(diagnosticMessage)) {
    outcome = 'connection-refused';
  } else if ((code !== null && TIMEOUT_ERROR_CODES.has(code))
    || name === 'TimeoutError'
    || name === 'AbortError') {
    outcome = 'timeout';
  } else if (code !== null) {
    outcome = 'io-error';
  } else {
    outcome = 'network-error';
  }
  const errorCode = code ?? (outcome === 'timeout' && name ? name : null);
  const codeLabel = errorCode ? ` (${errorCode})` : '';
  return { outcome, errorCode, detail: `${outcome}${codeLabel}: ${diagnosticMessage}` };
}

function probeResult(
  attempts: BackendProbeAttemptReceipt[],
  totalElapsedMs: number,
): BackendProbeResult {
  const finalAttempt = attempts.at(-1);
  if (!finalAttempt) throw new Error('backend probe completed without an attempt');
  return {
    reachable: finalAttempt.outcome === 'healthy',
    detail: finalAttempt.detail,
    attemptsMade: attempts.length,
    finalErrorCode: finalAttempt.errorCode,
    totalElapsedMs,
    attempts,
  };
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, delayMs); });
}

export async function probeO8Backend(options: BackendProbeOptions = {}): Promise<BackendProbeResult> {
  const maxAttempts = options.maxAttempts ?? BACKEND_PROBE_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > BACKEND_PROBE_MAX_ATTEMPTS) {
    throw new Error(`backend probe maxAttempts must be between 1 and ${BACKEND_PROBE_MAX_ATTEMPTS}`);
  }
  const initialBackoffMs = options.initialBackoffMs ?? BACKEND_PROBE_INITIAL_BACKOFF_MS;
  if (!Number.isFinite(initialBackoffMs) || initialBackoffMs < 0) {
    throw new Error('backend probe initialBackoffMs must be a non-negative number');
  }
  const wait = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const attempts: BackendProbeAttemptReceipt[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = now();
    let receipt: BackendProbeAttemptReceipt;
    try {
      const response = await backendRequest('/api/panel/status', { method: 'GET', cache: 'no-store' }, {
        ...options,
        timeoutMs: options.timeoutMs ?? BACKEND_PROBE_TIMEOUT_MS,
      });
      if (!response.ok) {
        const errorCode = `HTTP_${response.status}`;
        receipt = {
          attempt,
          outcome: 'http-error',
          errorCode,
          detail: `http-error (${errorCode}): status probe returned HTTP ${response.status}`,
          elapsedMs: Math.max(0, now() - attemptStartedAt),
        };
      } else {
        let payload: { product?: unknown };
        try {
          payload = await response.json() as { product?: unknown };
        } catch (error) {
          receipt = {
            attempt,
            outcome: 'invalid-response',
            errorCode: 'INVALID_JSON',
            detail: `invalid-response (INVALID_JSON): ${boundedErrorText(error)}`,
            elapsedMs: Math.max(0, now() - attemptStartedAt),
          };
          attempts.push(receipt);
          if (attempt < maxAttempts) {
            await wait(initialBackoffMs * (2 ** (attempt - 1)));
            continue;
          }
          return probeResult(attempts, Math.max(0, now() - startedAt));
        }
        receipt = payload.product === 'o8'
          ? {
              attempt,
              outcome: 'healthy',
              errorCode: null,
              detail: null,
              elapsedMs: Math.max(0, now() - attemptStartedAt),
            }
          : {
              attempt,
              outcome: 'invalid-response',
              errorCode: 'INVALID_PRODUCT',
              detail: 'invalid-response (INVALID_PRODUCT): status probe did not identify the o8 backend',
              elapsedMs: Math.max(0, now() - attemptStartedAt),
            };
      }
    } catch (error) {
      const failure = probeTransportFailure(error);
      receipt = {
        attempt,
        ...failure,
        elapsedMs: Math.max(0, now() - attemptStartedAt),
      };
    }
    attempts.push(receipt);
    if (receipt.outcome === 'healthy' || attempt === maxAttempts) {
      return probeResult(attempts, Math.max(0, now() - startedAt));
    }
    await wait(initialBackoffMs * (2 ** (attempt - 1)));
  }

  throw new Error('backend probe retry loop exited unexpectedly');
}

export class O8BackendAbortError extends Error {
  readonly completedArms: number;
  readonly backendDetail: string | null;
  readonly backendProbe: BackendProbeResult;

  constructor(completedArms: number, backendProbe: BackendProbeResult) {
    super(
      `${BACKEND_ABORT_REASON}; arms completed before abort=${completedArms}; ` +
      `probe=${backendProbe.detail ?? 'no failure detail'}`,
    );
    this.name = 'O8BackendAbortError';
    this.completedArms = completedArms;
    this.backendDetail = backendProbe.detail;
    this.backendProbe = backendProbe;
  }
}

export function runningRunControl(
  completedArms = 0,
  backendProbe: BackendProbeResult | null = null,
): BenchmarkRunControlReceipt {
  return {
    status: 'running',
    completedArms,
    abortReason: null,
    backendDetail: null,
    backendProbe,
  };
}

export function abortedRunControl(error: O8BackendAbortError): BenchmarkRunControlReceipt {
  return {
    status: 'infrastructure-aborted',
    completedArms: error.completedArms,
    abortReason: BACKEND_ABORT_REASON,
    backendDetail: error.backendDetail,
    backendProbe: error.backendProbe,
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
  let lastProbe: BackendProbeResult | null = null;
  const probe = input.probe ?? (() => probeO8Backend());
  input.onRunControl(runningRunControl(completedArms));

  const assertBackendLive = async (): Promise<void> => {
    const result = await probe();
    lastProbe = result;
    if (result.reachable) {
      input.onRunControl(runningRunControl(completedArms, result));
      return;
    }
    const error = new O8BackendAbortError(completedArms, result);
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
    input.onRunControl(runningRunControl(completedArms, lastProbe));
    await assertBackendLive();
  }

  input.onRunControl({
    status: 'completed',
    completedArms,
    abortReason: null,
    backendDetail: null,
    backendProbe: lastProbe,
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
  if (!initialProbe.reachable) throw new O8BackendAbortError(0, initialProbe);
  let original: RequireApproval;
  try {
    original = await readRequireApprovalFromApi(options);
  } catch (error) {
    const probe = await probeO8Backend(options);
    if (!probe.reachable) throw new O8BackendAbortError(0, probe);
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
      operationError = new O8BackendAbortError(0, probe);
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
