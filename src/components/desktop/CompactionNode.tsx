import React, { useState } from 'react';
import { Brain, ChevronDown, ChevronUp, Sparkles } from 'lucide-react';

interface CompactionNodeProps {
  compactedCount: number;
  summary: string;
}

/**
 * A premium, glass-morphic UI component to visually demonstrate that the chat
 * has compressed older messages to save memory.
 */
export function CompactionNode({ compactedCount, summary }: CompactionNodeProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Strip the XML tags for display if they exist
  const displaySummary = summary
    .replace('<compacted_context>', '')
    .replace('</compacted_context>', '')
    .trim();

  return (
    <div className="w-full my-4 flex justify-center">
      <div className="w-[90%] md:w-[80%] rounded-xl border border-purple-500/30 bg-purple-500/5 backdrop-blur-md overflow-hidden transition-all duration-300">
        
        {/* Header / Clickable Area */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center justify-between p-3 hover:bg-purple-500/10 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="p-1.5 rounded-md bg-purple-500/20 text-purple-400">
              <Brain size={16} />
            </div>
            <span className="text-sm font-medium text-gray-200">
              {compactedCount} older messages compressed
            </span>
            <Sparkles size={14} className="text-purple-400/70" />
          </div>
          
          <div className="text-gray-400">
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </button>

        {/* Expanded Summary Content */}
        {isExpanded && (
          <div className="p-4 border-t border-purple-500/20 bg-black/20">
            <div className="text-xs font-semibold text-purple-400 mb-2 uppercase tracking-wider">
              Retained Context
            </div>
            <div className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
              {displaySummary}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
