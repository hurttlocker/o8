import { randomUUID } from 'node:crypto';
import type {
  AgentRuntime,
  LaunchOptions,
  RuntimeActionResult,
  RuntimeCapabilities,
  RuntimeChangedFile,
  RuntimeId,
  RuntimeSession,
  RuntimeTranscriptEntry,
} from '../types';
import type { GetBranchResponse, LaunchRequest, PollEvent, Transport } from './protocol';

export interface RemoteRuntimeAdapterOptions {
  transport: Transport;
  runtimeId: RuntimeId;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export abstract class RemoteRuntimeAdapter implements AgentRuntime {
  public readonly id: RuntimeId;
  protected readonly transport: Transport;

  abstract readonly displayName: string;
  abstract readonly capabilities: RuntimeCapabilities;

  protected constructor({ transport, runtimeId }: RemoteRuntimeAdapterOptions) {
    this.transport = transport;
    this.id = runtimeId;
  }

  async discoverSessions(): Promise<RuntimeSession[]> {
    // Stub — real discovery lands in #546 Deferred-B
    return [];
  }

  abstract readTranscript(
    sessionKey: string,
    sinceId?: string,
    limit?: number,
  ): Promise<RuntimeTranscriptEntry[]>;

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    try {
      const request = await this.buildLaunchRequest(opts, this.createRunId());
      const response = await this.transport.sendLaunch(request);

      return {
        ok: response.accepted,
        note: response.accepted
          ? `Remote run accepted by worker ${response.workerId}.`
          : response.workerId
            ? `Remote run was not accepted by worker ${response.workerId}.`
            : 'Remote run was not accepted by the remote worker transport.',
        sessionKey: response.accepted ? this.toSessionKey(request.runId) : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        note: formatError(error),
      };
    }
  }

  abstract resume(sessionKey: string, message: string): Promise<RuntimeActionResult>;

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    try {
      await this.transport.interrupt(this.runIdFromSessionKey(sessionKey));
      return {
        ok: true,
        note: 'Interrupt requested for remote run.',
        sessionKey,
      };
    } catch (error) {
      return {
        ok: false,
        note: formatError(error),
        sessionKey,
      };
    }
  }

  abstract getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]>;

  protected createRunId() {
    return randomUUID();
  }

  protected toSessionKey(runId: string) {
    return `${this.id}:${runId}`;
  }

  protected runIdFromSessionKey(sessionKey: string) {
    const prefix = `${this.id}:`;
    return sessionKey.startsWith(prefix)
      ? sessionKey.slice(prefix.length)
      : sessionKey;
  }

  protected pollStatus(sessionKey: string): Promise<PollEvent[]> {
    return this.transport.pollStatus(this.runIdFromSessionKey(sessionKey));
  }

  protected getBranch(sessionKey: string): Promise<GetBranchResponse> {
    return this.transport.getBranch(this.runIdFromSessionKey(sessionKey));
  }

  protected abstract buildLaunchRequest(
    opts: LaunchOptions,
    runId: string,
  ): Promise<LaunchRequest> | LaunchRequest;
}
