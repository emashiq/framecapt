import { useEffect, useRef, useState, type WheelEvent } from 'react';
import { Film, Image as ImageIcon, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Logo } from '../components/Logo';
import type { Tab } from './tabs';

export interface TabStripProps {
  tabs: Tab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (id: string, toIndex: number) => void;
}

/**
 * The Editor window's title bar: the logo and one tab per open screenshot or video. The bar is the
 * window's drag region (the tabs opt out); the OS draws only the window buttons at the right end
 * (`.title-bar-area` keeps the content clear of them). Tabs scroll sideways when they do not fit,
 * close with ×, a middle click or Ctrl+W, and drag to reorder. A plain list of buttons (the open
 * one is `aria-current`): a tab with its own close button is not a valid ARIA tab.
 */
export function TabStrip({ tabs, activeId, onActivate, onClose, onMove }: TabStripProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // The shown tab is always in view, however many are open.
  useEffect(() => {
    if (!activeId) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`)
      ?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [activeId, tabs.length]);

  const onWheel = (event: WheelEvent<HTMLUListElement>): void => {
    const list = listRef.current;
    if (list && event.deltaY !== 0 && event.deltaX === 0) list.scrollLeft += event.deltaY;
  };

  return (
    <header
      data-testid="title-bar"
      className="title-bar flex shrink-0 items-stretch border-b border-line bg-surface-2"
    >
      <div className="title-bar-area flex min-w-0 items-center gap-2 px-3">
        <Logo size={20} />
        <nav aria-label="Open items" className="flex min-w-0">
          <ul
            ref={listRef}
            data-testid="editor-tabs"
            onWheel={onWheel}
            className="no-drag flex min-w-0 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none]"
          >
            {tabs.map((tab, index) => {
              const active = tab.id === activeId;
              const Icon = tab.kind === 'video' ? Film : ImageIcon;
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
                    'flex h-7 w-44 min-w-28 shrink-0 items-center rounded-md border text-[13px] transition-colors duration-150',
                    active
                      ? 'border-line bg-surface text-fg shadow-card'
                      : 'border-transparent text-fg-muted hover:bg-surface-3 hover:text-fg',
                    dragging === tab.id && 'opacity-50',
                  )}
                >
                  <button
                    type="button"
                    id={`tab-${tab.id}`}
                    aria-current={active ? 'true' : undefined}
                    title={tab.title}
                    onClick={() => onActivate(tab.id)}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pr-1 pl-2 text-left"
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
                    className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </header>
  );
}
