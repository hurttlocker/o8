import { useCallback, useRef, type KeyboardEvent, type RefObject } from 'react';

/** Keyboard access for the Project target menu's body portal. */
export function useRepoTargetMenu(
  setOpen: (open: boolean) => void,
  buttonRef: RefObject<HTMLButtonElement | null>,
) {
  const menuRef = useRef<HTMLDivElement>(null);
  const focusMenu = useCallback(() => {
    const menu = menuRef.current;
    const option = menu?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      ?? menu?.querySelector<HTMLButtonElement>('[role="option"]');
    option?.focus();
  }, []);

  const closeMenu = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setOpen(true);
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else if (event.key === 'Tab') {
      if ((event.shiftKey && index === 0) || (!event.shiftKey && index === options.length - 1)) {
        event.preventDefault();
        closeMenu();
      }
      return;
    } else return;
    event.preventDefault();
    options[next]?.focus();
  };

  return { menuRef, focusMenu, closeMenu, onTriggerKeyDown, onMenuKeyDown };
}
