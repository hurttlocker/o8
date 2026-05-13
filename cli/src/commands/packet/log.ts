import { runPacketReport } from './report.js';
import type { OutputMode } from '../../output.js';

export async function runPacketLog(mode: OutputMode, rest: string[]): Promise<number> {
  return runPacketReport(mode, [...rest, '--event', 'progress']);
}
