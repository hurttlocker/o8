/**
 * json-render catalog for Cortex IDE mobile
 *
 * Defines the component + action vocabulary that agents can use
 * to generate dynamic UI surfaces (approval cards, status panels, etc.)
 */
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck — json-render v0.14 types are complex; runtime works, TS inference needs upstream fixes
import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { z } from 'zod';

export const catalog = defineCatalog(schema, {
  components: {
    // ── Approval card: agent asks user to approve/reject an action ──
    ApprovalCard: {
      props: z.object({
        title: z.string().describe('Short title, e.g. "Deploy to staging?"'),
        description: z.string().describe('What the agent wants to do and why'),
        agent: z.string().describe('Agent name, e.g. "Codex", "Mister", "Niot"'),
        severity: z.enum(['info', 'warning', 'critical']).describe('Visual urgency level'),
        metadata: z.record(z.string()).optional().describe('Key-value pairs shown as detail rows'),
      }),
      description: 'An approval request from an agent — user can approve or reject',
    },

    // ── Status card: agent reports current state ──
    StatusCard: {
      props: z.object({
        title: z.string(),
        status: z.enum(['running', 'success', 'error', 'waiting']),
        message: z.string(),
        progress: z.number().min(0).max(100).optional(),
      }),
      description: 'Agent status update card',
    },

    // ── Metric: single KPI display ──
    Metric: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        trend: z.enum(['up', 'down', 'flat']).optional(),
        format: z.enum(['currency', 'percent', 'number', 'tokens']).nullable().optional(),
      }),
      description: 'Display a single metric value with optional trend',
    },

    // ── Option list: multiple-choice selection ──
    OptionList: {
      props: z.object({
        question: z.string(),
        options: z.array(z.object({
          id: z.string(),
          label: z.string(),
          description: z.string().optional(),
        })),
      }),
      description: 'Present multiple options for the user to choose from',
    },

    // ── Text block: rich text content ──
    TextBlock: {
      props: z.object({
        content: z.string().describe('Markdown-formatted text'),
        variant: z.enum(['default', 'muted', 'highlight']).optional(),
      }),
      description: 'A block of formatted text content',
    },

    // ── Code block: show code or diff ──
    CodeBlock: {
      props: z.object({
        code: z.string(),
        language: z.string().optional(),
        filename: z.string().optional(),
      }),
      description: 'Display a code snippet with syntax context',
    },

    // ── Action button row ──
    ButtonRow: {
      props: z.object({
        align: z.enum(['left', 'center', 'right', 'spread']).optional(),
      }),
      description: 'Container for a row of action buttons',
    },

    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(['primary', 'secondary', 'danger', 'ghost']).optional(),
        icon: z.string().optional().describe('Lucide icon name'),
        disabled: z.boolean().optional(),
      }),
      description: 'An action button',
    },
  },

  actions: {
    approve: {
      description: 'Approve the pending agent action',
    },
    reject: {
      description: 'Reject the pending agent action',
    },
    select_option: {
      description: 'Select an option from a list',
    },
    navigate: {
      description: 'Navigate to a session or view',
    },
    dismiss: {
      description: 'Dismiss a notification or card',
    },
  },
});

export type CortexCatalog = typeof catalog;
