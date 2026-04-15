'use client';

import { useEffect, useRef, useState } from 'react';
import type { DesignModeSelection } from '@/hooks/useDesignMode';

interface DesignModeOverlayProps {
  active: boolean;
  selection: DesignModeSelection | null;
  captureRequestId: number;
  onSelectionChange: (selection: DesignModeSelection | null) => void;
  onCapture: (contextText: string, rect: DesignModeSelection) => void;
  onClose: () => void;
}

interface DesignModeElementDescriptor {
  key: string;
  tagName: string;
  role: string | null;
  label: string | null;
  text: string | null;
  bounds: DesignModeSelection;
  interactive: boolean;
  score: number;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'switch',
  'tab',
  'textbox',
]);

const GENERIC_CONTAINERS = new Set([
  'article',
  'div',
  'footer',
  'header',
  'main',
  'nav',
  'section',
]);

function cleanText(value: string | null | undefined, maxLength: number): string | null {
  const collapsed = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return null;
  }
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

function normalizeSelection(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): DesignModeSelection {
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  const right = Math.max(startX, endX);
  const bottom = Math.max(startY, endY);
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}

function isValidSelection(selection: DesignModeSelection | null): selection is DesignModeSelection {
  return Boolean(selection && selection.width >= 6 && selection.height >= 6);
}

function selectionArea(selection: DesignModeSelection): number {
  return selection.width * selection.height;
}

function intersectsSelection(selection: DesignModeSelection, rect: DOMRect): boolean {
  return (
    rect.right > selection.x
    && rect.bottom > selection.y
    && rect.left < selection.x + selection.width
    && rect.top < selection.y + selection.height
  );
}

function readLabelFromReferences(value: string | null): string | null {
  const ids = value?.split(/\s+/).filter(Boolean) ?? [];
  if (ids.length === 0) {
    return null;
  }

  const parts = ids
    .map((id) => cleanText(document.getElementById(id)?.textContent, 120))
    .filter((part): part is string => Boolean(part));

  if (parts.length === 0) {
    return null;
  }

  return cleanText(parts.join(' '), 120);
}

function readElementLabel(element: Element): string | null {
  return (
    cleanText(element.getAttribute('aria-label'), 120)
    ?? readLabelFromReferences(element.getAttribute('aria-labelledby'))
    ?? cleanText(element.getAttribute('alt'), 120)
    ?? cleanText(element.getAttribute('title'), 120)
    ?? cleanText(element.getAttribute('placeholder'), 120)
    ?? cleanText(element.getAttribute('name'), 120)
  );
}

function isInteractiveElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  if (['a', 'button', 'input', 'label', 'select', 'summary', 'textarea'].includes(tagName)) {
    return true;
  }
  const role = element.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) {
    return true;
  }
  const tabIndex = element instanceof HTMLElement ? element.tabIndex : -1;
  return tabIndex >= 0;
}

function closestInterestingElement(element: Element): Element {
  return element.closest(
    'button, a, input, textarea, select, label, summary, [role="button"], [role="checkbox"], [role="combobox"], [role="link"], [role="menuitem"], [role="option"], [role="radio"], [role="switch"], [role="tab"], [role="textbox"]',
  ) ?? element;
}

function readElementText(element: Element): string | null {
  if (element instanceof HTMLElement) {
    return cleanText(element.innerText || element.textContent, 140);
  }
  return cleanText(element.textContent, 140);
}

function buildDescriptor(
  element: Element,
  selection: DesignModeSelection,
): DesignModeElementDescriptor | null {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return null;
  }
  if (!intersectsSelection(selection, rect)) {
    return null;
  }

  const tagName = element.tagName.toLowerCase();
  const role = cleanText(element.getAttribute('role'), 40);
  const label = readElementLabel(element);
  const text = readElementText(element);
  const interactive = isInteractiveElement(element);
  const area = rect.width * rect.height;
  const bounds = {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };

  if (!interactive && !role && !label && !text) {
    return null;
  }

  if (
    !interactive
    && !role
    && !label
    && GENERIC_CONTAINERS.has(tagName)
    && area >= selectionArea(selection) * 0.72
  ) {
    return null;
  }

  const score = [
    interactive ? 100 : 0,
    role ? 28 : 0,
    label ? 36 : 0,
    text ? 18 : 0,
    GENERIC_CONTAINERS.has(tagName) ? -16 : 0,
    area > selectionArea(selection) * 0.5 ? -12 : 0,
  ].reduce((total, value) => total + value, 0);

  return {
    key: [
      tagName,
      role ?? '',
      label ?? '',
      text ?? '',
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
    ].join('|'),
    tagName,
    role,
    label,
    text,
    bounds,
    interactive,
    score,
  };
}

function buildSampleAxis(start: number, size: number): number[] {
  if (size <= 18) {
    return [Math.round(start + (size / 2))];
  }

  const pointCount = size < 120 ? 2 : size < 280 ? 3 : size < 520 ? 4 : 5;
  const inset = Math.min(14, Math.max(6, size * 0.08));
  const min = start + inset;
  const max = start + size - inset;

  if (max <= min) {
    return [Math.round(start + (size / 2))];
  }

  const positions: number[] = [];
  for (let index = 0; index < pointCount; index += 1) {
    const ratio = index / (pointCount - 1);
    positions.push(Math.round(min + ((max - min) * ratio)));
  }

  const center = Math.round(start + (size / 2));
  if (!positions.includes(center)) {
    positions.push(center);
  }

  return Array.from(new Set(positions)).sort((left, right) => left - right);
}

function collectDescriptors(
  selection: DesignModeSelection,
  overlayRoot: HTMLDivElement | null,
): DesignModeElementDescriptor[] {
  const seen = new Set<string>();
  const descriptors: DesignModeElementDescriptor[] = [];
  const xPositions = buildSampleAxis(selection.x, selection.width);
  const yPositions = buildSampleAxis(selection.y, selection.height);

  for (const y of yPositions) {
    for (const x of xPositions) {
      const stack = typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(x, y)
        : (() => {
            const fallback = document.elementFromPoint(x, y);
            return fallback ? [fallback] : [];
          })();

      for (const rawElement of stack) {
        if (overlayRoot?.contains(rawElement)) {
          continue;
        }

        const candidate = closestInterestingElement(rawElement);
        if (overlayRoot?.contains(candidate)) {
          continue;
        }

        const descriptor = buildDescriptor(candidate, selection);
        if (!descriptor || seen.has(descriptor.key)) {
          continue;
        }

        seen.add(descriptor.key);
        descriptors.push(descriptor);
      }
    }
  }

  return descriptors
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const leftArea = left.bounds.width * left.bounds.height;
      const rightArea = right.bounds.width * right.bounds.height;
      return leftArea - rightArea;
    })
    .slice(0, 10);
}

function formatDescriptorLine(descriptor: DesignModeElementDescriptor, index: number): string {
  const parts = [`${index + 1}. <${descriptor.tagName}>`];
  if (descriptor.role) {
    parts.push(`role=${descriptor.role}`);
  }
  if (descriptor.label) {
    parts.push(`label=${JSON.stringify(descriptor.label)}`);
  }
  if (descriptor.text && descriptor.text !== descriptor.label) {
    parts.push(`text=${JSON.stringify(descriptor.text)}`);
  }
  if (descriptor.interactive) {
    parts.push('interactive=true');
  }
  parts.push(
    `bounds=x=${descriptor.bounds.x}, y=${descriptor.bounds.y}, w=${descriptor.bounds.width}, h=${descriptor.bounds.height}`,
  );
  return parts.join(' ');
}

function buildContextText(
  selection: DesignModeSelection,
  overlayRoot: HTMLDivElement | null,
): string {
  const descriptors = collectDescriptors(selection, overlayRoot);
  const location = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  return [
    '[Design Mode Selection]',
    `page: ${location || '/'}`,
    `title: ${cleanText(document.title, 140) ?? 'Untitled'}`,
    `viewport: ${window.innerWidth}x${window.innerHeight}`,
    `region: x=${selection.x}, y=${selection.y}, w=${selection.width}, h=${selection.height}`,
    'instruction: Use o8_view_screenshot to inspect this viewport region before answering.',
    descriptors.length > 0
      ? 'elements found:'
      : 'elements found: none via DOM sampling inside the selected region.',
    ...descriptors.map((descriptor, index) => formatDescriptorLine(descriptor, index)),
  ].join('\n');
}

export function DesignModeOverlay({
  active,
  selection,
  captureRequestId,
  onSelectionChange,
  onCapture,
  onClose,
}: DesignModeOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const lastCaptureRequestRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) {
      return;
    }

    const handleMouseUp = (event: MouseEvent) => {
      const origin = dragOriginRef.current;
      dragOriginRef.current = null;
      setDragging(false);

      if (!origin) {
        return;
      }

      const nextSelection = normalizeSelection(origin.x, origin.y, event.clientX, event.clientY);
      onSelectionChange(isValidSelection(nextSelection) ? nextSelection : null);
    };

    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [dragging, onSelectionChange]);

  useEffect(() => {
    if (!active) {
      return;
    }
    if (!isValidSelection(selection)) {
      return;
    }
    if (captureRequestId === 0 || captureRequestId === lastCaptureRequestRef.current) {
      return;
    }

    lastCaptureRequestRef.current = captureRequestId;
    const contextText = buildContextText(selection, overlayRef.current);
    onCapture(contextText, selection);
    onClose();
  }, [active, captureRequestId, onCapture, onClose, selection]);

  if (!active) {
    return null;
  }

  return (
    <div
      ref={overlayRef}
      aria-hidden="true"
      data-design-mode-overlay="true"
      onMouseDown={(event) => {
        if (!event.shiftKey) {
          return;
        }
        event.preventDefault();
        const origin = {
          x: event.clientX,
          y: event.clientY,
        };
        dragOriginRef.current = origin;
        setDragging(true);
        onSelectionChange({
          x: origin.x,
          y: origin.y,
          width: 0,
          height: 0,
        });
      }}
      onMouseMove={(event) => {
        const origin = dragOriginRef.current;
        if (!origin) {
          return;
        }
        event.preventDefault();
        onSelectionChange(normalizeSelection(origin.x, origin.y, event.clientX, event.clientY));
      }}
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 9999,
        cursor: 'crosshair',
        backgroundColor: 'rgba(15, 23, 42, 0.12)',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          position: 'fixed',
          top: 18,
          left: '50%',
          transform: 'translateX(-50%)',
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingTop: 10,
          paddingRight: 14,
          paddingBottom: 10,
          paddingLeft: 14,
          borderRadius: 10,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider)',
          backgroundColor: 'var(--t-panel-translucent)',
          color: 'var(--t-text)',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '-0.01em',
          lineHeight: 1.4,
          boxShadow: 'var(--t-glass-shadow)',
          backdropFilter: 'blur(18px) saturate(1.5)',
          WebkitBackdropFilter: 'blur(18px) saturate(1.5)',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        Design Mode — Shift+drag to select, Cmd+L to attach, Esc to exit
      </div>

      {selection ? (
        <div
          style={{
            position: 'fixed',
            top: selection.y,
            left: selection.x,
            width: selection.width,
            height: selection.height,
            borderWidth: 2,
            borderStyle: 'solid',
            borderColor: '#2563eb',
            borderRadius: 12,
            backgroundColor: 'rgba(37, 99, 235, 0.08)',
            boxSizing: 'border-box',
            pointerEvents: 'none',
          }}
        />
      ) : null}
    </div>
  );
}
