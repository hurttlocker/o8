'use client';

/**
 * Tabler icon shims — raw SVG renderer to bypass the Tauri webview
 * rendering bug. Same pattern as src/components/desktop/lucide-shims.tsx:
 * each icon imports its __iconNode data array from @tabler/icons-react
 * and renders via inline <svg> so we never invoke the broken Tabler
 * React component tree.
 *
 * Why a separate shim file: we want to keep Lucide as the bulk icon set
 * but reach for Tabler on specific glyphs where its visual design wins
 * (operator's call). Locked picks live in Hurttlocker.md.
 *
 * Public API matches lucide-shims: <IconName size strokeWidth color
 * className style />.
 */

import { createElement, type ReactElement, type SVGProps } from 'react';

type IconNodeAttrs = Record<string, string | number>;
type IconNode = ReadonlyArray<readonly [string, IconNodeAttrs]>;

// ── Raw icon node imports (Tauri-safe). Tabler ships .mjs dist files
// with the same __iconNode pattern as lucide-react. ──
import { __iconNode as TerminalNode } from '@tabler/icons-react/dist/esm/icons/IconTerminal2.mjs';
import { __iconNode as GitBranchNode } from '@tabler/icons-react/dist/esm/icons/IconGitBranch.mjs';

export interface TablerIconProps extends Omit<SVGProps<SVGSVGElement>, 'color'> {
  size?: number | string;
  strokeWidth?: number | string;
  color?: string;
}

export type TablerIcon = (props: TablerIconProps) => ReactElement;

function makeIcon(node: IconNode, displayName: string): TablerIcon {
  const Icon = ({
    size = 24,
    color = 'currentColor',
    strokeWidth = 2,
    ...rest
  }: TablerIconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {node.map(([tag, attrs], i) =>
        createElement(tag, { ...attrs, key: typeof attrs.key === 'string' ? attrs.key : i }),
      )}
    </svg>
  );
  Icon.displayName = displayName;
  return Icon;
}

export const Terminal: TablerIcon = makeIcon(TerminalNode as IconNode, 'TablerTerminal');
export const GitBranch: TablerIcon = makeIcon(GitBranchNode as IconNode, 'TablerGitBranch');
