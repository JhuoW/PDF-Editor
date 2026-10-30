import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';

/** Disclosure menus retain native button semantics and own their navigation keys. */
export function useToolbarMenus(host: RefObject<HTMLDivElement | null>, open: string | null, close: () => void) {
  const pendingFocus = useRef<{ name: string; last: boolean } | null>(null), previous = useRef<string | null>(null);
  const origin = useRef<HTMLButtonElement | null>(null);
  const menuFor = (name: string) => host.current?.querySelector<HTMLElement>(`[data-toolbar-menu="${name}"]`);
  const triggerFor = (name: string) => origin.current?.isConnected && origin.current.dataset.toolbarMenuTrigger === name ? origin.current : host.current?.querySelector<HTMLButtonElement>(`[data-toolbar-menu-trigger="${name}"]`);
  useLayoutEffect(() => {
    const old = previous.current; previous.current = open;
    if (!open) {
      pendingFocus.current = null;
      if (old && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) {
        host.current?.querySelector<HTMLButtonElement>(`[data-toolbar-menu-trigger="${old}"]`)?.focus();
      }
      return;
    }
    const menu = host.current?.querySelector<HTMLElement>(`[data-toolbar-menu="${open}"]`);
    const trigger = origin.current?.isConnected && origin.current.dataset.toolbarMenuTrigger === open ? origin.current : host.current?.querySelector<HTMLButtonElement>(`[data-toolbar-menu-trigger="${open}"]`);
    if (!menu || !trigger) return;
    const position = () => {
      const bounds = trigger.getBoundingClientRect(), top = Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - 80));
      menu.style.setProperty('--toolbar-menu-top', `${top}px`);
      const width = menu.getBoundingClientRect().width;
      menu.style.setProperty('--toolbar-menu-left', `${Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))}px`);
    };
    position();
    if (pendingFocus.current?.name === open) {
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      (pendingFocus.current.last ? items.at(-1) : items[0])?.focus(); pendingFocus.current = null;
    }
    const onScroll = (event: Event) => { if (!menu.contains(event.target as Node)) position(); };
    window.addEventListener('resize', position); document.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', position); document.removeEventListener('scroll', onScroll, true); };
  }, [host, open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement)) return;
    const trigger = event.target.closest<HTMLButtonElement>('[data-toolbar-menu-trigger]'), name = trigger?.dataset.toolbarMenuTrigger;
    if (trigger && name && ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.stopPropagation(); pendingFocus.current = { name, last: event.key === 'ArrowUp' };
      if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        if (open !== name) trigger.click();
        else {
          const items = Array.from(menuFor(name)?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
          (event.key === 'ArrowUp' ? items.at(-1) : items[0])?.focus(); pendingFocus.current = null;
        }
      }
      return;
    }
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); triggerFor(open)?.focus(); return; }
    const menu = menuFor(open);
    if (!menu?.contains(event.target) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = items.indexOf(event.target as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  const onBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    if (!open || !(event.relatedTarget instanceof Node)) return;
    if (!menuFor(open)?.contains(event.relatedTarget) && !triggerFor(open)?.contains(event.relatedTarget)) close();
  };
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element) {
      const trigger = event.target.closest<HTMLButtonElement>('[data-toolbar-menu-trigger]');
      if (trigger) origin.current = trigger;
    }
  };
  return { onKeyDown, onBlurCapture, onClickCapture };
}
