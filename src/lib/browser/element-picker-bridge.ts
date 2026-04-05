export interface PickedElement {
  tagName: string;
  id: string;
  classList: string[];
  textContent: string;
  attributes: Record<string, string>;
  boundingRect: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
  cssSelector: string;
  computedStyles: {
    color: string;
    backgroundColor: string;
    fontSize: string;
    fontFamily: string;
    padding: string;
    margin: string;
    display: string;
    position: string;
  };
  innerHTML: string;
  parentChain: string[];
}

export const ELEMENT_PICKER_START_EVENT = 'o8:picker:start';
export const ELEMENT_PICKER_STOP_EVENT = 'o8:picker:stop';
export const ELEMENT_PICKER_RESULT_EVENT = 'o8:picker:result';

const ELEMENT_PICKER_BRIDGE_SCRIPT = `(() => {
  if (window.__o8ElementPickerBridge) return;
  if (window.__o8ElementPickerBridgeInstalled) return;
  window.__o8ElementPickerBridge = true;
  window.__o8ElementPickerBridgeInstalled = true;

  const state = { active: false, hovered: null, overlay: null };

  function trim(value, max) {
    const text = String(value || '').trim();
    return text.length > max ? text.slice(0, max) : text;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  }

  function describeElement(element) {
    let description = element.tagName.toLowerCase();
    if (element.id) return description + '#' + cssEscape(element.id);
    const classNames = Array.from(element.classList).slice(0, 2);
    if (classNames.length > 0) description += '.' + classNames.map((name) => cssEscape(name)).join('.');
    return description;
  }

  function uniqueSelector(element) {
    if (element.id) return '#' + cssEscape(element.id);
    const parts = [];
    let current = element;

    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift('#' + cssEscape(current.id));
        break;
      }

      if (typeof current.className === 'string' && current.className.trim()) {
        selector += '.' + current.className.trim().split(/\\s+/).map((name) => cssEscape(name)).join('.');
      }

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) selector += ':nth-child(' + (Array.from(parent.children).indexOf(current) + 1) + ')';
      }

      parts.unshift(selector);
      current = current.parentElement;
    }

    if (current === document.body) parts.unshift('body');
    return parts.join(' > ');
  }

  function collectAttributes(element) {
    const attributes = {};
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name;
      if (
        name === 'role'
        || name === 'href'
        || name === 'src'
        || name.startsWith('data-')
        || name.startsWith('aria-')
      ) {
        attributes[name] = attribute.value;
      }
    });
    return attributes;
  }

  function parentChain(element) {
    const chain = [];
    let current = element.parentElement;
    while (current) {
      chain.unshift(describeElement(current));
      if (current === document.body) break;
      current = current.parentElement;
    }
    return chain;
  }

  function ensureOverlay() {
    if (state.overlay) return state.overlay;
    const overlay = document.createElement('div');
    overlay.setAttribute('data-o8-picker-overlay', 'true');
    Object.assign(overlay.style, {
      position: 'absolute',
      top: '0px',
      left: '0px',
      width: '0px',
      height: '0px',
      border: '2px solid #2563eb',
      background: 'rgba(37,99,235,0.15)',
      pointerEvents: 'none',
      zIndex: '2147483647',
      display: 'none',
      boxSizing: 'border-box',
    });
    (document.body || document.documentElement).appendChild(overlay);
    state.overlay = overlay;
    return overlay;
  }

  function updateOverlay() {
    const overlay = ensureOverlay();
    const element = state.hovered;
    if (!state.active || !(element instanceof Element)) {
      overlay.style.display = 'none';
      return;
    }

    const rect = element.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = rect.top + window.scrollY + 'px';
    overlay.style.left = rect.left + window.scrollX + 'px';
    overlay.style.width = Math.max(rect.width, 0) + 'px';
    overlay.style.height = Math.max(rect.height, 0) + 'px';
  }

  function stopPicker() {
    state.active = false;
    state.hovered = null;
    document.documentElement.style.cursor = '';
    updateOverlay();
  }

  function elementFromPoint(root, x, y) {
    const element = root.elementFromPoint(x, y);
    if (!element) return null;
    if (element.shadowRoot) return elementFromPoint(element.shadowRoot, x, y) || element;
    return element;
  }

  function buildPayload(element) {
    const computed = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || '',
      classList: Array.from(element.classList),
      textContent: trim((element.textContent || '').replace(/\\s+/g, ' '), 200),
      attributes: collectAttributes(element),
      boundingRect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      },
      cssSelector: uniqueSelector(element),
      computedStyles: {
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        fontSize: computed.fontSize,
        fontFamily: computed.fontFamily,
        padding: computed.padding,
        margin: computed.margin,
        display: computed.display,
        position: computed.position,
      },
      innerHTML: trim(element.innerHTML || '', 500),
      parentChain: parentChain(element),
    };
  }

  document.addEventListener('mousemove', (event) => {
    if (!state.active) return;
    state.hovered = elementFromPoint(document, event.clientX, event.clientY);
    updateOverlay();
  }, true);

  window.addEventListener('scroll', () => {
    if (state.active) updateOverlay();
  }, true);

  window.addEventListener('resize', () => {
    if (state.active) updateOverlay();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.active) stopPicker();
  });

  window.addEventListener('click', (event) => {
    if (!state.active) return;
    const target = state.hovered || (event.target instanceof Element ? event.target : null);
    if (!target || target.closest('[data-o8-picker-overlay="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    window.parent.postMessage({ type: '${ELEMENT_PICKER_RESULT_EVENT}', element: buildPayload(target) }, '*');
    stopPicker();
  }, true);

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === '${ELEMENT_PICKER_START_EVENT}') {
      state.active = true;
      state.hovered = null;
      document.documentElement.style.cursor = 'crosshair';
      updateOverlay();
      return;
    }
    if (data.type === '${ELEMENT_PICKER_STOP_EVENT}') stopPicker();
  });
})();`;

export function createElementPickerBridgeScript(): string {
  return ELEMENT_PICKER_BRIDGE_SCRIPT;
}
