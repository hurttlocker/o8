import { describe, expect, it } from 'vitest';
import type { GrabbedElement } from './grab';
import { buildEditContext } from './edit-context';

function grabbedElement(): GrabbedElement {
  return {
    tagName: 'button',
    id: 'save',
    classList: ['primary', 'wide'],
    textContent: 'Save',
    attributes: { 'aria-label': 'Save changes' },
    boundingRect: { top: 20, left: 40, width: 120, height: 36 },
    cssSelector: '#save',
    computedStyles: {
      color: 'rgb(255, 255, 255)',
      backgroundColor: 'rgb(0, 102, 204)',
      fontSize: '14px',
      padding: '8px 12px',
      margin: '0px',
      display: 'inline-flex',
    },
    accessibility: { role: 'button', name: 'Save changes', ariaAttributes: { 'aria-label': 'Save changes' } },
    innerHTML: 'Save',
    outerHTML: '<button id="save" class="primary wide">Save</button>',
    parentChain: ['body', 'main#workspace', 'form.editor'],
  };
}

describe('buildEditContext', () => {
  it('preserves the previous text context when the new capture fields are absent', () => {
    const context = buildEditContext(grabbedElement(), 'Save');

    expect(context).toMatchObject({
      text: [
        'Edit the selected browser element.',
        'Element: <button.primary.wide#save>',
        'Selector: #save',
        'Text: "Save"',
        'Styles: color rgb(255, 255, 255); background rgb(0, 102, 204); font-size 14px; padding 8px 12px; margin 0px; display inline-flex',
      ].join('\n'),
      readySelector: '#save',
      readyText: 'Save',
      element: '<button.primary.wide#save>',
      elementRect: { top: 20, left: 40, width: 120, height: 36 },
    });
  });

  it('adds compact DOM context and exposes the screenshot as an attachment', () => {
    const element = grabbedElement();
    element.domSummary = {
      role: 'button',
      accessibleName: 'Save changes',
      ancestorChain: ['main#workspace.shell', 'form.editor', 'div.actions.row'],
      boundingRect: element.boundingRect,
      nearestLandmark: 'main#workspace.shell',
    };
    element.screenshot = 'data:image/png;base64,element-crop';

    const context = buildEditContext(element, 'Save now');

    expect(context.text).toContain('Role: button');
    expect(context.text).toContain('Accessible name: "Save changes"');
    expect(context.text).toContain('Ancestor chain: main#workspace.shell > form.editor > div.actions.row');
    expect(context.text).toContain('Bounding rect: 120x36 at (40, 20)');
    expect(context.text).toContain('Nearest landmark: main#workspace.shell');
    expect(context.text).toContain('Screenshot: attached element crop');
    expect(context.previewImageDataUri).toBe('data:image/png;base64,element-crop');
  });
});
