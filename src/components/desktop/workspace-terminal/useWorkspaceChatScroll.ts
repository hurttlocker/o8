import { useCallback, useRef, useState } from 'react';

export function useWorkspaceChatScroll() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const scrollToBottom = useCallback((force = false) => {
    if (!scrollRef.current || (!force && !stickToBottomRef.current)) return;
    setShowScrollToBottom(false);
    requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });
  }, []);
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const node = scrollRef.current;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottomRef.current = distance < 80;
    setShowScrollToBottom(distance >= 80);
  }, []);
  return { scrollRef, stickToBottomRef, showScrollToBottom, setShowScrollToBottom, scrollToBottom, handleScroll };
}
