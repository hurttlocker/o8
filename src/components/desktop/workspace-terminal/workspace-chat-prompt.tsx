import {
  AlertCircle,
  FileText,
  Lightbulb,
  Search,
} from '../lucide-shims';

export function PromptGlyph({ icon }: { icon: string }) {
  if (icon === 'Idea') return <Lightbulb size={16} />;
  if (icon === 'Search') return <Search size={16} />;
  if (icon === 'Test') return <AlertCircle size={16} />;
  return <FileText size={16} />;
}

// Dispatcher prompts are large structured briefs. Detect them even when
// persisted tab metadata lost the orchestration badge.
export function looksLikePacketPrompt(text: string): boolean {
  if (!text || text.length < 400) return false;
  return /##\s*Project\s+(Brief|Scope|Directives)\b/i.test(text)
    || /(^|\n)\s*Packet:\s/i.test(text)
    || /(^|\n)\s*STRICT SCOPE:/i.test(text);
}
