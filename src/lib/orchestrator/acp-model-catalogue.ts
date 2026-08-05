/**
 * Turn an ACP agent's raw `configOptions.model` list into a picker-shaped
 * catalogue.
 *
 * opencode 1.4.3 reports 864 model ids in one flat array, and the reasoning
 * axis is encoded IN the id as a suffix:
 *
 *   google/gemini-3-pro-image
 *   google/gemini-3-pro-image/low
 *   google/gemini-3-pro-image/high
 *
 * so effort is not a separate capability we track per model — it is whether a
 * model has suffix siblings in the list. That is the whole reason this module
 * is pure and separately tested: the suffix rule is the one place a wrong
 * guess silently mangles the picker.
 *
 * The trap it avoids: provider-qualified ids are ALSO slash-separated and vary
 * in depth — `openrouter/deepseek/deepseek-v4-pro` is three segments and its
 * last segment is a model name, not an effort. Matching on "last segment looks
 * like an effort word" would eat it. So a trailing segment only counts as an
 * effort when the id WITHOUT it is itself present in the catalogue.
 */

/**
 * Suffixes an ACP agent may append to a model id to select reasoning depth.
 *
 * DERIVED from the live opencode 1.4.3 catalogue, not guessed: every tail whose
 * un-suffixed id also appears in the list. Guessing cost me `none` and `xhigh`
 * on the first pass — 132 variants that would have rendered as separate base
 * models, with a test that agreed because it shared the same wrong set.
 * If a future agent adds a depth word, the catalogue test's independently
 * derived expectation fails rather than silently splitting the model.
 */
const EFFORT_SUFFIXES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export interface CatalogueEffort {
  /** The suffix word, e.g. 'low'. */
  effort: string;
  /** The full model id to hand `session/set_model`, e.g. 'google/x/low'. */
  id: string;
}

export interface CatalogueModel {
  /** Base id, suffix stripped — what set_model receives at default effort. */
  id: string;
  /** Human label reported by the agent, else the id's trailing segment. */
  label: string;
  /** First path segment: 'openrouter' | 'google' | 'xai' | 'opencode' | … */
  provider: string;
  /** Effort variants, ordered minimal→max. Empty when the model has none. */
  efforts: CatalogueEffort[];
}

export interface CatalogueGroup {
  provider: string;
  models: CatalogueModel[];
}

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function splitSuffix(id: string): { base: string; effort: string } | null {
  const cut = id.lastIndexOf('/');
  if (cut <= 0) return null;
  const effort = id.slice(cut + 1);
  if (!EFFORT_SUFFIXES.has(effort)) return null;
  return { base: id.slice(0, cut), effort };
}

function providerOf(id: string): string {
  const cut = id.indexOf('/');
  return cut > 0 ? id.slice(0, cut) : id;
}

function labelOf(id: string, reported?: string): string {
  if (reported && reported.trim()) return reported.trim();
  const cut = id.lastIndexOf('/');
  return cut >= 0 ? id.slice(cut + 1) : id;
}

/**
 * Build the grouped catalogue. Providers and models are sorted alphabetically
 * so the picker order is stable across handshakes; effort variants sort by
 * depth rather than alphabetically ('low' must precede 'high').
 */
export function buildModelCatalogue(
  options: ReadonlyArray<{ value: string; name?: string }>,
): CatalogueGroup[] {
  const ids = new Set(options.map((o) => o.value));
  const labels = new Map(options.map((o) => [o.value, o.name]));

  const models = new Map<string, CatalogueModel>();
  const pendingEfforts: Array<{ base: string; effort: string; id: string }> = [];

  for (const { value } of options) {
    const split = splitSuffix(value);
    // A trailing effort word only counts when the un-suffixed id really exists;
    // otherwise it is part of the model's own name.
    if (split && ids.has(split.base)) {
      pendingEfforts.push({ base: split.base, effort: split.effort, id: value });
      continue;
    }
    if (!models.has(value)) {
      models.set(value, {
        id: value,
        label: labelOf(value, labels.get(value)),
        provider: providerOf(value),
        efforts: [],
      });
    }
  }

  for (const entry of pendingEfforts) {
    const model = models.get(entry.base);
    if (model) model.efforts.push({ effort: entry.effort, id: entry.id });
  }
  for (const model of models.values()) {
    model.efforts.sort((a, b) => EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort));
  }

  const byProvider = new Map<string, CatalogueModel[]>();
  for (const model of models.values()) {
    const bucket = byProvider.get(model.provider);
    if (bucket) bucket.push(model);
    else byProvider.set(model.provider, [model]);
  }

  return [...byProvider.entries()]
    .map(([provider, list]) => ({
      provider,
      models: list.sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Substring filter across id and label, case-insensitive. Space-separated terms
 * are ANDed, so "deep chat" finds `openrouter/deepseek/deepseek-chat` — with
 * 864 entries, requiring one contiguous substring makes the box feel broken.
 * Providers that end up empty are dropped.
 */
export function filterCatalogue(groups: CatalogueGroup[], query: string): CatalogueGroup[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return groups;
  const out: CatalogueGroup[] = [];
  for (const group of groups) {
    const models = group.models.filter((model) => {
      const haystack = `${model.id} ${model.label}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    if (models.length) out.push({ provider: group.provider, models });
  }
  return out;
}

/**
 * A short human label for a raw model id, without needing the catalogue loaded.
 *
 * The composer chip has to name the running model the moment a thread restores,
 * before any probe has returned — and a chip reading
 * `openrouter/deepseek/deepseek-v4-flash` is unreadable at chip size. Effort
 * variants keep their suffix, because `deepseek-v4-flash high` and
 * `deepseek-v4-flash` are different choices the operator made deliberately.
 */
export function shortModelLabel(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const trimmed = modelId.trim();
  if (!trimmed) return null;
  const split = splitSuffix(trimmed);
  if (split) {
    const base = split.base.slice(split.base.lastIndexOf('/') + 1);
    return `${base} ${split.effort}`;
  }
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** Total model count across groups — for the picker's "N models" affordance. */
export function catalogueSize(groups: CatalogueGroup[]): number {
  return groups.reduce((total, group) => total + group.models.length, 0);
}

/**
 * Resolve which catalogue entry a stored model id refers to, so the picker can
 * show the active row after a reload. Handles both a base id and an effort
 * variant id.
 */
export function findCatalogueModel(
  groups: CatalogueGroup[],
  modelId: string | null | undefined,
): { model: CatalogueModel; effort: string | null } | null {
  if (!modelId) return null;
  for (const group of groups) {
    for (const model of group.models) {
      if (model.id === modelId) return { model, effort: null };
      const variant = model.efforts.find((e) => e.id === modelId);
      if (variant) return { model, effort: variant.effort };
    }
  }
  return null;
}
