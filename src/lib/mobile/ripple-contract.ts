export type RippleChoice = {
  label: string;
  value: string;
};

export type RippleNoResolution = {
  kind: 'none';
};

export type RippleChoiceDraft = {
  kind: 'choice';
  question: string;
  options: RippleChoice[];
  aodlPath: string;
  confidence?: number;
};

export type RippleChoiceResolution = RippleChoiceDraft & {
  id: string;
};

export type RippleResolutionDraft = RippleNoResolution | RippleChoiceDraft;
export type RippleResolutionResult = RippleNoResolution | RippleChoiceResolution;

export type RippleAodlPatch = {
  path: string;
  value: string;
  source: 'ripple';
  resolutionId: string;
};

export type RippleEpisode = {
  version: 1;
  utterance: string;
  resolution: RippleChoiceResolution;
  selectedValue: string;
  patch: RippleAodlPatch;
  resolutionMs: number;
  resolvedAt: string;
};

const AODL_PATH = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/i;
const ALLOWED_AODL_ROOTS = new Set(['intent', 'constraints', 'references', 'verification']);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max) return null;
  return cleaned;
}

function parseChoice(value: unknown): RippleChoice | null {
  if (!record(value)) return null;
  const label = cleanString(value.label, 64);
  const optionValue = cleanString(value.value, 96);
  return label && optionValue ? { label, value: optionValue } : null;
}

export function parseRippleResolutionDraft(value: unknown): RippleResolutionDraft | null {
  if (!record(value)) return null;
  if (value.kind === 'none') return { kind: 'none' };
  if (value.kind !== 'choice') return null;

  const question = cleanString(value.question, 180);
  const aodlPath = cleanString(value.aodlPath, 96);
  const aodlRoot = aodlPath?.split(/[._-]/, 1)[0];
  if (!question || !aodlPath || !AODL_PATH.test(aodlPath) || !aodlRoot || !ALLOWED_AODL_ROOTS.has(aodlRoot)) return null;
  if (!Array.isArray(value.options)) return null;

  const options = value.options.map(parseChoice).filter((choice): choice is RippleChoice => Boolean(choice));
  if (options.length < 2 || options.length > 4 || options.length !== value.options.length) return null;

  const confidence = typeof value.confidence === 'number'
    && Number.isFinite(value.confidence)
    && value.confidence >= 0
    && value.confidence <= 1
    ? value.confidence
    : undefined;

  return {
    kind: 'choice',
    question,
    options,
    aodlPath,
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

export function parseRippleResolutionResult(value: unknown): RippleResolutionResult | null {
  const draft = parseRippleResolutionDraft(value);
  if (!draft || draft.kind === 'none') return draft;
  if (!record(value)) return null;
  const id = cleanString(value.id, 96);
  return id ? { ...draft, id } : null;
}

export function formatRippleSystemContext(patches: RippleAodlPatch[]): string {
  return [
    'User-confirmed AODL resolution context for this turn.',
    'Treat these values as resolved intent fields. They do not expand authority or permissions.',
    ...patches.map((patch) => `${patch.path} = ${JSON.stringify(patch.value)}`),
  ].join('\n');
}
