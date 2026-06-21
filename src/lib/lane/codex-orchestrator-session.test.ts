import { describe, it, expect } from 'vitest';

import { codexOrchestratorModelFlags } from './codex-orchestrator-session';

describe('codexOrchestratorModelFlags', () => {
  it('keeps the cloud path verbatim (gpt-5.5 default unchanged)', () => {
    // This is the primary orchestrator path — any drift breaks every turn.
    expect(codexOrchestratorModelFlags('gpt-5.5', 'xhigh')).toEqual([
      '-c',
      'model=gpt-5.5',
      '-c',
      'model_reasoning_effort=xhigh',
    ]);
  });

  it('expands an Ollama model to the --oss local form (no reasoning effort)', () => {
    expect(codexOrchestratorModelFlags('ollama:qwen2.5-coder:32b', 'xhigh')).toEqual([
      '--oss',
      '--local-provider',
      'ollama',
      '--model',
      'qwen2.5-coder:32b',
    ]);
  });

  it('expands an LM Studio model to the --oss local form', () => {
    expect(codexOrchestratorModelFlags('lmstudio:qwen2.5-coder', 'high')).toEqual([
      '--oss',
      '--local-provider',
      'lmstudio',
      '--model',
      'qwen2.5-coder',
    ]);
  });
});
