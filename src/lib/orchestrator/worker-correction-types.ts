export type WorkerCorrectionMode = 'send' | 'pause-and-send' | 'stop';
export interface WorkerCorrectionPayload {
  message: string;
  mode: WorkerCorrectionMode;
  holdMerges: boolean;
  targets: Array<{ surfaceId: string; runId: string }>;
}
export interface WorkerCorrectionReceipt {
  id: string; repoPath: string; threadId: string; payload: WorkerCorrectionPayload;
  ruleId: string | null; createdAt: number;
  deliveries: Array<{ surfaceId: string; runId: string;
    status: 'pending' | 'sending' | 'delivered' | 'stopped' | 'unavailable' | 'unknown' | 'held'; note: string }>;
}
export interface CorrectableWorker { surfaceId: string; runId: string; runtime: string; taskName: string; running: boolean }
