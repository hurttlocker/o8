import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VOICE_BRAIN_MODELS } from './voice-brain-models';

const registry = readFileSync('src-tauri/src/agent/planner_route.rs', 'utf8');
const modelConstants = readFileSync('src-tauri/src/models.rs', 'utf8');

describe('Voice model catalog matches native acceptance', () => {
  for (const provider of ['claude', 'codex']) {
    it(`offers exactly the models accepted by the ${provider} planner`, () => {
      const adapter = registry.split(`const ${provider.toUpperCase()}_ADAPTER:`)[1]?.split('\n};')[0];
      expect(adapter).toBeTruthy();
      const pins = adapter!.match(/pinnable_models: &\[([\s\S]*?)\]/)?.[1];
      expect(pins).toBeTruthy();
      const nativeIds = [...pins!.matchAll(/crate::models::(\w+)/g)].map((match) => {
        const id = modelConstants.match(new RegExp(`pub const ${match[1]}: &str = "([^"]+)";`))?.[1];
        expect(id).toBeTruthy();
        return id;
      });
      expect(VOICE_BRAIN_MODELS[provider].map((option) => option.value).sort()).toEqual(nativeIds.sort());
    });
  }
});
