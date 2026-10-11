/** Immutable, display-only documents attached to a workspace transcript. */
export const VISUALIZATION_LIMITS = {
  htmlBytes: 512 * 1024,
  documentBytes: 8 * 1024 * 1024,
  imageBytes: 2 * 1024 * 1024,
  requestBytes: 600 * 1024,
  titleChars: 120,
  minHeight: 80,
  maxHeight: 1800,
  defaultHeight: 360,
} as const;

export const VISUALIZATION_ID = /^vis-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface VisualizationReference {
  kind: 'o8-visualization';
  id: string;
  title: string;
  height: number;
  createdAt: string;
  rootId?: string;
  parentId?: string;
  version?: number;
}

export interface VisualizationDocument extends VisualizationReference {
  html: string;
  repoPath: string;
  threadId: string | null;
  packetId: string | null;
  source?: { html: string } | { layout: import('./templates').VisualizationLayout };
}

export function visualizationReference(document: VisualizationDocument): VisualizationReference {
  const { kind, id, title, height, createdAt } = document;
  return { kind, id, title, height, createdAt, ...(document.rootId ? { rootId: document.rootId, version: document.version, parentId: document.parentId } : {}) };
}

export function isVisualizationReference(value: unknown): value is VisualizationReference {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Partial<VisualizationReference>;
  return ref.kind === 'o8-visualization' && typeof ref.id === 'string' && VISUALIZATION_ID.test(ref.id)
    && typeof ref.title === 'string' && ref.title.length <= VISUALIZATION_LIMITS.titleChars
    && typeof ref.height === 'number' && Number.isFinite(ref.height)
    && ref.height >= VISUALIZATION_LIMITS.minHeight && ref.height <= VISUALIZATION_LIMITS.maxHeight
    && (ref.rootId === undefined || (typeof ref.rootId === 'string' && VISUALIZATION_ID.test(ref.rootId)))
    && (ref.parentId === undefined || (typeof ref.parentId === 'string' && VISUALIZATION_ID.test(ref.parentId)))
    && (ref.version === undefined || (Number.isSafeInteger(ref.version) && ref.version! >= 1))
    && typeof ref.createdAt === 'string' && Number.isFinite(Date.parse(ref.createdAt));
}
