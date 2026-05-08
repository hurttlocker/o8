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

export interface PreviewAnnotationDomTarget {
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

export interface PreviewAnnotationPayload {
  targetUrl: string;
  pageTitle: string;
  kind: 'arrow';
  createdAt: string;
  screenshot?: {
    path?: string;
    src?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    capturedAt?: string;
    sidecarPath?: string;
    error?: string;
  } | null;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
    scrollX: number;
    scrollY: number;
  };
  annotation: {
    start: { x: number; y: number };
    end: { x: number; y: number };
    path: Array<{ x: number; y: number }>;
    bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  };
  domMap: {
    start: PreviewAnnotationDomTarget | null;
    end: PreviewAnnotationDomTarget | null;
    touched: PreviewAnnotationDomTarget[];
  };
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

function formatDomTarget(label: string, target: PreviewAnnotationDomTarget | null): string {
  if (!target) return `${label}: none`;
  const text = compact(target.text, 120);
  return [
    `${label}: ${target.selector}`,
    `  tag: <${target.tagName.toLowerCase()}>`,
    target.id ? `  id: ${target.id}` : null,
    target.classes.length > 0 ? `  classes: ${target.classes.join(' ')}` : null,
    target.role ? `  role: ${target.role}` : null,
    target.name ? `  name: ${target.name}` : null,
    text ? `  text: ${text}` : null,
    `  bounds: x=${Math.round(target.bounds.x)}, y=${Math.round(target.bounds.y)}, w=${Math.round(target.bounds.width)}, h=${Math.round(target.bounds.height)}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function formatPreviewAnnotationContext(annotation: PreviewAnnotationPayload): string {
  const touched = annotation.domMap.touched
    .slice(0, 8)
    .map((target, index) => `${index + 1}. ${target.selector}${target.text ? ` — ${compact(target.text, 80)}` : ''}`);

  const screenshot = annotation.screenshot;
  const screenshotLines = screenshot?.path
    ? [
      `screenshot file: ${screenshot.path}`,
      screenshot.src ? `screenshot preview: ${screenshot.src}` : null,
      screenshot.width && screenshot.height ? `screenshot size: ${screenshot.width}x${screenshot.height}` : null,
      screenshot.sidecarPath ? `annotation sidecar: ${screenshot.sidecarPath}` : null,
    ]
    : screenshot?.error
      ? [`screenshot capture failed: ${screenshot.error}`]
      : [];

  const annotationJson = JSON.stringify({
    kind: annotation.kind,
    screenshot: annotation.screenshot ?? null,
    viewport: annotation.viewport,
    annotation: {
      start: annotation.annotation.start,
      end: annotation.annotation.end,
      bounds: annotation.annotation.bounds,
      path: annotation.annotation.path,
    },
    domMap: {
      start: annotation.domMap.start,
      end: annotation.domMap.end,
      touched: annotation.domMap.touched,
    },
  }, null, 2);

  return [
    'Use the visual annotation as implementation intent.',
    'Modify the existing DOM/components. Return a code diff.',
    '',
    `[Annotated browser preview from ${annotation.targetUrl}]`,
    annotation.pageTitle ? `page title: ${annotation.pageTitle}` : null,
    ...screenshotLines,
    `annotation: ${annotation.kind} from x=${Math.round(annotation.annotation.start.x)}, y=${Math.round(annotation.annotation.start.y)} to x=${Math.round(annotation.annotation.end.x)}, y=${Math.round(annotation.annotation.end.y)}`,
    '',
    formatDomTarget('arrow start near', annotation.domMap.start),
    '',
    formatDomTarget('arrow end near', annotation.domMap.end),
    touched.length > 0 ? '' : null,
    touched.length > 0 ? 'elements touched by annotation path:' : null,
    touched.length > 0 ? touched.join('\n') : null,
    '',
    'annotation JSON:',
    '```json',
    annotationJson,
    '```',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
