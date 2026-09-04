export interface FixturePageServer {
  port: number;
  url: string;
  digest: string;
  targetBlockId: string;
  blockCount: number;
  pid: number;
  close: () => Promise<void>;
}

export function startFixturePageServer(seed: number, options: { runTag: string }): Promise<FixturePageServer>;
