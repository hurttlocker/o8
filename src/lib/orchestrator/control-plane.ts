import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OrchestratorMissionState } from './types';
import { createEmptyOrchestratorMissionState, normalizeOrchestratorMissionState } from './store';

const ORCHESTRATOR_DIR = join(homedir(), '.cortex-ide');
const ORCHESTRATOR_PATH = join(ORCHESTRATOR_DIR, 'orchestrator-state.json');
const ORCHESTRATOR_TMP_PATH = `${ORCHESTRATOR_PATH}.tmp`;

interface OrchestratorControlPlaneFile {
  version: 1;
  mission: OrchestratorMissionState;
}

function ensureControlPlaneDir() {
  mkdirSync(ORCHESTRATOR_DIR, { recursive: true });
}

export function readOrchestratorControlPlaneState(): OrchestratorMissionState {
  try {
    const raw = readFileSync(ORCHESTRATOR_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<OrchestratorControlPlaneFile>;
    return normalizeOrchestratorMissionState(parsed.mission ?? createEmptyOrchestratorMissionState());
  } catch {
    return createEmptyOrchestratorMissionState();
  }
}

export function writeOrchestratorControlPlaneState(state: OrchestratorMissionState) {
  ensureControlPlaneDir();
  const next: OrchestratorControlPlaneFile = {
    version: 1,
    mission: normalizeOrchestratorMissionState(state),
  };
  writeFileSync(ORCHESTRATOR_TMP_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(ORCHESTRATOR_TMP_PATH, ORCHESTRATOR_PATH);
  return next.mission;
}
