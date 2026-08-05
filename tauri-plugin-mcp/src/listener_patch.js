// Tauri MCP addEventListener monkey-patch (vanilla JS, no TypeScript)
// Tracks which elements have interactive event listeners attached via addEventListener.
// Uses callback identity (type + listener + capture) so removeEventListener with a
// non-matching handler doesn't incorrectly decrement counts.
// Idempotent: guarded by __TAURI_MCP_LISTENER_PATCH__ flag.
(function() {
    if (typeof window === 'undefined' || window.__TAURI_MCP_LISTENER_PATCH__) return;

    var INTERACTIVE_TYPES = {
        click: true, dblclick: true, mousedown: true, mouseup: true,
        pointerdown: true, pointerup: true, touchstart: true, touchend: true,
        keydown: true, keyup: true, keypress: true
    };

    var elementsWithListeners = new WeakSet();
    // WeakMap<Element, Set<string>> where key is "type|capture" + listener ref tracking
    // We use a WeakMap<Element, Map<string, Set<listener>>> to track by identity
    var listenerSets = new WeakMap();

    function captureFlag(options) {
        if (typeof options === 'boolean') return options;
        if (options && typeof options === 'object') return !!options.capture;
        return false;
    }

    function listenerKey(type, capture) {
        return type + '|' + (capture ? '1' : '0');
    }

    var origAdd = EventTarget.prototype.addEventListener;
    var origRemove = EventTarget.prototype.removeEventListener;

    EventTarget.prototype.addEventListener = function(type, listener, options) {
        if (INTERACTIVE_TYPES[type] && this instanceof Element && listener) {
            var cap = captureFlag(options);
            var key = listenerKey(type, cap);
            var map = listenerSets.get(this);
            if (!map) { map = {}; listenerSets.set(this, map); }
            if (!map[key]) map[key] = new Set();
            map[key].add(listener);
            elementsWithListeners.add(this);
        }
        return origAdd.call(this, type, listener, options);
    };

    EventTarget.prototype.removeEventListener = function(type, listener, options) {
        if (INTERACTIVE_TYPES[type] && this instanceof Element && listener) {
            var map = listenerSets.get(this);
            if (map) {
                var cap = captureFlag(options);
                var key = listenerKey(type, cap);
                var set = map[key];
                if (set) {
                    set.delete(listener);
                    if (set.size === 0) delete map[key];
                }
                // Check if any listener sets remain
                var hasAny = false;
                for (var k in map) { if (map.hasOwnProperty(k)) { hasAny = true; break; } }
                if (!hasAny) {
                    elementsWithListeners.delete(this);
                    listenerSets.delete(this);
                }
            }
        }
        return origRemove.call(this, type, listener, options);
    };

    window.__TAURI_MCP_LISTENER_PATCH__ = true;
    window.__TAURI_MCP_ELEMENTS_WITH_LISTENERS__ = elementsWithListeners;
})();
