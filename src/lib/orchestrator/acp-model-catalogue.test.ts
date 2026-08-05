/**
 * Catalogue tests run against the VERBATIM 864-option `configOptions.model`
 * payload captured from live opencode 1.4.3 (2026-08-04), not a hand-built
 * fixture. A hand-built one would have encoded my assumptions about the id
 * shape, which is exactly what needs testing: the real list contains 337
 * three-segment ids whose last segment is a model name rather than an effort
 * (`openrouter/ai21/jamba-large-1.7`), so a naive "strip the last segment"
 * rule silently deletes 337 models and nobody notices until a picker is empty.
 */

import { describe, it, expect } from 'vitest';

import {
  buildModelCatalogue,
  filterCatalogue,
  catalogueSize,
  findCatalogueModel,
  shortModelLabel,
  stripRedundantProviderPrefix,
} from './acp-model-catalogue';
import LIVE_MODELS from './__fixtures__/opencode-1.4.3-models.json';

const options = LIVE_MODELS as Array<{ value: string; name?: string }>;
const catalogue = buildModelCatalogue(options);

describe('buildModelCatalogue — against the live opencode payload', () => {
  // Derived from the fixture WITHOUT reusing the module's effort set. The first
  // version of this test hardcoded 523/341, which matched the implementation
  // because both used the same incomplete suffix list — it stayed green while
  // 132 `none`/`xhigh` variants rendered as separate base models. Ground truth
  // is structural: a tail is an effort exactly when the un-suffixed id also
  // exists, whatever the word is.
  const ids = new Set(options.map((o) => o.value));
  const trueVariants = options.filter((o) => {
    const cut = o.value.lastIndexOf('/');
    return cut > 0 && ids.has(o.value.slice(0, cut));
  });
  const trueBases = options.length - trueVariants.length;

  it('splits bases and effort variants the way the data says, not the way the code assumes', () => {
    const bases = catalogueSize(catalogue);
    const efforts = catalogue.reduce(
      (n, g) => n + g.models.reduce((m, model) => m + model.efforts.length, 0),
      0,
    );
    expect(options).toHaveLength(864);
    expect(bases + efforts).toBe(864);
    expect(bases).toBe(trueBases);
    expect(efforts).toBe(trueVariants.length);
  });

  it('recognizes every depth word the catalogue actually uses', () => {
    // If the agent ships a new suffix, this fails instead of silently splitting.
    const dataWords = new Set(trueVariants.map((o) => o.value.slice(o.value.lastIndexOf('/') + 1)));
    const parsedWords = new Set(
      catalogue.flatMap((g) => g.models).flatMap((m) => m.efforts.map((e) => e.effort)),
    );
    expect([...dataWords].sort()).toEqual([...parsedWords].sort());
  });

  it('does NOT eat three-segment ids whose tail is a model name', () => {
    // The 337-model trap. These must survive as base models in their own right.
    const found = findCatalogueModel(catalogue, 'openrouter/ai21/jamba-large-1.7');
    expect(found?.model.id).toBe('openrouter/ai21/jamba-large-1.7');
    expect(found?.effort).toBeNull();
    const threeSegmentBases = catalogue
      .flatMap((g) => g.models)
      .filter((m) => m.id.split('/').length === 3);
    expect(threeSegmentBases.length).toBeGreaterThan(200);
  });

  it('groups the real providers', () => {
    expect(catalogue.map((g) => g.provider)).toEqual(['google', 'opencode', 'openrouter', 'xai']);
  });

  it('never emits an id that was not in the source list', () => {
    const source = new Set(options.map((o) => o.value));
    for (const group of catalogue) {
      for (const model of group.models) {
        expect(source.has(model.id)).toBe(true);
        for (const variant of model.efforts) expect(source.has(variant.id)).toBe(true);
      }
    }
  });
});

describe('effort suffixes', () => {
  it('attaches /low and /high to their base and orders them by depth', () => {
    const found = findCatalogueModel(catalogue, 'google/gemini-3-pro-image');
    expect(found).not.toBeNull();
    const efforts = found!.model.efforts.map((e) => e.effort);
    // Ordered minimal→max, never alphabetically (which would put high before low).
    expect(efforts).toEqual([...efforts].sort(
      (a, b) => ['minimal', 'low', 'medium', 'high', 'max'].indexOf(a)
        - ['minimal', 'low', 'medium', 'high', 'max'].indexOf(b),
    ));
    expect(efforts).toContain('low');
    expect(efforts).toContain('high');
  });

  it('resolves a stored effort-variant id back to its base plus effort', () => {
    const found = findCatalogueModel(catalogue, 'google/gemini-3-pro-image/high');
    expect(found?.model.id).toBe('google/gemini-3-pro-image');
    expect(found?.effort).toBe('high');
  });

  it('leaves models without siblings effort-free — the picker must not invent one', () => {
    const found = findCatalogueModel(catalogue, 'openrouter/ai21/jamba-large-1.7');
    expect(found?.model.efforts).toEqual([]);
  });

  it('only treats a tail as an effort when the un-suffixed id really exists', () => {
    // Synthetic: 'vendor/model/high' with NO 'vendor/model' base stays whole.
    const built = buildModelCatalogue([{ value: 'vendor/model/high' }]);
    expect(built[0].models[0].id).toBe('vendor/model/high');
    expect(built[0].models[0].efforts).toEqual([]);
  });
});

describe('filterCatalogue', () => {
  it('ANDs space-separated terms across id and label', () => {
    const hits = filterCatalogue(catalogue, 'deep chat').flatMap((g) => g.models);
    expect(hits.length).toBeGreaterThan(0);
    for (const model of hits) {
      expect(model.id.toLowerCase()).toContain('deep');
      expect(model.id.toLowerCase()).toContain('chat');
    }
  });

  it('finds the operator’s named targets — DeepSeek and Qwen', () => {
    expect(catalogueSize(filterCatalogue(catalogue, 'deepseek'))).toBeGreaterThan(0);
    expect(catalogueSize(filterCatalogue(catalogue, 'qwen'))).toBeGreaterThan(0);
  });

  it('drops emptied provider groups instead of showing bare headers', () => {
    const filtered = filterCatalogue(catalogue, 'deepseek');
    for (const group of filtered) expect(group.models.length).toBeGreaterThan(0);
  });

  it('returns everything for an empty query', () => {
    expect(catalogueSize(filterCatalogue(catalogue, '   '))).toBe(catalogueSize(catalogue));
  });
});

describe('stripRedundantProviderPrefix', () => {
  it('drops the display prefix when it names the row’s own provider group', () => {
    expect(stripRedundantProviderPrefix('OpenRouter/DeepSeek V4 Pro', 'openrouter')).toBe('DeepSeek V4 Pro');
    expect(stripRedundantProviderPrefix('xAI/Grok 4.5', 'xai')).toBe('Grok 4.5');
    // Display prefix and provider id are not equal strings — the match is
    // normalized containment, which is what makes this case work at all.
    expect(stripRedundantProviderPrefix('OpenCode Zen/DeepSeek V4 Flash Free (New)', 'opencode')).toBe('DeepSeek V4 Flash Free (New)');
  });

  it('leaves labels alone when the slash is not a provider prefix', () => {
    expect(stripRedundantProviderPrefix('GPT-4/Turbo', 'openrouter')).toBe('GPT-4/Turbo');
    expect(stripRedundantProviderPrefix('DeepSeek V4 Flash', 'openrouter')).toBe('DeepSeek V4 Flash');
    expect(stripRedundantProviderPrefix('/leading-slash', 'openrouter')).toBe('/leading-slash');
  });

  it('makes the colliding DeepSeek V4 rows distinct at last — the live regression', () => {
    // At menu width, four openrouter DeepSeek V4 rows all ellipsized to
    // "OpenRouter/DeepSeek V4…" (2026-08-05). The fixture-derived claim: after
    // stripping, each label in that family starts with its discriminator, so
    // no two collide within the first characters a 300px row can show.
    const family = catalogue
      .filter((g) => g.provider === 'openrouter')
      .flatMap((g) => g.models)
      .filter((m) => m.id.includes('deepseek-v4'));
    expect(family.length).toBeGreaterThanOrEqual(3);
    const stripped = family.map((m) => stripRedundantProviderPrefix(m.label, 'openrouter'));
    for (const label of stripped) expect(label.startsWith('OpenRouter/')).toBe(false);
    expect(new Set(stripped).size).toBe(stripped.length);
  });
});

describe('degenerate input', () => {
  it('survives an empty list', () => {
    expect(buildModelCatalogue([])).toEqual([]);
    expect(catalogueSize([])).toBe(0);
    expect(findCatalogueModel([], 'anything')).toBeNull();
  });

  it('handles an id with no provider segment', () => {
    const built = buildModelCatalogue([{ value: 'bare-model' }]);
    expect(built[0].provider).toBe('bare-model');
    expect(built[0].models[0].id).toBe('bare-model');
  });

  it('returns null for an unknown stored model', () => {
    expect(findCatalogueModel(catalogue, 'openrouter/does/not-exist')).toBeNull();
  });
});

describe('shortModelLabel — what the composer chip shows', () => {
  it('reduces a provider-qualified id to the model name', () => {
    expect(shortModelLabel('openrouter/deepseek/deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(shortModelLabel('xai/grok-4.5')).toBe('grok-4.5');
    expect(shortModelLabel('opencode/big-pickle')).toBe('big-pickle');
  });

  it('keeps the effort, because that was a separate deliberate choice', () => {
    expect(shortModelLabel('google/gemini-3-pro-image/high')).toBe('gemini-3-pro-image high');
  });

  it('does not mistake a model name for an effort suffix', () => {
    // The 337-id trap again: `deepseek-v4-pro` is a name, not a depth.
    expect(shortModelLabel('openrouter/deepseek/deepseek-v4-pro')).toBe('deepseek-v4-pro');
  });

  it('survives ids with no provider segment and empty input', () => {
    expect(shortModelLabel('bare')).toBe('bare');
    expect(shortModelLabel(null)).toBeNull();
    expect(shortModelLabel('   ')).toBeNull();
  });
});
