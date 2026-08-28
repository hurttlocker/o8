import { describe, it, expect } from 'vitest';
import { buildGrabbedElement, GRAB_PAYLOAD_SOURCE, type GrabbedElement } from './grab';

/** A minimal fake element covering the surface buildGrabbedElement touches. */
function fakeButton(): Element {
  const win = {
    getComputedStyle: () => ({ color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '14px' }),
  };
  const doc = { defaultView: win, body: null, getElementById: () => null };
  return {
    ownerDocument: doc,
    tagName: 'BUTTON',
    id: 'go',
    classList: ['btn', 'primary'],
    textContent: 'Click me',
    innerHTML: '<span>Click me</span>',
    outerHTML: '<button id="go">Click me</button>',
    attributes: [
      { name: 'id', value: 'go' },
      { name: 'role', value: 'button' },
      { name: 'aria-label', value: 'Go' },
    ],
    parentElement: null,
    getBoundingClientRect: () => ({ top: 10, left: 20, width: 100, height: 40 }),
    getAttribute: (name: string) =>
      (({ role: 'button', 'aria-label': 'Go' }) as Record<string, string>)[name] ?? null,
  } as unknown as Element;
}

function reifyFromSource(): (el: unknown, selector: string) => GrabbedElement {

  return new Function(`${GRAB_PAYLOAD_SOURCE}; return buildGrabbedElement;`)() as (
    el: unknown,
    selector: string,
  ) => GrabbedElement;
}

describe('buildGrabbedElement', () => {
  it('captures structure, design styles, and accessibility', () => {
    const grabbed = buildGrabbedElement(fakeButton(), 'button#go');
    expect(grabbed.tagName).toBe('button');
    expect(grabbed.cssSelector).toBe('button#go');
    expect(grabbed.computedStyles.color).toBe('rgb(0, 0, 0)');
    expect(grabbed.computedStyles.fontSize).toBe('14px');
    expect(grabbed.accessibility.role).toBe('button');
    expect(grabbed.accessibility.name).toBe('Go');
    expect(grabbed.accessibility.ariaAttributes['aria-label']).toBe('Go');
    expect(grabbed.domSummary).toEqual({
      role: 'button',
      accessibleName: 'Go',
      ancestorChain: [],
      boundingRect: { top: 10, left: 20, width: 100, height: 40 },
      nearestLandmark: '',
    });
  });

  it('GRAB_PAYLOAD_SOURCE reconstructs to a function with identical output', () => {
    const reified = reifyFromSource();
    expect(typeof reified).toBe('function');
    expect(reified(fakeButton(), 'button#go')).toEqual(buildGrabbedElement(fakeButton(), 'button#go'));
  });

  it('GRAB_PAYLOAD_SOURCE is derived from the function (cannot drift)', () => {
    expect(GRAB_PAYLOAD_SOURCE).toContain(buildGrabbedElement.toString());
  });
});
