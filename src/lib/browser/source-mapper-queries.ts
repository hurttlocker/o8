import type { PickedElement, SearchDescriptor } from '@/lib/browser/source-mapper-types';

const COMMON_TEXT_PHRASES = new Set([
  'submit',
  'cancel',
  'ok',
  'okay',
  'save',
  'close',
  'open',
  'back',
  'next',
  'previous',
  'menu',
  'search',
  'loading',
  'retry',
  'done',
  'yes',
  'no',
  'copy',
  'delete',
  'edit',
  'refresh',
  'continue',
]);

export function buildComponentDescriptors(element: PickedElement): SearchDescriptor[] {
  return extractPascalCaseCandidates(element)
    .slice(0, 2)
    .map((componentName) => ({
      mode: 'regex',
      query: buildComponentPattern(componentName),
      baseConfidence: 0.9,
      reason: 'component_name',
      component: componentName,
      textLength: componentName.length,
    }));
}

export function buildTextDescriptors(element: PickedElement): SearchDescriptor[] {
  return extractTextPhrases(element.textContent ?? element.text ?? '')
    .slice(0, 3)
    .map((phrase) => ({
      mode: 'fixed',
      query: phrase,
      baseConfidence: 0.8,
      reason: 'text_content',
      textLength: phrase.length,
    }));
}

export function buildAttributeDescriptors(element: PickedElement): SearchDescriptor[] {
  const snippetAttributes = extractSnippetAttributes(element.snippet ?? '');
  const attributes = new Map<string, string>();
  for (const [key, value] of Object.entries(element.attributes ?? {})) {
    if (!key || !value?.trim()) {
      continue;
    }
    attributes.set(key.toLowerCase(), value.trim());
  }
  for (const [key, value] of snippetAttributes.entries()) {
    if (!attributes.has(key)) {
      attributes.set(key, value);
    }
  }
  const descriptors: SearchDescriptor[] = [];

  const dataTestId = attributes.get('data-testid') ?? '';
  if (isUsefulIdentifier(dataTestId)) {
    descriptors.push({
      mode: 'regex',
      query: buildQuotedAttributePattern(['data-testid'], dataTestId),
      baseConfidence: 0.6,
      reason: 'attribute',
      textLength: dataTestId.length,
    });
  }

  if (isUsefulIdentifier(element.id)) {
    descriptors.push({
      mode: 'regex',
      query: buildQuotedAttributePattern(['id'], element.id),
      baseConfidence: 0.6,
      reason: 'attribute',
      textLength: element.id.length,
    });
  }

  const ariaOrName = firstNonEmpty(element.name, attributes.get('aria-label'), attributes.get('name'));
  if (isUsefulAttributeValue(ariaOrName)) {
    descriptors.push({
      mode: 'regex',
      query: buildQuotedAttributePattern(['aria-label', 'name'], ariaOrName),
      baseConfidence: 0.6,
      reason: 'attribute',
      textLength: ariaOrName.length,
    });
  }

  const classCandidate = dedupeStrings([
    ...(element.classes ?? []),
    ...(element.classList ?? []),
    ...(attributes.get('class') ?? '').split(/\s+/),
  ])
    .find(isUsefulClassName);

  if (classCandidate) {
    descriptors.push({
      mode: 'regex',
      query: buildQuotedAttributePattern(['className', 'class'], classCandidate, true),
      baseConfidence: 0.6,
      reason: 'class_name',
      textLength: classCandidate.length,
    });
  }

  const styleDescriptor = buildStyleDescriptor(element);
  if (styleDescriptor && descriptors.length < 3) {
    descriptors.push(styleDescriptor);
  }

  return descriptors.slice(0, 3);
}

export function buildStructureDescriptors(element: PickedElement): SearchDescriptor[] {
  const tagName = element.tagName.trim().toLowerCase();
  if (!tagName) {
    return [];
  }

  const descriptors: SearchDescriptor[] = [];
  const firstClass = [...(element.classes ?? []), ...(element.classList ?? [])].find(isUsefulClassName);
  if (firstClass) {
    descriptors.push({
      mode: 'regex',
      query: buildTagAttributePattern(tagName, ['className', 'class'], firstClass),
      baseConfidence: 0.4,
      reason: 'tag_structure',
      textLength: `${tagName} ${firstClass}`.length,
    });
  }

  if (isUsefulIdentifier(element.id)) {
    descriptors.push({
      mode: 'regex',
      query: buildTagAttributePattern(tagName, ['id'], element.id),
      baseConfidence: 0.4,
      reason: 'tag_structure',
      textLength: `${tagName} ${element.id}`.length,
    });
  }

  return descriptors.slice(0, 2);
}

function extractTextPhrases(text: string) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }

  const candidates = [
    normalized,
    ...normalized.split(/\s*[|•·]\s*|[.!?;:](?=\s|$)/),
  ];

  const words = normalized.split(' ');
  if (words.length > 6) {
    candidates.push(words.slice(0, Math.min(words.length, 8)).join(' '));
    candidates.push(words.slice(Math.max(words.length - 8, 0)).join(' '));
  }

  return dedupeStrings(candidates)
    .map((candidate) => candidate.trim())
    .filter(isUsefulTextPhrase)
    .sort((left, right) => right.length - left.length)
    .slice(0, 3);
}

function extractPascalCaseCandidates(element: PickedElement) {
  const candidates: string[] = [];
  for (const source of [
    ...(element.componentNames ?? []),
    ...(element.parentChain ?? []),
    element.selector ?? '',
    ...(element.classes ?? []),
    ...(element.classList ?? []),
  ]) {
    for (const match of source.matchAll(/\b[A-Z][A-Za-z0-9]{2,}\b/g)) {
      const value = match[0];
      if (!value || /^[A-Z0-9_]+$/.test(value)) {
        continue;
      }
      candidates.push(value);
    }
  }

  return dedupeStrings(candidates).slice(0, 3);
}

function extractSnippetAttributes(snippet: string) {
  const attributes = new Map<string, string>();
  for (const match of snippet.matchAll(/\b(data-testid|aria-label|id|name|class)\s*=\s*"([^"]+)"/gi)) {
    const key = match[1]?.toLowerCase();
    const value = match[2]?.trim();
    if (key && value) {
      attributes.set(key, value);
    }
  }
  return attributes;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function buildComponentPattern(componentName: string) {
  const escaped = escapeRegex(componentName);
  return [
    `export\\s+default\\s+function\\s+${escaped}\\b`,
    `function\\s+${escaped}\\b`,
    `const\\s+${escaped}\\s*=`,
    `class\\s+${escaped}\\b`,
    `export\\s+default\\s+${escaped}\\b`,
  ].join('|');
}

function buildQuotedAttributePattern(attributeNames: string[], value: string, contains = false) {
  const attributes = attributeNames.map(escapeRegex).join('|');
  const escapedValue = escapeRegex(value);
  const matcher = contains ? `[^"'\`\\n>]*${escapedValue}` : escapedValue;
  return `(?:${attributes})\\s*=\\s*(?:\\{\\s*)?["'\`]${matcher}["'\`]`;
}

function buildTagAttributePattern(tagName: string, attributeNames: string[], value: string) {
  const attributes = attributeNames.map(escapeRegex).join('|');
  const escapedValue = escapeRegex(value);
  return `<${escapeRegex(tagName)}[^>\\n]{0,160}(?:${attributes})\\s*=\\s*(?:\\{\\s*)?["'\`][^"'\`\\n>]*${escapedValue}`;
}

function isUsefulTextPhrase(value: string) {
  if (value.length < 8) {
    return false;
  }

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    return false;
  }

  return !COMMON_TEXT_PHRASES.has(value.toLowerCase());
}

function isUsefulIdentifier(value?: string | null): value is string {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length >= 2 && !COMMON_TEXT_PHRASES.has(trimmed.toLowerCase());
}

function isUsefulAttributeValue(value?: string | null): value is string {
  if (!value) {
    return false;
  }
  const trimmed = normalizeWhitespace(value);
  return trimmed.length >= 3;
}

function buildStyleDescriptor(element: PickedElement): SearchDescriptor | null {
  const styleCandidates: Array<{ key: string; value: string }> = [
    { key: 'display', value: element.styles?.display ?? '' },
    { key: 'position', value: element.styles?.position ?? '' },
    { key: 'fontSize', value: element.styles?.fontSize ?? '' },
    { key: 'fontWeight', value: element.styles?.fontWeight ?? '' },
  ];

  for (const candidate of styleCandidates) {
    const value = candidate.value.trim();
    if (!isUsefulStyleValue(value)) {
      continue;
    }

    return {
      mode: 'regex',
      query: `${escapeRegex(candidate.key)}\\s*:\\s*["'\`]${escapeRegex(value)}["'\`]`,
      baseConfidence: 0.55,
      reason: 'attribute',
      textLength: `${candidate.key}:${value}`.length,
    };
  }

  return null;
}

function isUsefulStyleValue(value: string) {
  if (!value) {
    return false;
  }
  if (value === 'block' || value === 'inline' || value === 'static' || value === '400') {
    return false;
  }
  return !/^(?:rgb|rgba|hsl|hsla)\(/i.test(value);
}

function isUsefulClassName(value: string) {
  const trimmed = value.trim();
  if (trimmed.length < 3) {
    return false;
  }
  if (!/[A-Za-z]/.test(trimmed)) {
    return false;
  }
  if (/^(?:flex|grid|hidden|block|inline|relative|absolute|sticky|container)$/i.test(trimmed)) {
    return false;
  }
  return !/^[a-f0-9_-]{12,}$/i.test(trimmed);
}

function firstNonEmpty(...values: Array<string | undefined | null>) {
  for (const value of values) {
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    deduped.push(trimmed);
  }

  return deduped;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
