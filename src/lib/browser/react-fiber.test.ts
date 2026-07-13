import { describe, it, expect } from 'vitest';
import { reactComponentName, REACT_COMPONENT_NAME_SOURCE } from './react-fiber';

describe('reactComponentName', () => {
  it('exposes a no-drift injectable source derived from the real function', () => {
    expect(REACT_COMPONENT_NAME_SOURCE).toContain('var reactComponentName =');
    expect(REACT_COMPONENT_NAME_SOURCE).toContain(reactComponentName.toString());
  });

  it('returns null on a non-React node (no fiber key)', () => {
    expect(reactComponentName({ parentElement: null } as unknown as Element)).toBeNull();
  });

  it('climbs the fiber .return chain to the nearest named component (host fibers skipped)', () => {
    function AgentSwarm() { /* named composite */ }
    const parentFiber = { type: AgentSwarm, return: null };
    const hostFiber = { type: 'div', return: parentFiber }; // string type → skipped
    const el: Record<string, unknown> = { parentElement: null };
    el['__reactFiber$abc123'] = hostFiber;
    expect(reactComponentName(el as unknown as Element)).toBe('AgentSwarm');
  });

  it('unwraps forwardRef (type.render) component names', () => {
    function NodeGraph() { /* forwardRef inner */ }
    const fiber = { type: { render: NodeGraph }, return: null };
    const el: Record<string, unknown> = { parentElement: null };
    el['__reactFiber$xyz'] = fiber;
    expect(reactComponentName(el as unknown as Element)).toBe('NodeGraph');
  });

  it('prefers displayName and ignores lowercase/internal names', () => {
    const withDisplay = { type: { displayName: 'MemoizedList', name: '_internal' }, return: null };
    const el: Record<string, unknown> = { parentElement: null };
    el['__reactFiber$1'] = withDisplay;
    expect(reactComponentName(el as unknown as Element)).toBe('MemoizedList');

    const lowercaseOnly = { type: function useThing() {}, return: null };
    const el2: Record<string, unknown> = { parentElement: null };
    el2['__reactFiber$2'] = lowercaseOnly;
    expect(reactComponentName(el2 as unknown as Element)).toBeNull();
  });
});
