import { useCallback, useEffect, useLayoutEffect, useRef, useState, type WheelEvent } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Film,
  Home,
  Image as ImageIcon,
  Library,
  ListOrdered,
  Settings,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { IconButton } from '../components/ui/IconButton';
import type { Tab, TabKind } from './tabs';

export const TAB_ICONS: Record<TabKind, LucideIcon> = {
  home: Home,
  library: Library,
  guides: ListOrdered,
  settings: Settings,
  shot: ImageIcon,
  video: Film,
  flow: ListOrdered,
};

export interface TabStripProps {
  tabs: Tab[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (id: string, toIndex: number) => void;
}

/** How far the chevrons scroll the list. */
const SCROLL_STEP = 240;
const FADE = 24;

/**
 * The strip of tabs under the title bar: the pinned Home tab, then one tab per open screenshot,
 * video or step guide. Tabs scroll sideways when they do not fit (a fade and chevrons say so),
 * close with ×, a middle click or Ctrl+W, and drag to reorder. A plain list of buttons (the open
 * one is `aria-current`): a tab with its own close button is not a valid ARIA tab.
 */
export function TabStrip({ tabs, activeId, onActivate, onClose, onMove }: TabStripProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const pinned = tabs.filter((tab) => tab.pinned);
  const rest = tabs.filter((tab) => !tab.pinned);

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const left = list.scrollLeft > 1;
    const right = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
    setOverflow((current) =>
      current.left === left && current.right === right ? current : { left, right },
    );
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [measure, rest.length]);

  // The shown tab is always in view, however many are open.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [activeId, rest.length]);

  const onWheel = (event: WheelEvent<HTMLUListElement>): void => {
    const list = listRef.current;
    if (list && event.deltaY !== 0 && event.deltaX === 0) list.scrollLeft += event.deltaY;
  };
  const scrollBy = (delta: number): void =>
    listRef.current?.scrollBy?.({ left: delta, behavior: 'smooth' });

  // The fade only shows on the side that has more tabs.
  const mask =
    overflow.left || overflow.right
      ? `linear-gradient(to right, ${overflow.left ? 'transparent' : '#000'} 0, #000 ${FADE}px, #000 calc(100% - ${FADE}px), ${overflow.right ? 'transparent' : '#000'} 100%)`
      : undefined;

  return (
    <nav
      aria-label="Open items"
      data-testid="tab-strip"
      className="flex h-9 shrink-0 items-stretch border-b border-line bg-surface-2"
    >
      {pinned.map((tab) => {
        const Icon = TAB_ICONS[tab.kind];
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            data-testid="home-tab"
            data-tab-id={tab.id}
            data-kind={tab.kind}
            data-active={active}
            aria-current={active ? 'true' : undefined}
            onClick={() => onActivate(tab.id)}
            className={cn(
              'relative flex shrink-0 items-center gap-2 border-r border-line px-3.5 text-[13px] font-medium transition-colors duration-150',
              active ? 'bg-bg text-fg' : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
            )}
          >
            {active ? (
              <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-accent-solid" />
            ) : null}
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span data-testid="home-tab-label">{tab.title}</span>
          </button>
        );
      })}
      {overflow.left ? (
        <IconButton
          size="sm"
          aria-label="Scroll tabs left"
          data-testid="tabs-scroll-left"
          className="my-auto size-7 rounded-md"
          icon={<ChevronLeft className="size-4" />}
          onClick={() => scrollBy(-SCROLL_STEP)}
        />
      ) : null}
      <ul
        ref={listRef}
        data-testid="editor-tabs"
        onWheel={onWheel}
        onScroll={measure}
        style={{ maskImage: mask, WebkitMaskImage: mask }}
        className="flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none]"
      >
        {rest.map((tab) => {
          const active = tab.id === activeId;
          const Icon = TAB_ICONS[tab.kind];
          const index = tabs.indexOf(tab);
          return (
            <li
              key={tab.id}
              data-tab-id={tab.id}
              data-testid="editor-tab"
              data-kind={tab.kind}
              data-active={active}
              data-dirty={tab.dirty}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', tab.id);
                setDragging(tab.id);
              }}
              onDragOver={(event) => {
                if (dragging && dragging !== tab.id) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging && dragging !== tab.id) onMove(dragging, index);
                setDragging(null);
              }}
              onDragEnd={() => setDragging(null)}
              onMouseDown={(event) => {
                // A middle click must not start the browser's auto-scroll.
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(tab.id);
              }}
              className={cn(
                'group/tab relative flex w-44 min-w-28 shrink-0 items-center border-r border-line text-[13px] transition-colors duration-150',
                active ? 'bg-bg text-fg' : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
                dragging === tab.id && 'opacity-50',
              )}
            >
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-0.5 bg-accent-solid"
                />
              ) : null}
              <button
                type="button"
                id={`tab-${tab.id}`}
                aria-current={active ? 'true' : undefined}
                title={tab.title}
                onClick={() => onActivate(tab.id)}
                className="flex h-full min-w-0 flex-1 items-center gap-2 pr-1 pl-3 text-left"
              >
                <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate" data-testid="tab-title">
                  {tab.title}
                </span>
                {tab.dirty ? (
                  <>
                    <span
                      aria-hidden="true"
                      data-testid="tab-dirty"
                      className="size-2 shrink-0 rounded-full bg-accent-solid"
                    />
                    <span className="sr-only">, unsaved changes</span>
                  </>
                ) : null}
              </button>
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                data-testid="tab-close"
                onClick={() => onClose(tab.id)}
                className={cn(
                  'mr-1.5 flex size-5 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg',
                  !active &&
                    'opacity-60 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100',
                )}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      {overflow.right ? (
        <IconButton
          size="sm"
          aria-label="Scroll tabs right"
          data-testid="tabs-scroll-right"
          className="my-auto size-7 rounded-md"
          icon={<ChevronRight className="size-4" />}
          onClick={() => scrollBy(SCROLL_STEP)}
        />
      ) : null}
    </nav>
  );
}
