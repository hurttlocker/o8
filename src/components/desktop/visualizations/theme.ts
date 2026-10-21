import { defaultVisualizationTheme, type VisualizationTheme } from '@/lib/visualizations/document';

export function readVisualizationTheme(): VisualizationTheme {
  const style = getComputedStyle(document.documentElement);
  const scheme = style.colorScheme.includes('light') && !style.colorScheme.includes('dark') ? 'light' : 'dark';
  const theme = defaultVisualizationTheme(scheme);
  const aliases: Record<string, string> = {
    '--foreground': '--t-text-primary', '--muted-foreground': '--t-text-muted', '--muted': '--t-bg-hover',
    '--card': '--t-bg-card', '--card-foreground': '--t-text-primary', '--border': '--t-border',
    '--popover': '--t-popover-surface',
    '--accent': '--t-accent', '--primary': '--t-accent', '--chart-1': '--t-text-primary',
    '--font-sans': '--font-sans-system', '--font-mono': '--font-mono',
  };
  for (const [key, source] of Object.entries(aliases)) {
    const value = style.getPropertyValue(source).trim();
    if (value && value.length <= 300) theme.variables[key] = value;
  }
  return theme;
}
