import { FRESH_ORCHESTRATOR_EVENT, FRESH_ACTION_ATTRIBUTE, FRESH_RECEIPT_ATTRIBUTE, type FreshOrchestratorRequest } from '@/lib/desktop/fresh-orchestrator-action';

// Fixed own-document scripts. All embedded arguments are identities/data,
// never caller code, URLs or operation selectors.
export function freshSessionScript(phase: 'inspect' | 'dispatch' | 'observe' | 'focus' | 'timeout', request?: FreshOrchestratorRequest): string {
  return `(() => { let dispatchAttempted = false; try {
    const phase = ${JSON.stringify(phase)};
    const request = ${JSON.stringify(request ?? null)};
    const visible = el => {
      if (!(el instanceof HTMLElement) || !el.isConnected) return false;
      for (let node = el; node instanceof HTMLElement; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const fail = code => JSON.stringify({ ok: false, code, ...(phase === 'inspect' || phase === 'dispatch' ? { actionDispatched: false } : { requestId: request.requestId, mutationOutcome: 'unknown', automaticReplay: false }) });
    const roots = Array.from(document.querySelectorAll('[data-o8-workspace-root][data-o8-workspace-active="true"]')).filter(visible);
    if (roots.length !== 1) return fail('workspace_missing_or_ambiguous');
    const root = roots[0];
    if (root.getAttribute('aria-disabled') === 'true' || Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).some(visible)) return fail('workspace_disabled_or_dialog');
    const workspaceId = root.getAttribute('data-o8-workspace-id');
    const repoPath = root.getAttribute('data-o8-active-repo-path');
    const repoLabel = root.getAttribute('data-o8-active-repo');
    const activeTabId = root.getAttribute('data-o8-active-tab-id');
    const tabIds = JSON.parse(root.getAttribute('data-o8-tab-inventory') || 'null');
    if (!workspaceId || !repoPath || !repoLabel || !activeTabId || !Array.isArray(tabIds) || !tabIds.length || tabIds.length > 1000
      || tabIds.some(id => typeof id !== 'string' || !id || id.length > 256) || new Set(tabIds).size !== tabIds.length || !tabIds.includes(activeTabId)) return fail('invalid_workspace_inventory');
    const capability = root.getAttribute(${JSON.stringify(FRESH_ACTION_ATTRIBUTE)});
    if (phase === 'inspect') {
      if (!capability || !capability.startsWith('v1:')) return fail('fresh_session_unavailable');
      return JSON.stringify({ ok: true, workspaceId, repoPath, repoLabel, activeTabId, tabIds, capability });
    }
    if (workspaceId !== request.workspaceId || repoPath !== request.repoPath) return fail('workspace_or_project_changed');
    if (phase === 'dispatch') {
      if (capability !== request.capability || activeTabId !== request.activeTabId || JSON.stringify(tabIds) !== JSON.stringify(request.tabIds)) return fail('target_changed');
      if (Date.now() > request.expiresAt) return fail('expired_request');
      dispatchAttempted = true;
      root.dispatchEvent(new CustomEvent(${JSON.stringify(FRESH_ORCHESTRATOR_EVENT)}, { detail: request }));
    }
    const receiptText = root.getAttribute(${JSON.stringify(FRESH_RECEIPT_ATTRIBUTE)});
    const receipt = JSON.parse(receiptText || 'null');
    if (!receipt || receipt.requestId !== request.requestId) return JSON.stringify({ ok: false, code: 'unknown_request', requestId: request.requestId, mutationOutcome: 'unknown', automaticReplay: false });
    if (phase === 'dispatch' || receipt.status === 'error') return JSON.stringify({ ...receipt, ok: receipt.status === 'pending' });
    if (receipt.workspaceId !== workspaceId || receipt.repoPath !== repoPath || JSON.stringify(receipt.tabIds) !== JSON.stringify(request.tabIds)
      || !receipt.tabId || request.tabIds.includes(receipt.tabId)) return fail('receipt_identity_mismatch');
    if (receipt.status !== 'pending') return JSON.stringify({ ...receipt, ok: receipt.status === 'completed' });
    const publish = value => {
      if (root.getAttribute(${JSON.stringify(FRESH_RECEIPT_ATTRIBUTE)}) !== receiptText) return fail('receipt_changed');
      root.setAttribute(${JSON.stringify(FRESH_RECEIPT_ATTRIBUTE)}, JSON.stringify(value));
      return JSON.stringify({ ...value, ok: value.status === 'completed' });
    };
    if (phase === 'timeout') return publish({ ...receipt, status: 'unknown', code: 'verification_timeout', automaticReplay: false });
    if (tabIds.length !== request.tabIds.length + 1
      || tabIds.at(-1) !== receipt.tabId || JSON.stringify(tabIds.slice(0, -1)) !== JSON.stringify(request.tabIds)
      || activeTabId !== receipt.tabId || root.getAttribute('data-o8-active-tab-kind') !== 'orchestrator') {
      return JSON.stringify({ ok: false, status: 'pending', code: 'fresh_render_not_observed', requestId: request.requestId, actionDispatched: true });
    }
    const composers = Array.from(root.querySelectorAll('[data-o8-active-composer="true"]')).filter(visible);
    const composer = composers.length === 1 ? composers[0] : null;
    if (!composer || composer.disabled || composer.readOnly) return JSON.stringify({ ok: false, status: 'pending', code: 'enabled_composer_not_observed', requestId: request.requestId, actionDispatched: true });
    if (phase === 'focus') {
      composer.focus({ preventScroll: true });
      // focus can synchronously run handlers. Re-read identities after it;
      // never let an old acknowledgement overwrite a newer request or tab.
      const currentRoots = Array.from(document.querySelectorAll('[data-o8-workspace-root][data-o8-workspace-active="true"]')).filter(visible);
      const currentComposers = Array.from(root.querySelectorAll('[data-o8-active-composer="true"]')).filter(visible);
      if (!visible(root) || currentRoots.length !== 1 || currentRoots[0] !== root
        || root.getAttribute('data-o8-workspace-id') !== workspaceId || root.getAttribute('data-o8-active-repo-path') !== repoPath
        || root.getAttribute('data-o8-active-tab-id') !== receipt.tabId || root.getAttribute('data-o8-active-tab-kind') !== 'orchestrator'
        || root.getAttribute('data-o8-tab-inventory') !== JSON.stringify(tabIds)
        || root.getAttribute('aria-disabled') === 'true' || Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).some(visible)
        || currentComposers.length !== 1 || currentComposers[0] !== composer || composer.disabled || composer.readOnly
        || root.getAttribute(${JSON.stringify(FRESH_RECEIPT_ATTRIBUTE)}) !== receiptText) return fail('focus_target_changed');
      if (document.activeElement !== composer) return publish({ ...receipt, status: 'unknown', code: 'composer_focus_not_observed', automaticReplay: false });
      const published = JSON.parse(publish({ ...receipt, status: 'completed', automaticReplay: false }));
      if (!published.ok) return JSON.stringify(published);
    }
    return JSON.stringify({ ok: phase !== 'focus' || document.activeElement === composer, status: 'completed', requestId: request.requestId, actionDispatched: true, tabId: receipt.tabId, state: {
      activeWorkspaceId: workspaceId, activeWorkspaceRepo: repoLabel, activeWorkspaceRepoPath: repoPath,
      activeTabId, activeTabKind: 'orchestrator', composerFocused: document.activeElement === composer, tabInventory: tabIds,
    } });
  } catch (_) { return JSON.stringify({ ok: false, code: 'invalid_surface_state', ...(dispatchAttempted ? { mutationOutcome: 'unknown', automaticReplay: false } : { actionDispatched: false }) }); } })()`;
}
