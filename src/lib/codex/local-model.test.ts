import { describe, it, expect } from 'vitest';
import { parseLocalModel, codexModelArgs } from './local-model';

describe('parseLocalModel', () => {
  it('parses ollama with a colon-bearing tag', () => {
    expect(parseLocalModel('ollama:qwen2.5-coder:32b')).toEqual({ provider: 'ollama', model: 'qwen2.5-coder:32b' });
  });

  it('parses lmstudio', () => {
    expect(parseLocalModel('lmstudio:llama-3.1-8b')).toEqual({ provider: 'lmstudio', model: 'llama-3.1-8b' });
  });

  it('is case-insensitive on the provider prefix', () => {
    expect(parseLocalModel('Ollama:mistral')).toEqual({ provider: 'ollama', model: 'mistral' });
  });

  it('returns null for cloud models, empty, and malformed input', () => {
    expect(parseLocalModel('gpt-5.5')).toBeNull();
    expect(parseLocalModel('claude-opus-4-8')).toBeNull();
    expect(parseLocalModel('')).toBeNull();
    expect(parseLocalModel(undefined)).toBeNull();
    expect(parseLocalModel('ollama:')).toBeNull(); // no model after the prefix
    expect(parseLocalModel('vllm:mistral')).toBeNull(); // unknown provider
  });
});

describe('codexModelArgs', () => {
  it('expands a local model to the --oss --local-provider form', () => {
    expect(codexModelArgs('ollama:qwen2.5-coder:32b')).toEqual([
      '--oss', '--local-provider', 'ollama', '--model', 'qwen2.5-coder:32b',
    ]);
  });

  it('passes a cloud model straight through as --model', () => {
    expect(codexModelArgs('gpt-5.5')).toEqual(['--model', 'gpt-5.5']);
  });

  it('emits nothing for empty input (Codex uses its own default)', () => {
    expect(codexModelArgs('')).toEqual([]);
    expect(codexModelArgs(undefined)).toEqual([]);
  });
});
