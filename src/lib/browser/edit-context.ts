import type { GrabbedElement } from './grab';

export interface ElementEditContext {
  text: string;
  previewImageDataUri?: string;
}

function buildPlainDescriptor(element: GrabbedElement): string {
  const classes = element.classList.map((className) => `.${className}`).join('');
  const id = element.id ? `#${element.id}` : '';
  return `<${element.tagName.toLowerCase()}${classes}${id}>`;
}

function buildTextTarget(element: GrabbedElement): string {
  const classSuffix = element.classList.length > 0 ? `.${element.classList.join('.')}` : '';
  return `<${element.tagName.toLowerCase()}${classSuffix}>`;
}

export function buildTextEditContext(element: GrabbedElement, nextText: string): ElementEditContext {
  return {
    text: `Change the text of ${buildTextTarget(element)} from ${JSON.stringify(element.textContent)} to ${JSON.stringify(nextText)}`,
  };
}

function formatRect(rect: { top: number; left: number; width: number; height: number }): string {
  return `${Math.round(rect.width)}x${Math.round(rect.height)} at (${Math.round(rect.left)}, ${Math.round(rect.top)})`;
}

export function buildEditContext(element: GrabbedElement, draftText: string): ElementEditContext {
  const summary = element.domSummary;
  const details = [
    'Edit the selected browser element.',
    `Element: ${buildPlainDescriptor(element)}`,
    `Selector: ${element.cssSelector}`,
    element.textContent ? `Text: ${JSON.stringify(element.textContent)}` : '',
    draftText.trim() && draftText !== element.textContent ? `Requested text: ${JSON.stringify(draftText)}` : '',
    `Styles: color ${element.computedStyles.color}; background ${element.computedStyles.backgroundColor}; font-size ${element.computedStyles.fontSize}; padding ${element.computedStyles.padding}; margin ${element.computedStyles.margin}; display ${element.computedStyles.display}`,
    summary ? `Role: ${summary.role || '(none)'}` : '',
    summary ? `Accessible name: ${JSON.stringify(summary.accessibleName)}` : '',
    summary ? `Ancestor chain: ${summary.ancestorChain.length > 0 ? summary.ancestorChain.join(' > ') : '(none)'}` : '',
    summary ? `Bounding rect: ${formatRect(summary.boundingRect)}` : '',
    summary ? `Nearest landmark: ${summary.nearestLandmark || '(none)'}` : '',
    element.screenshot ? 'Screenshot: attached element crop' : '',
  ].filter(Boolean);

  return {
    text: details.join('\n'),
    ...(element.screenshot ? { previewImageDataUri: element.screenshot } : {}),
  };
}
