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
} from './acp-model-catalogue';
import LIVE_MODELS from './__fixtures__/opencode-1.4.3-models.json';

const options = LIVE_MODELS as Array<{ value: string; name?: string }>;
const catalogue = buildModelCatalogue(options);

describe('buildModelCatalogue — against the live opencode payload', () => {
  it('accounts for every id exactly once, as a base model or an effort variant', () => {
    const bases = catalogueSize(catalogue);
    const efforts = catalogue.reduce(
      (n, g) => n + g.models.reduce((m, model) => m + model.efforts.length, 0),
      0,
    );
    expect(options).toHaveLength(864);
    expect(bases + efforts).toBe(864);
    // Measured against the live list: 523 bases, 341 effort variants.
    expect(bases).toBe(523);
    expect(efforts).toBe(341);
  });

  it('does NOT eat three-segment ids whose tail is a model name', () => {
    // The 337-model trap. These must survive as base models in their own right.
    const found = findCatalogueModel(catalogue, 'openrouter/ai21/jamba-large-1.7');
    expect(found?.model.id).toBe('openrouter/ai21/jamba-large-1.7');
    expect(found?.effort).toBeNull();
    const threeSegmentBases = catalogue
      .flatMap((g) => g.models)
      .filter((m) => m.id.split('/').length === 3);
    expect(threeSegmentBases.length).toBeGreaterThan(300);
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
