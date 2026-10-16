import { z } from 'zod';

/** Local development samples. These are never operational worker records. */
export const sidebarFixtureSchema = z.object({
  tabId: z.string().regex(/^thoughts-sidebar-demo-[a-z0-9-]+$/).max(120),
  title: z.string().startsWith('Demo · ').max(160),
  state: z.enum(['running', 'stuck', 'failed', 'waiting', 'finished', 'merged', 'review', 'rejected', 'idle']),
  scheduled: z.boolean(),
  repoName: z.string().min(1).max(100),
  repoPath: z.string().min(1).max(1024),
  branch: z.string().min(1).max(200),
  preview: z.string().min(1).max(400),
  updatedAt: z.string().datetime(),
});

export const sidebarFixturesSchema = z.object({
  schema: z.literal('o8/ui-sidebar-fixtures/v1'),
  synthetic: z.literal(true),
  fixtures: z.array(sidebarFixtureSchema).max(24),
}).refine((value) => new Set(value.fixtures.map((row) => row.tabId)).size === value.fixtures.length, {
  message: 'Duplicate demo thread',
});

export type SidebarFixture = z.infer<typeof sidebarFixtureSchema>;
