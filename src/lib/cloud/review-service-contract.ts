/** Server-created identity for a finite service-only execution. */
export interface RemoteServiceSession {
  taskId: string;
  packetId: string;
  laneId: string;
  parentJobId: string;
  parentAttempt: number;
  expiresAt: string;
}
