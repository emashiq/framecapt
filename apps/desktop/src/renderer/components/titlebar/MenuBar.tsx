import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Menu as MenuIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { hintFor, MENUS, type Command } from '../../commands/registry';
import type { Settings } from '../../../shared/settings';

type Entry =
  { kind: 'item'; command: Command } | { kind: 'separator' } | { kind: 'heading'; label: string };

interface BarMenu {
  id: string;
  label: string;
  entries: Entry[];
}

function entriesOf(items: readonly (string | null)[], byId: Map<string, Command>): Entry[] {
  const entries: Entry[] = [];
  for (const id of items) {
    if (id === null) {
      entries.push({ kind: 'separator' });
      continue;
    }
    const command = byId.get(id);
    if (command) entries.push({ kind: 'item', command });
  }
  return entries;
}

/** File, View and Help; or, in a narrow window, one "Menu" button that holds all three. */
function barMenus(commands: readonly Command[], collapsed: boolean): BarMenu[] {
  const byId = new Map(commands.map((command) => [command.id, command]));
  const menus = MENUS.map((menu) => ({
    id: menu.id,
    label: menu.label,
    entries: entriesOf(menu.items, byId),
  }));
  if (!collapsed) return menus;
  // One list holds all three menus: a command that is in two of them (History) shows once.
  const seen = new Set<string>();
  for (const menu of menus) {
    menu.entries = menu.entries.filter((entry) => {
      if (entry.kind !== 'item') return true;
      if (seen.has(entry.command.id)) return false;
      seen.add(entry.command.id);
      return true;
    });
  }
  return [
    {
      id: 'all',
      label: 'Menu',
      entries: menus.flatMap((menu, index): Entry[] => [
        ...(index > 0 ? [{ kind: 'separator' } as const] : []),
        { kind: 'heading', label: menu.label },
        ...menu.entries,
      ]),
    },
  ];
}

export interface MenuBarProps {
  commands: readonly Command[];
  settings: Pick<Settings, 'shortcuts' | 'editorShortcuts'>;
  collapsed: boolean;
  /** Runs a command the user chose (the menu is already closed). */
  onRun: (command: Command) => void;
}

const BAR_BUTTON =
  'no-drag flex h-7 items-center rounded-md px-2.5 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-surface-3 hover:text-fg aria-expanded:bg-surface-3 aria-expanded:text-fg';

/**
 * The menu bar of the title bar (WAI-ARIA menubar): arrow keys move between menus and items, Enter
 * or Space chooses, Esc closes and gives the focus back to the menu's button. An unavailable item
 * stays in the menu, announced as disabled with the reason as its tooltip and description.
 */
export function MenuBar({ commands, settings, collapsed, onRun }: MenuBarProps) {
  const menus = barMenus(commands, collapsed);
  const [open, setOpen] = useState<number | null>(null);
  const [barIndex, setBarIndex] = useState(0);
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  const [focusAt, setFocusAt] = useState<'first' | 'last' | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const menu = open === null ? null : (menus[open] ?? null);

  function openMenu(index: number, at: 'first' | 'last' | null = null): void {
    const rect = buttons.current[index]?.getBoundingClientRect();
    if (rect) setAnchor({ left: rect.left, top: rect.bottom });
    setBarIndex(index);
    setFocusAt(at);
    setOpen(index);
  }

  function closeMenu(refocus: boolean): void {
    if (open === null) return;
    const index = open;
    setOpen(null);
    if (refocus) buttons.current[index]?.focus();
  }

  const items = (): HTMLElement[] =>
    Array.from(popupRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  // Keyboard opening puts the focus on an item; a mouse opening leaves it on the button.
  useLayoutEffect(() => {
    if (open === null || focusAt === null) return;
    const all = items();
    (focusAt === 'first' ? all[0] : all.at(-1))?.focus();
  }, [open, focusAt]);

  // A click anywhere else closes the menu.
  useEffect(() => {
    if (open === null) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (popupRef.current?.contains(target) || barRef.current?.contains(target)) return;
      setOpen(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  function onBarKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const move = (to: number): void => {
      event.preventDefault();
      const next = (to + menus.length) % menus.length;
      setBarIndex(next);
      if (open !== null) openMenu(next, 'first');
      else buttons.current[next]?.focus();
    };
    switch (event.key) {
      case 'ArrowRight':
        return move(index + 1);
      case 'ArrowLeft':
        return move(index - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(menus.length - 1);
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        event.preventDefault();
        return openMenu(index, 'first');
      case 'ArrowUp':
        event.preventDefault();
        return openMenu(index, 'last');
      case 'Escape':
        return closeMenu(true);
    }
  }

  function onPopupKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const focus = (to: number): void => {
      event.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        return focus(at + 1);
      case 'ArrowUp':
        return focus(at < 0 ? all.length - 1 : at - 1);
      case 'Home':
        return focus(0);
      case 'End':
        return focus(all.length - 1);
      case 'ArrowRight':
      case 'ArrowLeft':
        if (menus.length > 1 && open !== null) {
          event.preventDefault();
          openMenu(
            (open + (event.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length,
            'first',
          );
        }
        return;
      case 'Escape':
        event.preventDefault();
        return closeMenu(true);
      case 'Tab':
        return closeMenu(false);
    }
  }

  function choose(command: Command): void {
    if (command.disabledReason) return;
    closeMenu(true);
    onRun(command);
  }

  return (
    <>
      <div
        ref={barRef}
        role="menubar"
        aria-label="Application menu"
        data-testid="menubar"
        className="no-drag flex items-center"
      >
        {menus.map((entry, index) => (
          <button
            key={entry.id}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === index}
            aria-label={collapsed ? 'Menu' : undefined}
            tabIndex={Math.min(barIndex, menus.length - 1) === index ? 0 : -1}
            data-testid={`menubar-${entry.id}`}
            className={cn(BAR_BUTTON, collapsed && 'w-8 justify-center px-0')}
            onClick={() => (open === index ? closeMenu(false) : openMenu(index))}
            onMouseEnter={() => open !== null && open !== index && openMenu(index)}
            onFocus={() => setBarIndex(index)}
            onKeyDown={(event) => onBarKeyDown(event, index)}
          >
            {collapsed ? <MenuIcon className="size-4" aria-hidden="true" /> : entry.label}
          </button>
        ))}
      </div>
      {menu
        ? createPortal(
            <div
              ref={popupRef}
              role="menu"
              aria-label={menu.label}
              data-testid="menu-popup"
              data-menu={menu.id}
              style={{ left: anchor.left, top: anchor.top }}
              className="no-drag fixed z-50 min-w-64 max-w-[calc(100vw-16px)] rounded-xl border border-line bg-surface p-1.5 text-sm text-fg shadow-raised"
              onKeyDown={onPopupKeyDown}
            >
              {menu.entries.map((entry, index) => {
                if (entry.kind === 'separator') {
                  return <div key={index} role="separator" className="my-1 h-px bg-line" />;
                }
                if (entry.kind === 'heading') {
                  return (
                    <div
                      key={index}
                      role="presentation"
                      className="px-2.5 pt-1 pb-0.5 text-xs font-semibold tracking-wide text-fg-muted uppercase"
                    >
                      {entry.label}
                    </div>
                  );
                }
                const { command } = entry;
                const keys = hintFor(command, settings);
                const reason = command.disabledReason;
                return (
                  <div
                    key={command.id}
                    role="menuitem"
                    tabIndex={-1}
                    aria-disabled={reason ? true : undefined}
                    aria-describedby={reason ? `menu-reason-${command.id}` : undefined}
                    title={reason ?? undefined}
                    data-testid={`menu-item-${command.id}`}
                    className={cn(
                      'flex cursor-default items-center gap-6 rounded-lg px-2.5 py-1.5 outline-none focus:bg-accent-soft focus:text-accent-fg',
                      reason && 'text-fg-muted',
                    )}
                    onClick={() => choose(command)}
                    onMouseMove={(event) => event.currentTarget.focus({ preventScroll: true })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        choose(command);
                      }
                    }}
                  >
                    <span className="flex-1">{command.menuLabel ?? command.title}</span>
                    {Array.isArray(keys) ? (
                      <span className="text-xs text-fg-muted">{keys.join('+')}</span>
                    ) : null}
                    {reason ? (
                      <span id={`menu-reason-${command.id}`} className="sr-only">
                        Unavailable: {reason}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
