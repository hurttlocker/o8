export interface FixtureRepoPlan {
  name: string;
  defaultBranch: string;
  lastOpenedOffsetMinutes: number;
}

export interface FixtureTabPlan {
  id: string;
  label: string;
  kind: string;
  cliAgent?: string;
  orchestratorThreadId?: string;
  mode?: string;
  canvasTab?: { id: string; kind: string; label: string; resourceId: string };
}

export interface DesignFixturePage {
  html: string;
  blocks: Array<{ id: string; hue: number; height: number }>;
  digest: string;
  targetBlockId: string;
}

export interface FixturePlan {
  scale: number;
  seed: number;
  repos: FixtureRepoPlan[];
  tabs: FixtureTabPlan[];
}

export interface MaterializedFixture {
  dataDir: string;
  repoDir: string;
  reposRoot: string;
  project: { id: string; name: string };
  tabs: FixtureTabPlan[];
  repoNames: string[];
  repoCount: number;
  digest: string;
}

export const DEFAULT_FIXTURE_SEED: number;
export const FIXTURE_SCALES: readonly number[];
export const QUICK_FIXTURE_SCALES: readonly number[];
export const FIXTURE_REPO_PREFIX: string;

export function createRandom(seed: number): () => number;
export function fixtureRepoName(index: number): string;
export function buildFixturePlan(scale: number, seed?: number): FixturePlan;
export function fixtureDigest(plan: FixturePlan): string;
export function materializeFixture(plan: FixturePlan, options?: { root?: string }): MaterializedFixture;
export function designFixturePage(seed?: number): DesignFixturePage;
export const DEFAULT_FIXTURE_PROJECT: { id: string; name: string };
