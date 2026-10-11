/** Classic JavaScript shared by models. Host transport is supplied by the sealed bootstrap. */
export const VISUALIZATION_CONTROLS = `
(() => {
  const bridge = window.__o8Visualization;
  let snapshot = bridge.initialState || {};
  const subscribers = new Set();
  const clone = value => JSON.parse(JSON.stringify(value));
  function notify() { for (const listener of subscribers) { try { listener(clone(snapshot)); } catch (error) { console.warn('Visualization state listener failed', error); } } }
  function setState(value) {
    try {
      const json = JSON.stringify(value);
      if (!value || typeof value !== 'object' || Array.isArray(value) || new TextEncoder().encode(json).length > 16384) return false;
      if (JSON.stringify(snapshot)===json) return true;
      snapshot = JSON.parse(json); bridge.post('state', snapshot); notify(); return true;
    } catch { return false; }
  }
  addEventListener('o8:visualization-state', event => { snapshot = event.detail || {}; notify(); });
  function tooltip(root) {
    if (getComputedStyle(root).position==='static') root.style.position='relative';
    const node = document.createElement('div'); node.className = 'viz-tooltip'; node.setAttribute('role','tooltip'); node.hidden = true; root.append(node);
    return {
      show(title, rows, point) {
        node.replaceChildren();
        if (title) { const heading = document.createElement('div'); heading.className = 'viz-tooltip-title'; heading.textContent = title; node.append(heading); }
        for (const row of rows) {
          const line = document.createElement('div'); line.className = 'viz-tooltip-row';
          const label = document.createElement('span'); label.className = 'viz-tooltip-label';
          if (row.color) { const swatch = document.createElement('span'); swatch.className = 'viz-swatch'; swatch.style.background = row.color; label.append(swatch); }
          label.append(document.createTextNode(String(row.label)));
          const value = document.createElement('span'); value.className = 'viz-tooltip-value'; value.textContent = String(row.value); line.append(label,value); node.append(line);
        }
        node.hidden = false;
        const bounds = root.getBoundingClientRect();
        const x = Math.max(0,Math.min(bounds.width-node.offsetWidth,point.x+14));
        let y = point.y+14;
        if (y+node.offsetHeight > bounds.height) y = point.y-node.offsetHeight-14;
        node.style.left = x+'px'; node.style.top = Math.max(0,y)+'px';
      },
      hide() { node.hidden = true; }, destroy() { node.remove(); }
    };
  }
  window.o8Viz = {
    version: 4,
    getState(fallback = {}) { return Object.keys(snapshot).length ? clone(snapshot) : clone(fallback); },
    setState,
    onState(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    link(key) {
      if (typeof key!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new Error('Use a stable link key');
      return {
        get() { return clone(snapshot.links?.[key] || {}); },
        set(value) { return setState(Object.assign({},snapshot,{links:Object.assign({},snapshot.links,{[key]:value || {}})})); },
        clear() { return this.set({}); },
        onChange(listener) { return window.o8Viz.onState(() => listener(clone(snapshot.links?.[key] || {}))); }
      };
    },
    ask(prompt) { if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) return false; bridge.post('question',prompt.trim()); return true; },
    tooltip,
    color(index = 0) { return getComputedStyle(document.documentElement).getPropertyValue('--chart-'+(index%6+1)).trim(); },
    onTheme(listener) { addEventListener('o8:visualization-theme', listener); return () => removeEventListener('o8:visualization-theme', listener); }
  };
  function mountTabs(group) {
    const buttons = Array.from(group.querySelectorAll('button[data-value]'));
    if (!buttons.length) return;
    const key = group.dataset.stateKey || group.id;
    function select(value, save, keyboard) {
      if (!buttons.some(button => button.dataset.value === value && !button.disabled)) return;
      for (const button of buttons) {
        const active = button.dataset.value === value; button.setAttribute('aria-selected',String(active)); button.tabIndex = active ? 0 : -1;
        const panel = document.getElementById(button.getAttribute('aria-controls'));
        if (panel) panel.hidden = !active;
      }
      if (save && key) setState(Object.assign({},snapshot,{[key]:value}));
      group.dispatchEvent(new CustomEvent('viz:change',{bubbles:true,detail:{value,keyboard:Boolean(keyboard)}}));
    }
    group.setAttribute('role','tablist');
    for (const button of buttons) {
      button.setAttribute('role','tab');
      button.addEventListener('click',event => select(button.dataset.value,true,event.detail===0));
      button.addEventListener('keydown',event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault();
        const available = buttons.filter(button => !button.disabled);
        const index = available.indexOf(button);
        const next = event.key==='Home' ? available[0] : event.key==='End' ? available.at(-1) : available[(index+(event.key==='ArrowRight'?1:-1)+available.length)%available.length];
        next.focus(); select(next.dataset.value,true,true);
      });
    }
    const stored=buttons.some(button => button.dataset.value===snapshot[key] && !button.disabled) ? snapshot[key] : null;
    select(stored || buttons.find(button => button.getAttribute('aria-selected')==='true')?.dataset.value || buttons[0].dataset.value,false,true);
    subscribers.add(() => { if (snapshot[key]) select(snapshot[key],false,true); });
  }
  function ready() {
    document.querySelectorAll('[data-viz-tabs]').forEach(mountTabs);
    let tip = null;
    function show(event) {
      const target = event.target instanceof Element ? event.target.closest('[data-viz-tooltip]') : null;
      if (!target) return;
      tip ||= tooltip(document.body);
      const rect = target.getBoundingClientRect(), root = document.body.getBoundingClientRect();
      tip.show('',[{label:target.dataset.vizTooltip,value:''}],{x:rect.left-root.left,y:rect.bottom-root.top});
    }
    document.addEventListener('pointerover',show); document.addEventListener('focusin',show);
    document.addEventListener('pointerout',() => tip?.hide()); document.addEventListener('focusout',() => tip?.hide());
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',ready,{once:true}); else ready();
})();
`;
