/** Shared desktop frame geometry; compact headers preserve workspace height. */
export const NAVIGATION_RAIL_WIDTH = 60;
export const SHELL_HEADER_HEIGHT = 40;
export const SHELL_EDGE_INSET = 4;

/** Round exposed perimeter edges; shared seams remain straight. */
export function workspaceFrameCorners(joined: boolean, outerLeft: boolean, outerRight: boolean, radius = 14) {
  if (!joined) return { radius, smoothing: 0.6 };
  return {
    topLeft: outerLeft ? radius : 0,
    bottomLeft: outerLeft ? radius : 0,
    topRight: outerRight ? radius : 0,
    bottomRight: outerRight ? radius : 0,
  };
}
