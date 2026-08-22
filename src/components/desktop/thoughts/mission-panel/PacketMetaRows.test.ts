import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { PacketMetaRows } from './PacketMetaRows';

function packet(mode: 'native' | 'image' | null): OrchestratorPacket {
  return {
    id: 'packet-materialization',
    referenceLabel: 'P1',
    title: 'Materialization receipt',
    summary: 'Show the selected dependency setup path.',
    workspaceTargetPath: null,
    branchTarget: 'main',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    lane: {
      tileId: 'tile',
      tabId: 'tab',
      repoPath: null,
      runtime: 'codex',
      dependencyMaterializationMode: mode,
    },
  };
}

function render(mode: 'native' | 'image' | null): string {
  return renderToStaticMarkup(createElement(PacketMetaRows, {
    packet: packet(mode),
    workspaceTargets: [],
    editingField: null,
    onEditingFieldChange: vi.fn(),
    onPatch: vi.fn(),
  }));
}

describe('PacketMetaRows dependency materialization receipt', () => {
  it('names the shared-image and native-install paths on the packet card', () => {
    expect(render('image')).toContain('Shared APFS image');
    expect(render('native')).toContain('Native install');
  });

  it('omits the row when no dependency install ran', () => {
    expect(render(null)).not.toContain('dependencies');
  });
});
