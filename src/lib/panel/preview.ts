export const PREVIEW_PROXY_ROUTE = '/api/panel/proxy';
export const PREVIEW_MESSAGE_SOURCE = 'cortex-preview';
export const PREVIEW_HOST_MESSAGE_SOURCE = 'cortex-preview-host';

export interface DetectedLocalhostPreview {
  id: string;
  tabId: string;
  url: string;
  port: number;
  detectedAt: number;
}

export interface PreviewSelectionPayload {
  targetUrl: string;
  pageTitle: string;
  selector: string;
  tagName: string;
  id: string | null;
  classes: string[];
  role: string | null;
  name: string | null;
  text: string;
  snippet: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  styles: Record<string, string>;
}

function compact(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export function formatPreviewSelectionContext(selection: PreviewSelectionPayload): string {
  const text = compact(selection.text, 220);
  const snippet = compact(selection.snippet, 260) ?? `<${selection.tagName.toLowerCase()}>`;
  const classes = selection.classes.length > 0 ? selection.classes.join(' ') : null;
  const styles = [
    ['color', selection.styles.color],
    ['background', selection.styles.backgroundColor],
    ['font-size', selection.styles.fontSize],
    ['font-weight', selection.styles.fontWeight],
    ['display', selection.styles.display],
  ]
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}=${value}`);

  return [
    `[Selected element from ${selection.targetUrl}]`,
    `selector: ${selection.selector}`,
    `tag: <${selection.tagName.toLowerCase()}>`,
    selection.id ? `id: ${selection.id}` : null,
    classes ? `classes: ${classes}` : null,
    selection.role ? `role: ${selection.role}` : null,
    selection.name ? `name: ${selection.name}` : null,
    text ? `text: ${text}` : null,
    `bounds: x=${Math.round(selection.bounds.x)}, y=${Math.round(selection.bounds.y)}, w=${Math.round(selection.bounds.width)}, h=${Math.round(selection.bounds.height)}`,
    styles.length > 0 ? `styles: ${styles.join('; ')}` : null,
    `snippet: ${snippet}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
