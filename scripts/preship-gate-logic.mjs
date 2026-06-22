// Pure boot-probe logic shared by the pre-ship webview gate and its tests.
// No side effects — safe to import (the gate script itself runs main() at
// top level, so this lives separately so tests can import it cleanly).

// Evaluated INSIDE the running webview. Returns one of:
//   'mount-error' | 'app-error' | 'hydrated' | 'pending'
// 'hydrated' requires BOTH the deep-hydration attribute (set only after the
// workspace painted — see DashboardHydrationMarker) AND, independently, a
// painted [data-o8-workspace] anchor with a real box. So a white-screen /
// empty render that never threw cannot report healthy even if some other code
// sets the attribute.
export const BOOT_PROBE_JS = "(function(){"
  + "var d=document.documentElement;var b=document.body;"
  + "if(d&&d.getAttribute('data-o8-mount-error')==='1')return 'mount-error';"
  + "if(b&&b.innerText&&b.innerText.indexOf('Application error')!==-1)return 'app-error';"
  + "var ws=document.querySelector('[data-o8-workspace]');"
  + "var painted=!!(ws&&ws.offsetHeight>0&&ws.offsetWidth>0);"
  + "if(d&&d.getAttribute('data-o8-dashboard-hydrated')==='1'&&d.getAttribute('data-o8-mount-error')!=='1'&&painted)return 'hydrated';"
  + "return 'pending';"
  + "})()";

// Maps a probe result to a gate verdict. 'fail' reasons are worded so the gate's
// rethrow guard ("mount error" / "Application error") keeps propagating them.
export function classifyBootProbe(result) {
  switch (result) {
    case 'mount-error':
      return { verdict: 'fail', reason: 'dashboard reported a React mount error' };
    case 'app-error':
      return { verdict: 'fail', reason: 'dashboard rendered the Next.js "Application error" page' };
    case 'hydrated':
      return { verdict: 'pass' };
    default:
      return { verdict: 'pending' };
  }
}
