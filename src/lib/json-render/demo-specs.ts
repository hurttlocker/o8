/**
 * Demo specs — examples of what agents would generate via json-render
 *
 * In production, these would come from the gateway as structured events
 * when an agent needs user input (approval, selection, confirmation).
 */
import type { Spec } from '@json-render/core';

/**
 * Agent requests approval to deploy
 */
export const deployApprovalSpec: Spec = {
  root: 'approval',
  elements: {
    approval: {
      type: 'ApprovalCard',
      props: {
        title: 'Deploy cortex-ide to production?',
        description: 'Niot has completed the batch/2-command-surface branch and all checks pass. Ready to deploy to Vercel production.',
        agent: 'Niot',
        severity: 'warning',
        metadata: {
          Branch: 'batch/2-command-surface',
          Commits: '38',
          'Files changed': '14',
          'Lines added': '+1,766',
        },
      },
      children: ['buttons'],
    },
    buttons: {
      type: 'ButtonRow',
      props: { align: 'spread' },
      children: ['approve-btn', 'reject-btn'],
    },
    'approve-btn': {
      type: 'Button',
      props: { label: 'Approve Deploy', variant: 'primary' },
      children: [],
    },
    'reject-btn': {
      type: 'Button',
      props: { label: 'Reject', variant: 'danger' },
      children: [],
    },
  },
};

/**
 * Agent asks which approach to take
 */
export const decisionSpec: Spec = {
  root: 'options',
  elements: {
    options: {
      type: 'OptionList',
      props: {
        question: 'How should Hawk handle the failing test in cortex/search?',
        options: [
          { id: 'fix', label: 'Fix the test', description: 'Update the assertion to match the new behavior' },
          { id: 'skip', label: 'Skip for now', description: 'Mark as known issue, ship the rest' },
          { id: 'revert', label: 'Revert the change', description: 'Roll back the commit that broke it' },
        ],
      },
      children: [],
    },
  },
};

/**
 * Agent shows a cost/status dashboard
 */
export const dashboardSpec: Spec = {
  root: 'dashboard',
  elements: {
    dashboard: {
      type: 'StatusCard',
      props: {
        title: 'Batch 2 Build',
        status: 'running',
        message: 'Niot is working on #30 Approval primitive — 3 files changed so far',
        progress: 65,
      },
      children: [],
    },
  },
};
