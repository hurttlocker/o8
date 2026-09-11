import { randomBytes } from 'node:crypto';

// One namespace per harness process, shared by stack startup, oracle queries,
// and cleanup. Never inspect or mutate the operator's dashboard/default server.
export const BENCH_TMUX_SERVER_NAME = `o8-bench-${process.pid}-${randomBytes(6).toString('hex')}`;

export function benchTmuxArgs(...args) {
  return ['-L', BENCH_TMUX_SERVER_NAME, ...args];
}
