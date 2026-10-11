import { z } from 'zod';
import { VisualizationError } from './errors';

const label = z.string().trim().min(1).max(120);
const point = z.object({ x: z.number().finite(), y: z.number().finite().nullable(), label: label.optional() }).strict();
export const visualizationLayoutSchema = z.object({
  layout: z.enum(['explore', 'trend', 'compare']),
  title: label,
  caption: z.string().max(400).optional(),
  source: z.string().trim().min(1).max(600),
  unit: z.string().trim().min(1).max(40),
  xLabel: label,
  series: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), label,
    values: z.array(point).min(1).max(366) }).strict()).min(1).max(8),
  style: z.enum(['quiet', 'standard']).default('standard'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  plot: z.enum(['line', 'bar']).default('line'),
  aggregate: z.enum(['sum', 'mean']).default('sum'),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.series.map(series => series.id)).size !== value.series.length) ctx.addIssue({ code: 'custom', message: 'Series IDs must be unique.' });
  for (const series of value.series) if (new Set(series.values.map(point => point.x)).size !== series.values.length) ctx.addIssue({ code: 'custom', message: 'Each series needs unique x values.' });
});
export type VisualizationLayout = z.infer<typeof visualizationLayoutSchema>;

export function parseVisualizationLayout(value: unknown): VisualizationLayout {
  const parsed = visualizationLayoutSchema.safeParse(value);
  if (!parsed.success) throw new VisualizationError('invalid_layout', parsed.error.issues.map(issue => issue.message).slice(0, 3).join(' '));
  if (parsed.data.layout === 'compare' && !(value as Record<string, unknown>).plot) parsed.data.plot = 'bar';
  return parsed.data;
}

/** Data stays data: labels never become markup, CSS or JavaScript. */
export function visualizationLayoutHtml(spec: VisualizationLayout): string {
  const json = JSON.stringify(spec).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<div id="exploration"></div><script>o8Viz.dashboard('#exploration',${json});</script>`;
}

export function visualizationInputSource(input: Record<string, unknown>) {
  if ((input.html === undefined) === (input.layout === undefined)) throw new VisualizationError('invalid_source', 'Provide HTML or a layout, exactly one.');
  const layout = input.layout === undefined ? undefined : parseVisualizationLayout(input.layout);
  return { layout, html: layout ? visualizationLayoutHtml(layout) : input.html };
}
