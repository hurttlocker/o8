/** Both native surfaces see direct delivery plus broadcast duplicates. Fence
 * session-tagged frames and remember completion until the next explicit start. */
export class SystemDictationSession {
  private active = false;
  private id: number | null = null;
  private retired = 0;
  private startId: string | null = null;

  accepts(event: { type?: string; sessionId?: number; startId?: string }): boolean {
    if (event.type === 'system-start') {
      if (event.startId && event.startId === this.startId) return false;
      this.startId = event.startId ?? null;
      if (this.id !== null) this.retired = Math.max(this.retired, this.id);
      this.id = event.sessionId ?? null;
      this.active = true;
      return true;
    }
    if (!this.active) return false;
    if (typeof event.sessionId === 'number') {
      if (this.id === null) {
        if (event.sessionId <= this.retired) return false;
        this.id = event.sessionId;
      } else if (event.sessionId !== this.id) return false;
    }
    return true;
  }

  finish(): void {
    if (this.id !== null) this.retired = Math.max(this.retired, this.id);
    this.active = false;
    this.id = null;
  }
}
